import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconCopy,
  IconHistory,
  IconLock,
  IconPlus,
  IconSearch,
  IconShieldQuestion,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import type { StepContent, StepDef, UntrustedMark } from '@lines/shared';
import { DEFAULT_MODEL, formatTimestamp, isStepRef, providerForModel, validateRoutingRule } from '@lines/shared';
import { useStore } from '../../store';
import { getOwnerId, getOwnerName } from '../../lib/clerk';
import { MOD } from '../../lib/platform';
import { send } from '../../ws';
import { ConfirmModal } from '../ConfirmModal';
import { contentOf, OUTPUT_NAME_HINT, OUTPUT_NAME_RE } from './useWorkflowDraft';
import { FieldDiffList, relTime } from './StepCard';
import { PromptEditor } from './PromptEditor';
import { modelLabel, StepSettings } from './StepSettings';
import { StepBanner, StepPane } from './StepPane';
import { isHeld, needsReview, stepReviewItem, UntrustedBadge, UntrustedReviewModal } from './UntrustedReview';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

type Draft = StepContent & {
  id?: string;
  ownerId?: string;
  ownerName?: string;
  version?: number;
  published?: boolean;
  createdAt?: number;
  updatedAt?: number;
  /**
   * The mark of what this unsaved copy was copied from, sent with its first save
   * so the copy stays held back until reviewed — copying is not a way past it.
   * Editor-only; a loaded step's own `untrusted` is never sent back.
   */
  heldMark?: UntrustedMark;
};

const BLANK: Draft = {
  name: 'New step',
  promptTemplate: '',
  model: DEFAULT_MODEL,
  permissionMode: 'auto',
  autoAdvance: false,
  freshStart: false,
  outputName: '',
  published: false,
};

/** Dirty/baseline key — content plus the published flag (a publish toggle is a change). */
function snapshot(d: Draft): string {
  return JSON.stringify({ ...contentOf(d), published: d.published ?? false });
}

function DirtyDot() {
  return (
    <Box
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--mantine-primary-color-filled)',
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Browse an owned step's version history and restore one. Restoring loads that version's content into
 * the draft (leaving it dirty); Save republishes it as a *new* head version — history is never rewritten.
 * `versions === undefined` = still loading; `onOpen` triggers the fetch.
 */
function RestoreHistoryPopover({
  current,
  currentVersion,
  versions,
  onOpen,
  onRestore,
}: {
  current: StepContent;
  currentVersion?: number;
  versions?: StepDef[];
  onOpen: () => void;
  onRestore: (def: StepDef) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const preview = versions?.find((v) => v.version === selected);

  return (
    <Popover
      width={340}
      position="bottom-end"
      withArrow
      shadow="md"
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        <Tooltip label="Version history" withArrow>
          <UnstyledButton
            className={styles.link}
            aria-label={`v${currentVersion ?? 1} — version history`}
            onClick={() => {
              // Fire the fetch here — Mantine's onChange doesn't fire when we drive `opened` ourselves.
              if (!opened) {
                setSelected(null);
                onOpen();
              }
              setOpened((o) => !o);
            }}
          >
            <IconHistory size={12} />
            v{currentVersion ?? 1}
          </UnstyledButton>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={10}>
          <Text size="xs" fw={600}>Version history</Text>
          {versions === undefined ? (
            <Text size="xs" c="dimmed">Loading versions…</Text>
          ) : (
            <>
              <ScrollArea.Autosize mah={220} type="auto">
                <Stack gap={1}>
                  {versions.map((v) => (
                    <UnstyledButton
                      key={v.version}
                      className={`${styles.versionRow} ${selected === v.version ? styles.versionRowActive : ''}`}
                      onClick={() => setSelected(v.version)}
                    >
                      <Text size="sm" fw={600}>v{v.version}</Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>{relTime(v.updatedAt)}</Text>
                      <UntrustedBadge mark={v.untrusted} ownerName={v.ownerName} />
                      {v.version === currentVersion && (
                        <Badge size="xs" variant="light" tt="none">current</Badge>
                      )}
                    </UnstyledButton>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              {preview && (
                <>
                  <FieldDiffList from={current} to={preview} />
                  {/* Restoring saves the old content as a new version this machine
                      signs, so an unverified one would come out the other side
                      trusted without anyone having allowed it. */}
                  <Tooltip label="This version has not been verified on this machine" disabled={!needsReview(preview.untrusted)} withArrow>
                    <Button
                      size="xs"
                      disabled={preview.version === currentVersion || needsReview(preview.untrusted)}
                      onClick={() => {
                        onRestore(preview);
                        setOpened(false);
                      }}
                    >
                      Restore v{preview.version}
                    </Button>
                  </Tooltip>
                </>
              )}
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function StepLibrary() {
  const steps = useStore((s) => s.steps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const stepVersions = useStore((s) => s.stepVersions);
  const models = useStore((s) => s.models);
  const workflows = useStore((s) => s.workflows);

  // Selected key: `own:<id>` | `shared:<ownerId>/<id>` | null (creating new).
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [query, setQuery] = useState('');

  const load = (d: Draft | null, key: string | null) => {
    setDraft(d);
    setSelected(key);
    setBaseline(d ? snapshot(d) : null);
  };

  // On first mount (or when the lists arrive), pick the first owned step.
  useEffect(() => {
    if (draft) return;
    if (steps[0]) load(steps[0], `own:${steps[0].id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);

  const readOnly = !!draft && selected?.startsWith('shared:') === true;
  // Own library wins: a step id that also came back in the shared pull is this
  // user's own, and belongs in the owned section only.
  const foreignSteps = useMemo(
    () => sharedSteps.filter((s) => !steps.some((own) => own.id === s.id)),
    [sharedSteps, steps],
  );
  // How many of the user's own workflows pin each step — what an edit to it can
  // reach (each as an update offer there, never silently).
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of workflows) {
      for (const id of new Set(w.steps.filter(isStepRef).map((s) => s.stepId))) {
        m.set(id, (m.get(id) ?? 0) + 1);
      }
    }
    return m;
  }, [workflows]);
  const q = query.trim().toLowerCase();
  const matches = (s: StepDef) =>
    !q || s.name.toLowerCase().includes(q) || s.promptTemplate.toLowerCase().includes(q);
  const ownShown = steps.filter(matches);
  const foreignShown = foreignSteps.filter(matches);

  const dirty = useMemo(
    () => (draft && baseline ? snapshot(draft) !== baseline : false),
    [draft, baseline],
  );
  // A name outside the read regex can never be referenced as {outputs.<name>}.
  const outputNameError =
    draft && (draft.outputName ?? '').trim() && !OUTPUT_NAME_RE.test((draft.outputName ?? '').trim())
      ? OUTPUT_NAME_HINT
      : undefined;
  // The same check the workflow editor and the bridge's shared validator run:
  // a rule saved here unchecked only failed later, in whichever workflow pinned it.
  const routingError = draft?.routing
    ? validateRoutingRule(draft.routing, providerForModel(draft.model))[0]
    : undefined;
  const valid =
    !!draft &&
    draft.name.trim() !== '' &&
    draft.promptTemplate.trim() !== '' &&
    !outputNameError &&
    !routingError;

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  // ---- version history (own steps only) ----
  const ownerIdOf = (d: Draft) => d.ownerId ?? getOwnerId() ?? '';

  const requestVersions = () => {
    if (!draft?.id) return;
    send({ type: 'stepVersions', ownerId: ownerIdOf(draft), stepId: draft.id });
  };

  /** Fetched history unioned with the local head, newest first; undefined = nothing known yet. */
  const versionsFor = (d: Draft): StepDef[] | undefined => {
    if (!d.id) return undefined;
    const fetched = stepVersions[`${ownerIdOf(d)}/${d.id}`];
    const head = steps.find((s) => s.id === d.id);
    if (!fetched && !head) return undefined;
    const byVersion = new Map<number, StepDef>();
    for (const v of [...(fetched ?? []), ...(head ? [head] : [])]) {
      if (!byVersion.has(v.version)) byVersion.set(v.version, v);
    }
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  };

  /**
   * The live store row behind the selection, which is where the header's
   * timestamps come from: `save()` re-loads the draft it just sent, so a draft
   * value would show the version and time from *before* the save until the
   * broadcast happened to replace it.
   */
  const storeRow = (d: Draft): StepDef | undefined =>
    d.id
      ? (steps.find((s) => s.id === d.id) ??
        sharedSteps.find((s) => s.id === d.id && s.ownerId === ownerIdOf(d)))
      : undefined;
  const stepRow = draft ? storeRow(draft) : undefined;
  const usedIn = draft?.id && !readOnly ? (usage.get(draft.id) ?? 0) : 0;

  /**
   * Load an older version's content into the draft; Save republishes it as a new
   * head version. Every field is replaced, so one the old version lacked (an
   * effort, a routing rule) is cleared rather than carried over.
   */
  const restore = (def: StepDef) => patch(contentOf(def));

  const newStep = () => load({ ...BLANK }, null);

  const canSave = !!draft && !readOnly && valid && (!draft.id || dirty);
  const save = () => {
    if (!draft || readOnly || !valid) return;
    const stepId = draft.id ?? crypto.randomUUID();
    const published = draft.published ?? false;
    const step = draft.heldMark ? { ...contentOf(draft), untrusted: draft.heldMark } : contentOf(draft);
    send({ type: 'saveStep', step, stepId, published, ownerName: getOwnerName() ?? undefined });
    // Select the (soon-updated) own step; the broadcast refreshes its version.
    // The copy's mark has been sent once; the bridge's verdict stands from here.
    load({ ...draft, id: stepId, published, heldMark: undefined }, `own:${stepId}`);
  };

  const saveHotkey = canSave && !confirmDelete;
  useHotkeys(
    [['mod+S', () => saveHotkey && save(), { preventDefault: saveHotkey }]],
    [], // from the prompt and name fields too — that is where the edits happen
    true,
  );

  const duplicate = () => {
    if (!draft) return;
    // The live row's mark, not the draft's: the draft may predate a review.
    const mark = needsReview(stepRow?.untrusted) ? stepRow?.untrusted : undefined;
    load({ ...contentOf(draft), name: `${draft.name} (copy)`, ...(mark ? { heldMark: mark } : {}) }, null);
  };

  const doDelete = () => {
    setConfirmDelete(false);
    if (!draft?.id) return;
    send({ type: 'deleteStep', stepId: draft.id });
    load(steps.find((s) => s.id !== draft.id) ?? null, null);
  };

  const metaLine = !draft
    ? ''
    : readOnly
      ? `By ${draft.ownerName ?? 'another user'}${stepRow ? ` · updated ${relTime(stepRow.updatedAt)}` : ''}`
      : !draft.id
        ? 'Not saved yet'
        : [
            stepRow?.createdAt !== undefined ? `Created ${formatTimestamp(stepRow.createdAt)}` : null,
            stepRow ? `Updated ${formatTimestamp(stepRow.updatedAt)}` : null,
            usedIn === 0
              ? 'Not pinned in any of your workflows yet'
              : `Pinned in ${usedIn} of your workflows`,
          ]
            .filter(Boolean)
            .join(' · ');

  return (
    <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
      <div className={styles.listColumn} style={{ width: 'clamp(240px, 20vw, 280px)' }}>
        <Box px={10} pt={10}>
          <TextInput
            size="xs"
            aria-label="Search steps"
            placeholder="Search steps"
            leftSection={<IconSearch size={13} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </Box>
        <ScrollArea style={{ flex: 1 }} type="hover">
          <div className={styles.listBody}>
            <div className={styles.listSection}>Your library · {steps.length}</div>
            {ownShown.map((s) => {
              // The key is a local, not a prop: React never passes `key` down,
              // so a row reading it from props matched every row at once.
              const k = `own:${s.id}`;
              const used = usage.get(s.id) ?? 0;
              return (
                <UnstyledButton
                  key={k}
                  className={cn(styles.listRow, selected === k && styles.rowActive)}
                  onClick={() => load(s, k)}
                >
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{s.name}</span>
                    <span className={styles.rowMeta}>
                      {[`v${s.version}`, modelLabel(models, s.model), used ? `in ${used} workflow${used === 1 ? '' : 's'}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <UntrustedBadge mark={s.untrusted} ownerName={s.ownerName} />
                  {selected === k && dirty && <DirtyDot />}
                  {s.published && (
                    <Tooltip label="Shared with everyone" withArrow>
                      <span className={styles.rowAside}>
                        <IconWorld size={12} />
                      </span>
                    </Tooltip>
                  )}
                </UnstyledButton>
              );
            })}
            {steps.length === 0 ? (
              <Text size="xs" c="dimmed" px={10} py={6}>
                No steps yet. A step saved here can be pinned in any of your workflows.
              </Text>
            ) : (
              ownShown.length === 0 && (
                <Text size="xs" c="dimmed" px={10} py={6}>
                  No matches.
                </Text>
              )
            )}
            {foreignShown.length > 0 && (
              <>
                <div className={styles.listSection}>Shared by others · {foreignSteps.length}</div>
                {foreignShown.map((s) => {
                  const k = `shared:${s.ownerId}/${s.id}`;
                  return (
                    <UnstyledButton
                      key={k}
                      className={cn(styles.listRow, selected === k && styles.rowActive)}
                      onClick={() => load(s, k)}
                    >
                      <span className={styles.rowText}>
                        <span className={styles.rowName}>{s.name}</span>
                        <span className={styles.rowMeta}>
                          {s.ownerName ?? 'Unknown'} · v{s.version} · {modelLabel(models, s.model)}
                        </span>
                      </span>
                      <UntrustedBadge mark={s.untrusted} ownerName={s.ownerName} />
                    </UnstyledButton>
                  );
                })}
              </>
            )}
          </div>
        </ScrollArea>
        <Box p={10}>
          <Button fullWidth variant="default" leftSection={<IconPlus size={13} />} onClick={newStep}>
            New step
          </Button>
        </Box>
      </div>
      <Divider orientation="vertical" />

      {draft ? (
        <StepPane
          header={
            <>
              <div className={styles.paneTitle}>
                <div className={styles.label}>
                  {readOnly ? 'Shared step' : draft.id ? 'Library step' : 'New library step'}
                </div>
                <TextInput
                  variant="unstyled"
                  placeholder="Step name"
                  aria-label="Step name"
                  classNames={{ input: styles.titleInput }}
                  value={draft.name}
                  readOnly={readOnly}
                  onChange={(e) => patch({ name: e.currentTarget.value })}
                />
                <Text fz={11} c="dimmed" mt={2}>
                  {metaLine}
                </Text>
              </div>
              <Group gap={10} wrap="nowrap" pt={18}>
                {draft.id && !readOnly && (
                  <RestoreHistoryPopover
                    current={contentOf(draft)}
                    currentVersion={draft.version}
                    versions={versionsFor(draft)}
                    onOpen={requestVersions}
                    onRestore={restore}
                  />
                )}
                {readOnly && (
                  <span className={styles.link} data-static>
                    v{draft.version ?? 1}
                  </span>
                )}
                {!readOnly && (
                  <Switch
                    size="xs"
                    label="Share with everyone"
                    checked={draft.published ?? false}
                    onChange={(e) => patch({ published: e.currentTarget.checked })}
                  />
                )}
              </Group>
            </>
          }
          banner={
            <>
              {stepRow && needsReview(stepRow.untrusted) && (
                <StepBanner
                  icon={<IconShieldQuestion size={14} />}
                  actions={
                    <Button size="compact-xs" variant="light" color="orange" onClick={() => setReviewOpen(true)}>
                      Review
                    </Button>
                  }
                >
                  This machine has not verified v{stepRow.version} of this step yet,{' '}
                  {isHeld(stepRow.untrusted)
                    ? 'so no workflow pinning it will run that version until you review it.'
                    : 'though it still runs because strict sync is off on this machine.'}
                </StepBanner>
              )}
              {readOnly && (
                <StepBanner
                  icon={<IconLock size={14} />}
                  actions={
                    <Button size="compact-xs" variant="default" leftSection={<IconCopy size={12} />} onClick={duplicate}>
                      Make an editable copy
                    </Button>
                  }
                >
                  From <b>{draft.ownerName ?? 'another user'}</b>, read-only. Pin it from a workflow's Add step menu,
                  or make an editable copy in your library to change it.
                </StepBanner>
              )}
            </>
          }
          prompt={
            <PromptEditor
              fill
              value={draft.promptTemplate}
              readOnly={readOnly}
              inputClassName={styles.promptInput}
              freshStart={draft.freshStart}
              onChange={(v) => patch({ promptTemplate: v })}
            />
          }
          settings={
            <StepSettings
              // Remounted per step, so the Advanced disclosure opens for the step
              // that has a routing rule rather than staying as the last one left it.
              key={selected ?? 'new'}
              flow="inline"
              value={draft}
              readOnly={readOnly}
              models={models}
              errors={{ outputName: outputNameError, routing: routingError }}
              onPatch={patch}
            />
          }
          footer={
            readOnly ? undefined : (
              <>
                <Group gap="xs" wrap="nowrap">
                  {draft.id && (
                    <Button
                      variant="subtle"
                      color="red"
                      leftSection={<IconTrash size={13} />}
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete
                    </Button>
                  )}
                  <Button variant="default" leftSection={<IconCopy size={13} />} onClick={duplicate}>
                    Duplicate
                  </Button>
                </Group>
                <Group gap="sm" wrap="nowrap">
                  {(dirty || !draft.id) && (
                    <Group gap={6} wrap="nowrap">
                      <DirtyDot />
                      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                        {draft.id ? 'Unsaved changes' : 'Not saved yet'} · {MOD}S
                      </Text>
                    </Group>
                  )}
                  <Button disabled={!canSave} onClick={save}>
                    {draft.id ? (dirty ? 'Save changes' : 'Saved') : 'Save step'}
                  </Button>
                </Group>
              </>
            )
          }
        />
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }} gap="xs">
          <Text size="sm" c="dimmed">Select a step or create a new one.</Text>
          <Button variant="light" leftSection={<IconPlus size={13} />} onClick={newStep}>
            New step
          </Button>
        </Stack>
      )}

      <UntrustedReviewModal
        opened={reviewOpen && needsReview(stepRow?.untrusted)}
        title={`Review “${stepRow?.name ?? 'step'}”`}
        items={stepRow ? [stepReviewItem(stepRow, `${stepRow.name} · v${stepRow.version}`)] : []}
        onClose={() => setReviewOpen(false)}
      />
      <ConfirmModal
        opened={confirmDelete}
        title="Delete step"
        message={`Remove "${draft?.name ?? ''}" from the library? Workflows already pinned to it keep working.`}
        confirmLabel="Delete"
        confirmColor="red"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </Group>
  );
}
