import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
} from '@mantine/core';
import { DiffEditor } from '@monaco-editor/react';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconGitBranch,
  IconMaximize,
  IconX,
} from '@tabler/icons-react';
import type { FileChange, SessionDiffFileResponse, SessionDiffRepo, SessionDiffResponse } from '@lines/shared';
import { fetchSessionDiff, fetchSessionDiffFile } from '../lib/sessionDiff';
import { languageFor } from '../lib/language';
import { MonacoDiffModal } from './MonacoDiffModal';
import { useIsPhone } from '../lib/layout';
import { BestOnDesktop } from './BestOnDesktop';

/** Why a repo's diff isn't floored at the session's own snapshot. */
const BASELINE_NOTE: Record<SessionDiffRepo['baseline'], string | null> = {
  session: null,
  workflow: 'Baselined at this session’s workflow start, not at session start.',
  synthetic:
    'No baseline was recorded for this session — showing all uncommitted work in this repository.',
  stale:
    'The recorded snapshot was pruned by a `git gc`, so this is measured from HEAD — changes made before the session started may appear here.',
};

const STATUS_COLOR: Record<FileChange['status'], string> = { A: 'teal', M: 'blue', D: 'red' };
const STATUS_LABEL: Record<FileChange['status'], string> = { A: 'new', M: 'edited', D: 'deleted' };

const SIDEBAR_WIDTH = 320;
/** Chrome above the panes: the modal's own header. */
const PANE_HEIGHT = 'calc(100vh - 60px)';

/** Monaco is at an edge within this many pixels — its scroll height is fractional. */
const EDGE_EPSILON = 2;
/**
 * Pull, in pixels, that commits to the next file — and the furthest the pane can
 * travel. One number for both, so how far the gesture *looks* is exactly how far
 * it has to go.
 */
const RUBBER_TRAVEL = 200;
/**
 * How much of the overscroll becomes pull. Under 1 so it feels like stretching
 * something rather than scrolling it, and so one hard flick can't cross the whole
 * travel before you have seen the label appear.
 */
const RUBBER_RESISTANCE = 0.5;
/**
 * Fraction of the travel the band gets at the first and last file. Short enough
 * that it reads as a stop rather than a step you failed to complete.
 */
const DEAD_END_TRAVEL = 0.35;
/** The label's size at rest and at full pull — it grows into the strip it opens. */
const LABEL_MIN_PX = 11;
const LABEL_MAX_PX = 22;
/** Breathing room in the revealed strip, so the label never sits on the edge. */
const STRIP_PADDING = 16;
/** A trackpad flick keeps firing after the commit; ignore it for this long. */
const COOLDOWN_MS = 450;
/** No wheel for this long at an edge and the pull springs back. */
const RELEASE_MS = 250;

/** Stable identity for a file across the repos it could live in. */
const fileKey = (repo: string, rel: string) => `${repo} ${rel}`;

/** Read off the wrapper's own callback rather than imported from `monaco-editor`,
 *  which reaches this workspace transitively and is not declared here. */
type DiffEditorInstance = Parameters<NonNullable<React.ComponentProps<typeof DiffEditor>['onMount']>>[0];

/** One selectable file, flattened out of its repo section for navigation. */
interface Entry {
  repo: string;
  file: FileChange;
  key: string;
}

function FileRow({
  file,
  selected,
  onSelect,
  onHide,
}: {
  file: FileChange;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
}) {
  const slash = file.rel.lastIndexOf('/');
  return (
    <Group
      gap={4}
      wrap="nowrap"
      px="xs"
      py={3}
      style={{
        borderRadius: 4,
        background: selected ? 'var(--mantine-color-default-hover)' : undefined,
      }}
    >
      <UnstyledButton onClick={onSelect} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Badge size="xs" variant="light" color={STATUS_COLOR[file.status]} w={52}>
            {STATUS_LABEL[file.status]}
          </Badge>
          <Text size="xs" ff="monospace" truncate="start" style={{ flex: 1, minWidth: 0 }}>
            {slash >= 0 && (
              <Text span c="dimmed" inherit>
                {file.rel.slice(0, slash + 1)}
              </Text>
            )}
            {file.rel.slice(slash + 1)}
          </Text>
          {file.added > 0 && (
            <Text size="xs" c="teal">
              +{file.added}
            </Text>
          )}
          {file.removed > 0 && (
            <Text size="xs" c="red">
              −{file.removed}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      <Tooltip label="Hide this file" withArrow openDelay={400}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="xs"
          aria-label={`Hide ${file.rel}`}
          onClick={onHide}
        >
          <IconX size={11} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * The diff pane: one Monaco editor for the selected file, filling the pane.
 *
 * Exactly one editor, at a fixed height, is what keeps this honest — the earlier
 * shape stacked an editor per file and had to guess each one's height before
 * Monaco could measure it, so the scroll height climbed as you went down the
 * list. Here Monaco scrolls internally, which it is good at, and the pane never
 * changes size.
 *
 * Reaching the end and pushing further pulls the pane past its edge and then
 * moves to the next file — so the whole review is still one gesture, without one
 * scroll container that has to know every file's height in advance.
 */
function DiffPane({
  entry,
  content,
  loading,
  error,
  hasNext,
  hasPrev,
  onStep,
  onFullScreen,
}: {
  entry: Entry;
  content: SessionDiffFileResponse | null;
  loading: boolean;
  error: string | null;
  hasNext: boolean;
  hasPrev: boolean;
  onStep: (direction: 1 | -1) => void;
  onFullScreen: () => void;
}) {
  const colorScheme = useComputedColorScheme('dark');
  const paneRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DiffEditorInstance | null>(null);
  /** Signed pull in px: positive drags the pane up, toward the next file. */
  const [pull, setPull] = useState(0);
  // Which end the last step came from, so the new file opens where the gesture
  // left off — stepping backwards should land at the bottom, not the top.
  const landAtEnd = useRef(false);

  // Latest values for the wheel listener, which is bound once and must not be
  // rebound on every render (that would drop an in-flight gesture).
  const nav = useRef({ hasNext, hasPrev, onStep });
  nav.current = { hasNext, hasPrev, onStep };

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let accumulated = 0;
    let coolingUntil = 0;
    let release: ReturnType<typeof setTimeout> | undefined;

    const springBack = () => {
      accumulated = 0;
      setPull(0);
    };

    const onWheel = (event: WheelEvent) => {
      const editor = editorRef.current;
      if (!editor) return;
      const modified = editor.getModifiedEditor();
      const max = Math.max(0, modified.getScrollHeight() - modified.getLayoutInfo().height);
      const top = modified.getScrollTop();
      const down = event.deltaY > 0;
      // A file shorter than the pane sits at both edges at once; direction decides.
      const atEdge = down ? top >= max - EDGE_EPSILON : top <= EDGE_EPSILON;
      if (!atEdge) {
        if (accumulated) springBack();
        return; // still Monaco's scroll to do
      }
      // Past the end: this gesture is ours, not the editor's or the modal's —
      // including at the first and last file, where there is nothing to step to.
      // Swallowing the pull there rather than ignoring it is the point: the band
      // stretching a little and stopping short is how the reader learns they have
      // reached the end, instead of the pane simply going dead.
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < coolingUntil) return;

      if (accumulated !== 0 && accumulated > 0 !== down) accumulated = 0;
      accumulated += event.deltaY;
      clearTimeout(release);
      release = setTimeout(springBack, RELEASE_MS);

      const canStep = down ? nav.current.hasNext : nav.current.hasPrev;
      const pulled = accumulated * RUBBER_RESISTANCE;
      if (canStep && Math.abs(pulled) >= RUBBER_TRAVEL) {
        coolingUntil = Date.now() + COOLDOWN_MS;
        clearTimeout(release);
        landAtEnd.current = !down;
        nav.current.onStep(down ? 1 : -1);
        springBack();
        return;
      }
      const limit = canStep ? RUBBER_TRAVEL : RUBBER_TRAVEL * DEAD_END_TRAVEL;
      setPull(Math.max(-limit, Math.min(limit, pulled)));
    };

    // Capture: Monaco consumes the wheel on its own element, so the edge case has
    // to be decided before it gets there.
    pane.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      clearTimeout(release);
      pane.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, []);

  // A new file opens where the gesture was heading: top when moving forward,
  // bottom when moving back.
  useEffect(() => {
    if (!content) return;
    // A frame later: the wrapper has swapped the models by now, but the new
    // scroll height is only right once Monaco has laid them out.
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current?.getModifiedEditor();
      if (!editor) return;
      editor.setScrollTop(landAtEnd.current ? editor.getScrollHeight() : 0);
      landAtEnd.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [entry.key, content]);

  const stats = `+${entry.file.added} −${entry.file.removed}`;
  // The band is shorter where there is nothing to step to, so progress — and the
  // label growing with it — is measured against whichever travel is in play.
  const deadEnd = pull > 0 ? !hasNext : !hasPrev;
  const progress = Math.min(
    1,
    Math.abs(pull) / (RUBBER_TRAVEL * (deadEnd ? DEAD_END_TRAVEL : 1)),
  );
  const labelSize = Math.round(LABEL_MIN_PX + progress * (LABEL_MAX_PX - LABEL_MIN_PX));

  return (
    <Stack gap={0} h="100%" style={{ flex: 1, minWidth: 0 }}>
      <Group gap="xs" wrap="nowrap" px="xs" py={6}>
        <Badge size="xs" variant="light" color={STATUS_COLOR[entry.file.status]}>
          {STATUS_LABEL[entry.file.status]}
        </Badge>
        <Text size="xs" ff="monospace" truncate="start" style={{ flex: 1, minWidth: 0 }}>
          {entry.file.rel}
        </Text>
        {entry.file.ambiguous && (
          <Text size="xs" c="dimmed">
            also touched by another session
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {stats}
        </Text>
        <Tooltip label="Open side by side, full screen" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Open side by side, full screen"
            disabled={!content}
            onClick={onFullScreen}
          >
            <IconMaximize size={13} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Divider />
      <Box style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }} ref={paneRef}>
        {/* The rubber band. A transform, so pulling the pane never reflows the
            editor inside it — Monaco keeps its layout throughout the gesture. */}
        <Box
          style={{
            height: '100%',
            transform: `translateY(${-pull}px)`,
            transition: pull === 0 ? 'transform 120ms ease-out' : undefined,
          }}
        >
          {loading && (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
          )}
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} m="xs" py={6}>
              <Text size="xs">{error}</Text>
            </Alert>
          )}
          {content && !error && (
            <DiffEditor
              height="100%"
              language={languageFor(entry.file.rel)}
              original={content.before}
              modified={content.after}
              theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
              onMount={(editor) => {
                editorRef.current = editor;
              }}
              options={{
                readOnly: true,
                // Inline: a review column is narrow, and two-up here would halve
                // the useful width. Side by side is one click away, full screen.
                renderSideBySide: false,
                // Tighter than Monaco's defaults (3/3), which only fold an
                // unchanged run of 9+ lines — `minContext * 2 + minHiddenLineCount`
                // — so a file with changes every few lines came through nearly
                // whole. At 2/2 anything 6 lines or longer collapses, and the
                // region widget reveals 20 more per click.
                hideUnchangedRegions: {
                  enabled: true,
                  contextLineCount: 2,
                  minimumLineCount: 2,
                  revealLineCount: 20,
                },
                scrollBeyondLastLine: false,
                // The first and last lines are exactly where the rubber gesture
                // starts, so neither should be flush against the pane's edge.
                padding: { top: 8, bottom: 8 },
                minimap: { enabled: false },
                fontSize: 12,
                automaticLayout: true,
              }}
            />
          )}
        </Box>
        {/* Fills the strip the transform opens up, so the label sits centred in
            the gap rather than pinned against the pane's edge — and grows into it
            as the pull does, which is the progress indicator. */}
        {pull !== 0 && (
          <Group
            gap={8}
            justify="center"
            align="center"
            px="xs"
            h={Math.abs(pull) + STRIP_PADDING}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              [pull > 0 ? 'bottom' : 'top']: 0,
              pointerEvents: 'none',
              opacity: 0.35 + progress * 0.65,
            }}
          >
            {!deadEnd &&
              (pull > 0 ? <IconArrowDown size={labelSize} /> : <IconArrowUp size={labelSize} />)}
            <Text c="dimmed" style={{ fontSize: labelSize, lineHeight: 1.2 }}>
              {deadEnd
                ? `Nothing ${pull > 0 ? 'after' : 'before'} this file`
                : `Keep scrolling for the ${pull > 0 ? 'next' : 'previous'} file`}
            </Text>
          </Group>
        )}
      </Box>
    </Stack>
  );
}

function RepoSection({
  repo,
  hidden,
  selectedKey,
  otherOpen,
  onToggleOther,
  onSelect,
  onHide,
}: {
  repo: SessionDiffRepo;
  hidden: Set<string>;
  selectedKey: string | null;
  otherOpen: boolean;
  onToggleOther: () => void;
  onSelect: (key: string) => void;
  onHide: (key: string) => void;
}) {
  const note = BASELINE_NOTE[repo.baseline];
  const visible = (files: FileChange[]) => files.filter((f) => !hidden.has(fileKey(repo.repo, f.rel)));
  const attributed = visible(repo.attributed);
  const other = visible(repo.other);

  const row = (file: FileChange) => {
    const key = fileKey(repo.repo, file.rel);
    return (
      <FileRow
        key={key}
        file={file}
        selected={key === selectedKey}
        onSelect={() => onSelect(key)}
        onHide={() => onHide(key)}
      />
    );
  };

  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap" px="xs">
        <Text size="xs" ff="monospace" c="dimmed" truncate="start" style={{ flex: 1, minWidth: 0 }}>
          {repo.repo}
        </Text>
        {repo.branch && (
          <Group gap={3} wrap="nowrap" c="dimmed">
            <IconGitBranch size={12} />
            <Text size="xs">{repo.branch}</Text>
          </Group>
        )}
      </Group>
      {note && (
        <Alert color="yellow" icon={<IconAlertTriangle size={14} />} py={4} mx="xs">
          <Text size="xs">{note}</Text>
        </Alert>
      )}

      {attributed.length === 0 ? (
        <Text size="xs" c="dimmed" px="xs">
          Nothing changed by this session yet.
        </Text>
      ) : (
        attributed.map(row)
      )}

      {(other.length > 0 || !!repo.untrackedOmitted) && (
        <>
          {/* Collapsed by default: in a shared (non-worktree) checkout this is the
              rest of the working tree, which may be somebody else's work. */}
          <UnstyledButton onClick={onToggleOther} px="xs">
            <Group gap={4} wrap="nowrap" c="dimmed">
              {otherOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              <Text size="xs" fw={600}>
                Other uncommitted ({other.length})
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse expanded={otherOpen}>
            <Stack gap={2}>
              {other.map(row)}
              {!!repo.untrackedOmitted && (
                <Text size="xs" c="dimmed" px="xs">
                  … {repo.untrackedOmitted} more untracked files not listed.
                </Text>
              )}
            </Stack>
          </Collapse>
        </>
      )}
    </Stack>
  );
}

/**
 * Read-only review of what a session changed: the changed files down the left,
 * the selected file's diff on the right.
 *
 * Working-tree state scoped to a session, never a per-session snapshot: sessions
 * that share a checkout see each other's dirty files, which is what the split
 * into "changed by this session" and "other uncommitted" is for.
 *
 * Only the selected file's contents are ever fetched, and they are cached for the
 * life of the modal — so opening this on a large working tree costs one list
 * request, and stepping back to a file you have already read is instant.
 */
export function SessionDiffModal({
  opened,
  onClose,
  sessionId,
}: {
  opened: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const [data, setData] = useState<SessionDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-file dismissals, for this viewing only — a reopen starts from the whole
  // list rather than from a filter the user has since forgotten setting.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [otherOpen, setOtherOpen] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  const [content, setContent] = useState<SessionDiffFileResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  // Contents already read, keyed like the rows. Stepping back and forth through a
  // review must not re-request every file each time.
  const cache = useRef(new Map<string, SessionDiffFileResponse>());

  useEffect(() => {
    if (!opened) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    fetchSessionDiff(sessionId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, sessionId]);

  // Navigation order, and what the rubber step walks: this session's files first,
  // then a repo's other changes only while that section is open — stepping into a
  // list you have collapsed would be a surprise.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const repo of data?.repos ?? []) {
      const push = (file: FileChange) => {
        const key = fileKey(repo.repo, file.rel);
        if (!hidden.has(key)) out.push({ repo: repo.repo, file, key });
      };
      repo.attributed.forEach(push);
      if (otherOpen.has(repo.repo)) repo.other.forEach(push);
    }
    return out;
  }, [data, hidden, otherOpen]);

  const index = entries.findIndex((e) => e.key === selectedKey);
  const selected = index >= 0 ? entries[index] : null;

  // Land on something real: the first file when the modal opens, and the nearest
  // survivor when the selected one is hidden or its section closes.
  useEffect(() => {
    if (!entries.length) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    if (!entries.some((e) => e.key === selectedKey)) setSelectedKey(entries[0].key);
  }, [entries, selectedKey]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    const cached = cache.current.get(selected.key);
    if (cached) {
      setContent(cached);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    setContent(null);
    setFileError(null);
    setFileLoading(true);
    let cancelled = false;
    fetchSessionDiffFile(sessionId, selected.repo, selected.file.rel)
      .then((res) => {
        cache.current.set(selected.key, res);
        if (!cancelled) setContent(res);
      })
      .catch((err) => {
        if (!cancelled) setFileError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.key, selected?.repo, selected?.file.rel, sessionId]);

  const step = useCallback(
    (direction: 1 | -1) => {
      setSelectedKey((current) => {
        const at = entries.findIndex((e) => e.key === current);
        const next = at + direction;
        return next >= 0 && next < entries.length ? entries[next].key : current;
      });
    },
    [entries],
  );

  const toggleOther = (repo: string) =>
    setOtherOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });

  const total = data?.repos.reduce((n, r) => n + r.attributed.length, 0) ?? 0;
  const isPhone = useIsPhone();

  if (isPhone) {
    return (
      <Modal opened={opened} onClose={onClose} title="Session changes" fullScreen>
        <BestOnDesktop what="Reviewing this session’s changes" onClose={onClose} />
      </Modal>
    );
  }

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        title="Session changes"
        fullScreen
        padding={0}
        styles={{ body: { overflow: 'hidden' } }}
      >
        <Group gap={0} align="stretch" wrap="nowrap" h={PANE_HEIGHT}>
          <Stack gap="md" w={SIDEBAR_WIDTH} py="xs" style={{ overflowY: 'auto', flexShrink: 0 }}>
            {loading && <Loader size="sm" mx="xs" />}
            {error && (
              <Alert color="red" icon={<IconAlertTriangle size={16} />} m="xs" py={6}>
                <Text size="xs">{error}</Text>
              </Alert>
            )}
            {hidden.size > 0 && (
              <Group gap="xs" px="xs">
                <Text size="xs" c="dimmed">
                  {hidden.size} hidden
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconEye size={12} />}
                  onClick={() => setHidden(new Set())}
                >
                  Show all
                </Button>
              </Group>
            )}
            {data && !loading && data.repos.length === 0 && (
              <Text size="xs" c="dimmed" px="xs">
                This session is not working inside a git repository, so there is nothing to diff.
              </Text>
            )}
            {data && !loading && data.repos.length > 0 && total === 0 && (
              <Text size="xs" c="dimmed" px="xs">
                This session has not changed any files yet.
              </Text>
            )}
            {data?.repos.map((repo) => (
              <RepoSection
                key={repo.repo}
                repo={repo}
                hidden={hidden}
                selectedKey={selectedKey}
                otherOpen={otherOpen.has(repo.repo)}
                onToggleOther={() => toggleOther(repo.repo)}
                onSelect={setSelectedKey}
                onHide={(key) => setHidden((prev) => new Set(prev).add(key))}
              />
            ))}
            {!!data?.orphans.length && (
              <Text size="xs" c="dimmed" px="xs">
                Not in a git repository, so not tracked: {data.orphans.join(', ')}
              </Text>
            )}
          </Stack>
          <Divider orientation="vertical" />
          {selected ? (
            // Deliberately not keyed on the file: remounting per step would
            // rebuild the Monaco editor each time and drop the gesture that asked
            // for the step. Only the models swap.
            <DiffPane
              entry={selected}
              content={content}
              loading={fileLoading}
              error={fileError}
              hasNext={index < entries.length - 1}
              hasPrev={index > 0}
              onStep={step}
              onFullScreen={() => setFullScreen(true)}
            />
          ) : (
            <Group justify="center" style={{ flex: 1 }}>
              <Text size="xs" c="dimmed">
                Select a file to see its diff.
              </Text>
            </Group>
          )}
        </Group>
      </Modal>
      {fullScreen && selected && content && (
        <MonacoDiffModal
          opened
          onClose={() => setFullScreen(false)}
          filePath={selected.file.rel}
          before={content.before}
          after={content.after}
        />
      )}
    </>
  );
}
