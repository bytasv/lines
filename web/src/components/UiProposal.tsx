import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconArrowsMaximize,
  IconCheck,
  IconCircleCheck,
  IconLayoutDashboard,
  IconMessage,
  IconHistory,
} from '@tabler/icons-react';
import {
  isSessionInterruptible,
  PROPOSE_UI_TOOL,
  type PermissionRequestData,
  type TranscriptEvent,
} from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { useCan } from '../lib/can';
import { useIsPhone } from '../lib/layout';
import { readAppTokens, withAppTokens } from '../lib/appTokens';
import { appendTranscript, useVoiceDictation, type VoiceDictation } from '../lib/useVoiceDictation';
import { TranscriptAnchorContext } from '../lib/transcriptAnchor';
import {
  pickedProposals,
  proposalOutcome,
  type PickedProposal,
  type ProposalOutcome,
  type ToolBlock,
  type UiProposalInput,
  type UiProposalVersion,
} from '../lib/transcript';
import { HtmlFrame } from './HtmlFrame';
import { DictateButton, DictationError, dictateSectionWidth } from './DictateButton';

type ViewMode = 'focus' | 'compare';

/** Inline frame heights: clamped to this range, and the fallback until a page reports its own. */
const FRAME_MIN = 96;
const FRAME_MAX = 900;
const FRAME_FALLBACK = 360;

const clampHeight = (h: number) => Math.min(FRAME_MAX, Math.max(FRAME_MIN, Math.ceil(h)));

// Per-card state, keyed by tool_use id. Module scope, like ToolCallCard's sticky
// expansion, so it survives the card remounting (a session switch, a theme
// toggle). The heights are what let a remounted card come back at its settled
// size instead of growing from the fallback under the reader.
const activeLabel = new Map<string, string>();
const viewModes = new Map<string, ViewMode>();
const acceptedLabel = new Map<string, string>();
const contentHeights = new Map<string, Record<string, number>>();
/** The request each card answered, so a click cannot be sent twice. */
const answeredRequest = new Map<string, string>();
/** What that answer was, for the footer's in-flight state. */
const answeredAction = new Map<string, AnswerAction>();
/** The revision picked per version label, when not the latest. */
const revisionPicks = new Map<string, Record<string, number>>();
/** Superseded cards the user opened back up. */
const expandedSuperseded = new Set<string>();

type AnswerAction = 'choice' | 'feedback' | 'dismiss';
/** The view the last card was switched to — where a new card opens. */
let preferredMode: ViewMode = 'focus';

/**
 * The open `propose_ui` card's request id, scanning back from the newest event.
 * At most one can be open — the call blocks the turn — so the first proposal
 * request found decides: unresolved means open, resolved means none is.
 */
function openProposalRequest(events: TranscriptEvent[] | undefined): string | null {
  if (!events) return null;
  // Per events array: every store change re-runs the selector, and a call that
  // never got its result (answered through recovery) would rescan each time.
  const cached = openRequestCache.get(events);
  if (cached !== undefined) return cached;
  const found = scanOpenProposalRequest(events);
  openRequestCache.set(events, found);
  return found;
}

const openRequestCache = new WeakMap<TranscriptEvent[], string | null>();

function scanOpenProposalRequest(events: TranscriptEvent[]): string | null {
  const resolved = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'permission') continue;
    const d = e.data as PermissionRequestData;
    if (d.resolution) resolved.add(d.requestId);
    else if (d.toolName === PROPOSE_UI_TOOL) return resolved.has(d.requestId) ? null : d.requestId;
  }
  return null;
}

/**
 * A SegmentedControl entry for one version: ticked once it is the chosen one,
 * dotted when this revision just changed it.
 */
function tabLabel(label: string, chosen: string | null, revised: boolean): ReactNode {
  if (label !== chosen && !revised) return label;
  return (
    <Group gap={4} wrap="nowrap" justify="center">
      {label === chosen ? (
        <IconCheck size={12} />
      ) : (
        <Box
          title="Updated"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--mantine-color-teal-6)',
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </Group>
  );
}

/**
 * A `propose_ui` call as the user sees it: the agent's mocks rendered with the
 * app's design tokens injected, in one of two views —
 *
 *  - **Focus:** one version at a time, picked by the tabs. Every version's frame
 *    stays mounted, stacked in one grid cell with the inactive ones hidden, so
 *    switching is instant and the card never changes height (the cell is as tall
 *    as the tallest version, and the frames share that height). Notes stack the
 *    same way. That is what keeps the transcript still while the user flips
 *    between versions.
 *  - **Compare:** the same frames one under another, each at its own height,
 *    to scroll through. The section header selects a version.
 *
 * Switching views keeps the header where it is on screen (TranscriptAnchorContext).
 * The frames keep their identity across both views — only styles change — so a
 * switch never reloads a page.
 *
 * Rendered the same pending or settled, so nothing remounts when the result
 * lands. How the user answers depends on the path:
 *  - **Claude:** the call is always-ask and waits on a permission card. That card
 *    renders nothing of its own (ProposalPermission); its controls are this
 *    card's footer: choose the selected version (with an optional note), ask for
 *    changes, or dismiss. The answer is the tool's result, so this works mid-plan.
 *    Gated on `approvePermissions`, like any card.
 *  - **Codex:** no card, the result is "Shown …" at once. Accept then sends a
 *    prompt (queued while a turn runs), gated on `prompt`.
 *
 * The transcript is only ever rendered for the selected session (SessionView),
 * which is the one this card belongs to.
 */
export function UiProposal({ tool, proposal }: { tool: ToolBlock; proposal: UiProposalInput }) {
  const scheme = useComputedColorScheme('dark');
  const isPhone = useIsPhone();
  const canPrompt = useCan('prompt');
  const canAnswer = useCan('approvePermissions');
  const keepInView = useContext(TranscriptAnchorContext);
  const sessionId = useStore((s) => s.selectedSessionId);
  const running = useStore((s) =>
    s.selectedSessionId ? isSessionInterruptible(s.sessions[s.selectedSessionId]?.status ?? 'idle') : false,
  );
  // Looked for only while the call is unsettled, so a settled card never scans.
  const requestId = useStore((s) =>
    tool.result === undefined && s.selectedSessionId
      ? openProposalRequest(s.transcripts[s.selectedSessionId])
      : null,
  );

  const outcome = proposalOutcome(tool.result, tool.isError);
  const chosen = outcome?.kind === 'picked' ? outcome.label : null;
  // A revision shows the merged set (buildTranscript), not just the versions it sent.
  const thread = tool.proposal;
  const latest = thread?.versions ?? proposal.versions;
  const history = thread?.history;
  // Which revision of each version is on screen: the latest unless the user
  // went back to an earlier one (index into its history, oldest first).
  const [revPick, setRevPick] = useState<Record<string, number>>(() => revisionPicks.get(tool.id) ?? {});
  const revisionsOf = (l: string) => history?.[l] ?? [];
  const revIndex = (l: string) => {
    const n = revisionsOf(l).length;
    const picked = revPick[l];
    return picked !== undefined && picked < n ? picked : Math.max(0, n - 1);
  };
  const isLatest = (l: string) => revIndex(l) >= revisionsOf(l).length - 1;
  const versions = useMemo(
    () =>
      latest.map((v) => {
        const revs = history?.[v.label];
        if (!revs || revs.length < 2) return v;
        const picked = revPick[v.label];
        const at = picked !== undefined && picked < revs.length ? picked : revs.length - 1;
        return { ...revs[at], label: v.label };
      }),
    [latest, history, revPick],
  );
  const pickRevision = (l: string, index: number) => {
    setRevPick((prev) => {
      const next = { ...prev, [l]: index };
      revisionPicks.set(tool.id, next);
      return next;
    });
  };
  // Heights and frames are per revision: switching one swaps the page.
  const hk = (l: string) => `${l}#${revIndex(l)}`;
  const revisedLabels = thread?.revised ?? [];
  const superseded = thread?.supersededBy !== undefined;
  const labels = versions.map((v) => v.label);
  const multi = versions.length > 1;

  const [label, setLabel] = useState(() => {
    // A revision opens on what it changed.
    const kept = activeLabel.get(tool.id) ?? chosen ?? revisedLabels[0];
    return kept && labels.includes(kept) ? kept : labels[0];
  });
  const [mode, setMode] = useState<ViewMode>(() => viewModes.get(tool.id) ?? preferredMode);
  const view: ViewMode = multi ? mode : 'focus';
  const [heights, setHeights] = useState<Record<string, number>>(() => contentHeights.get(tool.id) ?? {});
  const [large, setLarge] = useState(false);
  // The large view's own Focus/Compare, opened in whatever the card shows.
  const [largeView, setLargeView] = useState<ViewMode>('focus');
  const [largeHeights, setLargeHeights] = useState<Record<string, number>>({});
  const [reply, setReply] = useState('');
  // One mic for the note, shared by the card's footer and the large view's.
  const canDictate = useCan('prompt');
  const dictation = useVoiceDictation(sessionId ?? '', (text) => setReply((prev) => appendTranscript(prev, text)));
  const [answered, setAnswered] = useState<string | null>(() => answeredRequest.get(tool.id) ?? null);
  const [action, setAction] = useState<AnswerAction | null>(() => answeredAction.get(tool.id) ?? null);
  const [showSuperseded, setShowSuperseded] = useState(() => expandedSuperseded.has(tool.id));
  const [accepted, setAccepted] = useState(() => acceptedLabel.get(tool.id) ?? null);

  const version = versions.find((v) => v.label === label) ?? versions[0];

  // Re-read on a scheme change: the computed token values are what differ.
  const tokens = useMemo(() => readAppTokens(), [scheme]);
  const pages = useMemo(
    () => new Map(versions.map((v) => [v.label, withAppTokens(v.html, tokens)] as const)),
    [versions, tokens],
  );

  // Focus: every frame at the tallest known height, so the cell never resizes
  // as the tabs change. Unknown heights are left out once any is known.
  const known = labels.map((l) => heights[hk(l)]).filter((h): h is number => h !== undefined);
  const focusHeight = clampHeight(known.length ? Math.max(...known) : FRAME_FALLBACK);
  const frameHeight = (l: string) =>
    view === 'focus' ? focusHeight : clampHeight(heights[hk(l)] ?? FRAME_FALLBACK);

  const onContentHeight = (l: string) => (h: number) => {
    const next = Math.ceil(h);
    const key = hk(l);
    setHeights((prev) => {
      if (prev[key] === next) return prev;
      const updated = { ...prev, [key]: next };
      contentHeights.set(tool.id, updated);
      return updated;
    });
  };

  const select = (next: string) => {
    activeLabel.set(tool.id, next);
    setLabel(next);
  };

  // Hold the header still on screen across a view switch: the card's height
  // changes a lot, and the transcript would otherwise follow its bottom.
  const headerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<(() => void) | null>(null);
  const switchView = (next: ViewMode) => {
    if (next === mode) return;
    restoreRef.current = headerRef.current && keepInView ? keepInView(headerRef.current) : null;
    viewModes.set(tool.id, next);
    preferredMode = next;
    setMode(next);
  };
  useLayoutEffect(() => {
    restoreRef.current?.();
    restoreRef.current = null;
  }, [mode]);

  const answer = (allow: boolean, answers?: Record<string, string>) => {
    if (!sessionId || !requestId || answered === requestId) return;
    const kind: AnswerAction = !allow ? 'dismiss' : answers?.feedback ? 'feedback' : 'choice';
    answeredRequest.set(tool.id, requestId);
    answeredAction.set(tool.id, kind);
    setAnswered(requestId);
    setAction(kind);
    if (dictation.voice !== 'idle') dictation.cancel();
    send({ type: 'permissionResponse', sessionId, requestId, allow, ...(answers ? { answers } : {}) });
    setLarge(false);
  };

  const accept = () => {
    if (!sessionId) return;
    send({
      type: 'prompt',
      sessionId,
      text:
        `Accept version "${version.label}" of the UI proposal "${proposal.title}". ` +
        'Implement it in the codebase to match.',
      attachments: [],
      // While a turn runs, hold it for after rather than steering into that turn.
      queue: running || undefined,
    });
    acceptedLabel.set(tool.id, version.label);
    setAccepted(version.label);
  };

  const openLarge = () => {
    setLargeView(view);
    setLarge(true);
  };

  const pending = requestId !== null;
  // An earlier revision on screen is what Choose/Change act on, and they say so.
  const activeRevisions = revisionsOf(version.label).length;
  const onEarlier = activeRevisions > 1 && !isLatest(version.label);
  const revisionAnswer: Record<string, string> = onEarlier ? { revision: String(revIndex(version.label) + 1) } : {};
  const buttonLabel = onEarlier ? `${version.label} v${revIndex(version.label) + 1}` : version.label;
  // The version being regenerated after "Change X": shown on the card until the
  // revision replaces it, or the turn ends without one.
  const updating =
    !superseded && running && (outcome ? outcome.kind === 'feedback' : action === 'feedback' && !pending)
      ? (outcome?.kind === 'feedback' ? outcome.version : undefined) ?? version.label
      : null;
  // Built once and placed twice (the card and the large view), sharing the reply.
  const footer = proposalFooter({
    outcome,
    pending,
    canAnswer,
    sending: pending && answered === requestId ? action : null,
    updating,
    awaitingResult: !pending && tool.result === undefined && answered !== null,
    label: buttonLabel,
    reply,
    onReply: setReply,
    dictation: canDictate && sessionId ? dictation : undefined,
    onChoose: (note) => answer(true, { choice: version.label, ...(note ? { note } : {}), ...revisionAnswer }),
    // Names the selected version, so the changes land on the one being looked at.
    onFeedback: (text) => answer(true, { feedback: text, version: version.label, ...revisionAnswer }),
    onDismiss: () => answer(false),
    accept:
      outcome?.kind === 'shown' && canPrompt ? { accepted, onAccept: accept, disabled: !sessionId } : undefined,
  });

  const revisionNote =
    thread && thread.revision > 1 ? ` · revision ${thread.revision}, ${revisedLabels.join(', ')} updated` : '';
  const subtitle =
    (pending
      ? multi
        ? `${versions.length} versions — pick one`
        : 'Waiting for your answer'
      : chosen
        ? `You chose ${chosen}`
        : `${versions.length} version${multi ? 's' : ''}`) + revisionNote;

  const tabs = (fullWidth: boolean) => (
    <SegmentedControl
      size="xs"
      fullWidth={fullWidth}
      value={version.label}
      onChange={select}
      data={labels.map((l) => ({ value: l, label: tabLabel(l, chosen, revisedLabels.includes(l)) }))}
    />
  );

  const revisionControl = (l: string) =>
    revisionsOf(l).length > 1 ? (
      <RevisionSwitch count={revisionsOf(l).length} value={revIndex(l)} onChange={(i) => pickRevision(l, i)} />
    ) : null;

  const frameBox: CSSProperties = {
    border: '1px solid var(--mantine-color-default-border)',
    borderRadius: 'var(--mantine-radius-md)',
    overflow: 'hidden',
  };

  // Replaced in place by a later revision: the set lives on in that card, so
  // this one folds to a line (and stays openable as history).
  if (superseded && !showSuperseded) {
    return (
      <Paper withBorder radius="md" px="sm" py={6}>
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconLayoutDashboard size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
            <Text size="xs" c="dimmed" lineClamp={1}>
              {proposal.title}
              {outcome?.kind === 'feedback' && outcome.version ? ` — ${outcome.version} revised below` : ' — revised below'}
            </Text>
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              expandedSuperseded.add(tool.id);
              setShowSuperseded(true);
            }}
          >
            Show
          </Button>
        </Group>
      </Paper>
    );
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      style={pending ? { borderColor: 'var(--mantine-primary-color-filled)' } : undefined}
    >
      <Stack gap="sm">
        <Group ref={headerRef} gap="xs" justify="space-between" wrap="nowrap" align="center">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" radius="md" size="md" style={{ flexShrink: 0 }}>
              <IconLayoutDashboard size={16} />
            </ThemeIcon>
            <Box style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} lineClamp={1} title={proposal.title}>
                {proposal.title}
              </Text>
              <Text size="xs" c="dimmed" lineClamp={1}>
                {subtitle}
              </Text>
            </Box>
          </Group>
          <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
            {multi && viewToggle(view, switchView)}
            <Tooltip label="Open large">
              <ActionIcon variant="subtle" color="gray" aria-label="Open large" onClick={openLarge}>
                <IconArrowsMaximize size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {view === 'focus' && (multi || activeRevisions > 1) && (
          <Group gap="xs" justify="space-between" wrap="wrap">
            {multi ? tabs(isPhone && activeRevisions < 2) : <span />}
            {revisionControl(version.label)}
          </Group>
        )}
        {view === 'focus' && <StackedNotes versions={versions} active={version.label} />}

        {/* One element tree for both views: switching changes styles only, so no
            frame is unmounted, moved or reloaded. */}
        <Box
          style={
            view === 'focus'
              ? { display: 'grid' }
              : { display: 'flex', flexDirection: 'column', gap: 'var(--mantine-spacing-md)' }
          }
        >
          {versions.map((v) => {
            const active = v.label === version.label;
            return (
              <Box
                key={v.label}
                aria-hidden={view === 'focus' && !active ? true : undefined}
                style={
                  view === 'focus'
                    ? { gridArea: '1 / 1', minWidth: 0, visibility: active ? 'visible' : 'hidden' }
                    : { minWidth: 0 }
                }
              >
                {view === 'compare' ? (
                  <CompareHeader
                    version={v}
                    active={active}
                    chosen={v.label === chosen}
                    onSelect={() => select(v.label)}
                    extra={revisionControl(v.label)}
                  />
                ) : null}
                {/* The border sits on a wrapper so the frame itself is exactly the
                    page's height: inside it, the border would cost the page two
                    pixels and a scrollbar. The selection is a ring, not a border,
                    so selecting never changes a height either. */}
                <Box
                  style={{
                    ...frameBox,
                    ...(view === 'compare' && active && multi
                      ? { boxShadow: '0 0 0 2px var(--mantine-primary-color-filled)' }
                      : {}),
                  }}
                >
                  <HtmlFrame
                    key={`${v.label}:${revIndex(v.label)}:${scheme}`}
                    title={`${proposal.title} — ${v.label}`}
                    html={pages.get(v.label) ?? ''}
                    height={frameHeight(v.label)}
                    onContentHeight={onContentHeight(v.label)}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>

        {footer && (
          <Box pt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {footer}
          </Box>
        )}
      </Stack>

      <Modal
        opened={large}
        onClose={() => setLarge(false)}
        title={
          // Toggle pushed right, next to the close button — where the card keeps it.
          <Group gap="sm" wrap="nowrap" justify="space-between" mr="xs" style={{ minWidth: 0 }}>
            <Text fw={600} lineClamp={1} style={{ minWidth: 0 }}>
              {proposal.title}
            </Text>
            {multi && viewToggle(largeView, setLargeView)}
          </Group>
        }
        styles={{ title: { minWidth: 0, flex: 1 } }}
        size="90%"
        fullScreen={isPhone}
      >
        {large && (
          <Stack gap="sm" h={isPhone ? 'calc(100dvh - 90px)' : '78vh'}>
            {largeView === 'focus' ? (
              <>
                {(multi || activeRevisions > 1) && (
                  <Group gap="xs" justify="space-between" wrap="wrap">
                    {multi ? tabs(isPhone && activeRevisions < 2) : <span />}
                    {revisionControl(version.label)}
                  </Group>
                )}
                {version.notes && (
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {version.notes}
                  </Text>
                )}
                <Box style={{ ...frameBox, flex: 1, minHeight: 0 }}>
                  <HtmlFrame
                    key={`${version.label}:${revIndex(version.label)}:${scheme}:large`}
                    title={`${proposal.title} — ${version.label}`}
                    html={pages.get(version.label) ?? ''}
                  />
                </Box>
              </>
            ) : (
              // Every version at its own height at this width, scrolled as one list;
              // the footer stays below it.
              <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} pr={4}>
                <Stack gap="lg" pb={4}>
                  {versions.map((v) => {
                    const active = v.label === version.label;
                    return (
                      <Box key={v.label} style={{ minWidth: 0 }}>
                        <CompareHeader
                          version={v}
                          active={active}
                          chosen={v.label === chosen}
                          onSelect={() => select(v.label)}
                          extra={revisionControl(v.label)}
                        />
                        <Box
                          m={2}
                          style={{
                            ...frameBox,
                            ...(active ? { boxShadow: '0 0 0 2px var(--mantine-primary-color-filled)' } : {}),
                          }}
                        >
                          <HtmlFrame
                            key={`${v.label}:${revIndex(v.label)}:${scheme}:large-compare`}
                            title={`${proposal.title} — ${v.label}`}
                            html={pages.get(v.label) ?? ''}
                            height={clampHeight(largeHeights[hk(v.label)] ?? FRAME_FALLBACK)}
                            onContentHeight={(h) => {
                              const key = hk(v.label);
                              setLargeHeights((prev) =>
                                prev[key] === Math.ceil(h) ? prev : { ...prev, [key]: Math.ceil(h) },
                              );
                            }}
                          />
                        </Box>
                      </Box>
                    );
                  })}
                </Stack>
              </Box>
            )}
            {footer}
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

/**
 * Every version's notes in one grid cell, the inactive ones hidden, so the
 * notes take the height of the longest and the frame below never moves as the
 * tabs change.
 */
function StackedNotes({ versions, active }: { versions: UiProposalVersion[]; active: string }) {
  if (!versions.some((v) => v.notes)) return null;
  return (
    <Box style={{ display: 'grid' }}>
      {versions.map((v) => (
        <Text
          key={v.label}
          size="xs"
          c="dimmed"
          aria-hidden={v.label !== active ? true : undefined}
          style={{
            gridArea: '1 / 1',
            overflowWrap: 'anywhere',
            visibility: v.label === active ? 'visible' : 'hidden',
          }}
        >
          {v.notes}
        </Text>
      ))}
    </Box>
  );
}

/** A version's heading in Compare: selects it for the footer's Choose. */
function CompareHeader({
  version,
  active,
  chosen,
  onSelect,
  extra,
}: {
  version: UiProposalVersion;
  active: boolean;
  chosen: boolean;
  onSelect: () => void;
  /** Beside the heading, outside its button (the revision switch). */
  extra?: ReactNode;
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start" justify="space-between" mb={6}>
    <UnstyledButton onClick={onSelect} style={{ display: 'block', flex: 1, minWidth: 0 }} aria-pressed={active}>
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Box
          mt={3}
          style={{
            width: 14,
            height: 14,
            flexShrink: 0,
            borderRadius: '50%',
            border: `2px solid ${active ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'}`,
            background: active ? 'var(--mantine-primary-color-filled)' : undefined,
            boxShadow: active ? 'inset 0 0 0 2px var(--mantine-color-body)' : undefined,
          }}
        />
        <Box style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
              {version.label}
            </Text>
            {chosen && (
              <Group gap={2} wrap="nowrap" c="teal">
                <IconCheck size={12} />
                <Text size="xs" c="teal">
                  chosen
                </Text>
              </Group>
            )}
          </Group>
          {version.notes && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {version.notes}
            </Text>
          )}
        </Box>
      </Group>
    </UnstyledButton>
    {extra}
    </Group>
  );
}

/**
 * The card's bottom bar: the answer controls while the call waits, the outcome
 * once it is settled. Null when there is nothing to say (still being written,
 * or a viewer with no say in it) — a plain function rather than a component so
 * the card can tell, and leave out the divider above it.
 */
function proposalFooter({
  outcome,
  pending,
  canAnswer,
  sending,
  updating,
  awaitingResult,
  label,
  reply,
  onReply,
  dictation,
  onChoose,
  onFeedback,
  onDismiss,
  accept,
}: {
  outcome: ProposalOutcome | null;
  pending: boolean;
  canAnswer: boolean;
  /** The answer in flight, until its card resolves. */
  sending: AnswerAction | null;
  /** The label being regenerated after "Change", while the agent works on it. */
  updating: string | null;
  awaitingResult: boolean;
  label: string;
  reply: string;
  onReply: (value: string) => void;
  /** The note's mic; absent for a viewer who may not prompt. */
  dictation?: VoiceDictation;
  onChoose: (note: string) => void;
  onFeedback: (text: string) => void;
  onDismiss: () => void;
  accept?: { accepted: string | null; onAccept: () => void; disabled: boolean };
}): ReactNode {
  const text = reply.trim();
  // The button itself says the mock is being reworked, so it does not read as
  // waiting on a chat reply.
  const updatingButton = (target: string) => (
    <Button size="compact-sm" variant="light" disabled leftSection={<Loader size={12} />}>
      Updating {target}…
    </Button>
  );

  if (pending && !canAnswer) {
    return (
      <Text size="xs" c="dimmed">
        Waiting for the session owner to pick a version.
      </Text>
    );
  }
  // After "Change X" the bar stays exactly where it was, locked: the request in
  // its field, the button it came from spinning, the rest disabled — until the
  // revision replaces the card or the turn ends without one.
  const updatingNow = updating !== null && (!outcome || outcome.kind === 'feedback');
  if (pending || updatingNow) {
    const locked = sending !== null || updatingNow;
    const shown = updatingNow && outcome?.kind === 'feedback' && !reply.trim() ? outcome.text : reply;
    return (
      <Stack gap="xs">
        <Textarea
          size="xs"
          autosize
          minRows={1}
          maxRows={5}
          disabled={locked}
          placeholder="Add a note to your pick, or describe what to change…"
          value={shown}
          onChange={(e) => onReply(e.currentTarget.value)}
          rightSectionWidth={dictation ? dictateSectionWidth(dictation, true) : undefined}
          rightSectionPointerEvents="all"
          rightSection={
            dictation ? (
              <DictateButton
                dictation={dictation}
                iconSize={16}
                showTimer
                keepFocus
                disabledReason={locked ? 'Already sent' : undefined}
              />
            ) : undefined
          }
        />
        {dictation && <DictationError dictation={dictation} />}
        <Group gap="xs" justify="space-between" wrap="wrap">
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            disabled={locked}
            onClick={onDismiss}
          >
            Dismiss
          </Button>
          <Group gap="xs" wrap="wrap">
            {sending === 'feedback' || updatingNow ? (
              updatingButton(updating ?? label)
            ) : (
              <Button
                size="compact-sm"
                variant="default"
                leftSection={<IconMessage size={14} />}
                disabled={locked || !text}
                onClick={() => onFeedback(text)}
              >
                Change {label}
              </Button>
            )}
            <Button
              size="compact-sm"
              leftSection={<IconCheck size={14} />}
              loading={sending === 'choice'}
              disabled={locked && sending !== 'choice'}
              onClick={() => onChoose(text)}
            >
              Choose {label}
            </Button>
          </Group>
        </Group>
      </Stack>
    );
  }
  if (awaitingResult && !outcome) {
    return (
      <Group gap="xs">
        <Loader size={12} />
        <Text size="xs" c="dimmed">
          Sent — waiting for the agent
        </Text>
      </Group>
    );
  }

  switch (outcome?.kind) {
    case 'picked':
      return (
        <Stack gap={4}>
          <Group gap={6} wrap="nowrap">
            <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0 }} />
            <Text size="sm">
              You chose <b>{outcome.label}</b>
            </Text>
          </Group>
          {outcome.note && (
            <Text size="xs" c="dimmed" pl={22} style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {outcome.note}
            </Text>
          )}
        </Stack>
      );
    case 'feedback':
      return (
        <Stack gap={4}>
          <Group gap={6} wrap="nowrap">
            <IconMessage size={16} style={{ flexShrink: 0 }} />
            <Text size="sm">
              You asked for changes{outcome.version ? <> to <b>{outcome.version}</b></> : null}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" pl={22} style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {outcome.text}
          </Text>
        </Stack>
      );
    case 'dismissed':
      return (
        <Text size="xs" c="dimmed">
          Dismissed.
        </Text>
      );
    case 'error':
      return (
        <Text size="xs" c="red" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
          {outcome.text}
        </Text>
      );
    case 'shown':
      if (!accept) return null;
      return accept.accepted ? (
        <Group gap={6} wrap="nowrap">
          <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" />
          <Text size="sm">
            Accepted <b>{accept.accepted}</b> — sent
          </Text>
        </Group>
      ) : (
        <Group justify="flex-end">
          <Button
            size="compact-sm"
            leftSection={<IconCheck size={14} />}
            disabled={accept.disabled}
            onClick={accept.onAccept}
          >
            Accept {label}
          </Button>
        </Group>
      );
    default:
      return null;
  }
}

/** Segments shown before older revisions move into the menu. */
const REVISION_SEGMENTS = 3;

/**
 * Steps through a version's revisions, oldest (v1) to latest, so the user can go
 * back to one they preferred before the last change. Up to three fit as
 * segments; past that only the latest and the one before stay as segments, the
 * rest sit in an "Older" menu to their left (so the row reads oldest to latest), and an older one picked from it joins the
 * segments while it is on screen — so the control never grows past four.
 */
function RevisionSwitch({
  count,
  value,
  onChange,
}: {
  count: number;
  value: number;
  onChange: (index: number) => void;
}) {
  const name = (i: number) => (i === count - 1 ? `v${i + 1} · latest` : `v${i + 1}`);
  const compact = count > REVISION_SEGMENTS;
  // Oldest-first indices that live in the menu when compact.
  const older = compact ? Array.from({ length: count - 2 }, (_, i) => i) : [];
  const segments = compact
    ? [...(value < count - 2 ? [value] : []), count - 2, count - 1]
    : Array.from({ length: count }, (_, i) => i);
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="dimmed">
        Revision
      </Text>
      {compact && (
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconHistory size={12} />}>
              Older
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {older
              .slice()
              .reverse()
              .map((i) => (
                <Menu.Item
                  key={i}
                  onClick={() => onChange(i)}
                  rightSection={i === value ? <IconCheck size={12} /> : undefined}
                >
                  {name(i)}
                </Menu.Item>
              ))}
          </Menu.Dropdown>
        </Menu>
      )}
      <SegmentedControl
        size="xs"
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
        data={segments.map((i) => ({ value: String(i), label: name(i) }))}
      />
    </Group>
  );
}

/** The Focus / Compare switch, in the card's header and the large view's title. */
function viewToggle(value: ViewMode, onChange: (next: ViewMode) => void): ReactNode {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as ViewMode)}
      data={[
        { value: 'focus', label: 'Focus' },
        { value: 'compare', label: 'Compare' },
      ]}
    />
  );
}

/** Height cap for a chosen design shown beside a plan — a preview, not the card. */
const CHOSEN_MAX = 420;

/**
 * The designs chosen on proposal cards before a plan, for the plan card and its
 * focus mode: the plan says what will be built, this shows what it looks like.
 * Nothing when no design was chosen.
 */
export function ChosenDesigns({
  sessionId,
  before,
  mb,
}: {
  sessionId: string;
  before: string;
  /** Space below — only when there is something to show. */
  mb?: string;
}) {
  const events = useStore((s) => s.transcripts[sessionId]);
  const picks = useMemo(() => pickedProposals(events, before), [events, before]);
  if (!picks.length) return null;
  return (
    <Stack gap="sm" mb={mb}>
      {picks.map((pick) => (
        <ChosenDesign key={pick.requestId} pick={pick} />
      ))}
    </Stack>
  );
}

function ChosenDesign({ pick }: { pick: PickedProposal }) {
  const scheme = useComputedColorScheme('dark');
  const isPhone = useIsPhone();
  const [height, setHeight] = useState<number | null>(null);
  const [large, setLarge] = useState(false);
  const tokens = useMemo(() => readAppTokens(), [scheme]);
  const html = useMemo(() => withAppTokens(pick.version.html, tokens), [pick.version.html, tokens]);
  const name = `${pick.label}${pick.revisions > 1 ? ` v${pick.revision}` : ''}`;
  const frameBox: CSSProperties = {
    border: '1px solid var(--mantine-color-default-border)',
    borderRadius: 'var(--mantine-radius-md)',
    overflow: 'hidden',
  };
  return (
    <Box>
      <Group gap="xs" justify="space-between" wrap="nowrap" mb={6}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconLayoutDashboard size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
          <Text size="xs" c="dimmed" lineClamp={1}>
            Chosen design · {pick.title} — <b>{name}</b>
          </Text>
        </Group>
        <Tooltip label="Open large">
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Open large" onClick={() => setLarge(true)}>
            <IconArrowsMaximize size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Box style={frameBox}>
        <HtmlFrame
          key={`${pick.requestId}:${scheme}`}
          title={`${pick.title} — ${name}`}
          html={html}
          height={Math.min(CHOSEN_MAX, clampHeight(height ?? FRAME_FALLBACK))}
          onContentHeight={(h) => setHeight(Math.ceil(h))}
        />
      </Box>
      <Modal
        opened={large}
        onClose={() => setLarge(false)}
        title={
          <Text fw={600} lineClamp={1}>
            {pick.title} — {name}
          </Text>
        }
        size="90%"
        fullScreen={isPhone}
      >
        {large && (
          <Box h={isPhone ? 'calc(100dvh - 90px)' : '78vh'} style={frameBox}>
            <HtmlFrame key={`${pick.requestId}:${scheme}:large`} title={`${pick.title} — ${name}`} html={html} />
          </Box>
        )}
      </Modal>
    </Box>
  );
}

/**
 * The permission row of a `propose_ui` card. It shows nothing while open or
 * once answered: the proposal card is where the user answers and where the
 * outcome reads. Only an expired card keeps a line — it has no result to show.
 */
export function ProposalPermission({ resolution }: { resolution?: 'allow' | 'deny' | 'expired' }) {
  if (resolution !== 'expired') return null;
  return (
    <Text size="xs" c="dimmed">
      UI proposal no longer active — ask again to see it.
    </Text>
  );
}
