import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconCopy, IconHistory, IconPlus, IconTrash } from '@tabler/icons-react';
import type { PermissionMode, StepContent, StepDef } from '@lines/shared';
import { DEFAULT_MODEL, formatTimestamp } from '@lines/shared';
import { useStore } from '../../store';
import { getOwnerId, getOwnerName } from '../../lib/clerk';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../../lib/modelSelect';
import { send } from '../../ws';
import { ConfirmModal } from '../ConfirmModal';
import { OUTPUT_NAME_HINT, OUTPUT_NAME_RE } from './useWorkflowDraft';
import { PERMISSION_MODES, renderPermissionModeOption } from '../../lib/permissionModes';
import { FieldDiffList, relTime } from './StepCard';
import { PromptEditor } from './PromptEditor';
import styles from './workflow.module.css';

type Draft = StepContent & {
  id?: string;
  ownerId?: string;
  ownerName?: string;
  version?: number;
  published?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

const BLANK: Draft = {
  name: 'New step',
  promptTemplate: '',
  model: DEFAULT_MODEL,
  permissionMode: 'default',
  autoAdvance: false,
  freshStart: false,
  outputName: '',
  published: false,
};

/** Dirty/baseline key — content plus the published flag (a publish toggle is a change). */
function snapshot(d: Draft): string {
  return JSON.stringify({ ...content(d), published: d.published ?? false });
}

function content(d: Draft): StepContent {
  return {
    name: d.name,
    promptTemplate: d.promptTemplate,
    model: d.model,
    permissionMode: d.permissionMode,
    autoAdvance: d.autoAdvance,
    freshStart: d.freshStart,
    outputName: d.outputName ?? '',
  };
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
        <Tooltip label="Version history">
          <ActionIcon
            variant="subtle"
            color="gray"
            mb={4}
            onClick={() => {
              // Fire the fetch here — Mantine's onChange doesn't fire when we drive `opened` ourselves.
              if (!opened) {
                setSelected(null);
                onOpen();
              }
              setOpened((o) => !o);
            }}
          >
            <IconHistory size={16} />
          </ActionIcon>
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
                      {v.version === currentVersion && (
                        <Badge size="xs" variant="light" color="sandstone">current</Badge>
                      )}
                    </UnstyledButton>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              {preview && (
                <>
                  <FieldDiffList from={current} to={preview} />
                  <Button
                    size="xs"
                    disabled={preview.version === currentVersion}
                    onClick={() => {
                      onRestore(preview);
                      setOpened(false);
                    }}
                  >
                    Restore v{preview.version}
                  </Button>
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

  // Selected key: `own:<id>` | `shared:<ownerId>/<id>` | null (creating new).
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  const dirty = useMemo(
    () => (draft && baseline ? snapshot(draft) !== baseline : false),
    [draft, baseline],
  );
  // A name outside the read regex can never be referenced as {outputs.<name>}.
  const outputNameError =
    draft && (draft.outputName ?? '').trim() && !OUTPUT_NAME_RE.test((draft.outputName ?? '').trim())
      ? OUTPUT_NAME_HINT
      : undefined;
  const valid =
    !!draft && draft.name.trim() !== '' && draft.promptTemplate.trim() !== '' && !outputNameError;

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

  /** Load an older version's content into the draft; Save republishes it as a new head version. */
  const restore = (def: StepDef) => patch(content(def));

  const newStep = () => load({ ...BLANK }, null);

  const save = () => {
    if (!draft || readOnly || !valid) return;
    const stepId = draft.id ?? crypto.randomUUID();
    const published = draft.published ?? false;
    send({ type: 'saveStep', step: content(draft), stepId, published, ownerName: getOwnerName() ?? undefined });
    // Select the (soon-updated) own step; the broadcast refreshes its version.
    load({ ...draft, id: stepId, published }, `own:${stepId}`);
  };

  const duplicate = () => {
    if (!draft) return;
    load({ ...content(draft), name: `${draft.name} (copy)` }, null);
  };

  const doDelete = () => {
    setConfirmDelete(false);
    if (!draft?.id) return;
    send({ type: 'deleteStep', stepId: draft.id });
    load(steps.find((s) => s.id !== draft.id) ?? null, null);
  };

  const StepButton = ({ def, key: k }: { def: StepDef; key: string }) => (
    <Button
      variant={selected === k ? 'light' : 'subtle'}
      color="gray"
      justify="start"
      onClick={() => load(def, k)}
    >
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0, width: '100%' }} justify="space-between">
        <Text size="xs" truncate>{def.name}</Text>
        <Badge size="xs" variant="default">v{def.version}</Badge>
      </Group>
    </Button>
  );

  return (
    <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
      <Box p="md" style={{ display: 'flex' }}>
        <Stack gap="xs" w={240} style={{ flexShrink: 0 }} h="100%">
          <ScrollArea style={{ flex: 1 }} type="hover">
            <Stack gap="xs" pr="xs">
              {steps.map((s) => (
                <StepButton key={`own:${s.id}`} def={s} />
              ))}
              {steps.length === 0 && (
                <Text size="xs" c="dimmed" py="sm" ta="center">No steps yet.</Text>
              )}
              {foreignSteps.length > 0 && (
                <>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="xs">Shared by others</Text>
                  {foreignSteps.map((s) => (
                    <Button
                      key={`shared:${s.ownerId}/${s.id}`}
                      variant={selected === `shared:${s.ownerId}/${s.id}` ? 'light' : 'subtle'}
                      color="gray"
                      justify="start"
                      onClick={() => load(s, `shared:${s.ownerId}/${s.id}`)}
                    >
                      <Stack gap={0} style={{ minWidth: 0 }}>
                        <Text size="xs" truncate>{s.name}</Text>
                        <Text fz={10} c="dimmed" truncate>{s.ownerName ?? 'Unknown'} · v{s.version}</Text>
                      </Stack>
                    </Button>
                  ))}
                </>
              )}
            </Stack>
          </ScrollArea>
          <Button variant="default" leftSection={<IconPlus size={13} />} onClick={newStep}>
            New step
          </Button>
        </Stack>
      </Box>
      <Divider orientation="vertical" />

      {draft ? (
        <ScrollArea style={{ flex: 1 }} type="hover">
          <Stack gap="sm" p="md">
            <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
              <TextInput
                label="Step name"
                style={{ flex: 1 }}
                value={draft.name}
                disabled={readOnly}
                onChange={(e) => patch({ name: e.currentTarget.value })}
              />
              {draft.id && (
                <Badge variant="default" mb={6} style={{ whiteSpace: 'nowrap' }}>
                  v{draft.version ?? 1}
                </Badge>
              )}
              {draft.id && !readOnly && (
                <RestoreHistoryPopover
                  current={content(draft)}
                  currentVersion={draft.version}
                  versions={versionsFor(draft)}
                  onOpen={requestVersions}
                  onRestore={restore}
                />
              )}
              {stepRow?.createdAt !== undefined && (
                <Stack gap={0} pb={8} style={{ whiteSpace: 'nowrap' }}>
                  <Text size="xs" c="dimmed">Created {formatTimestamp(stepRow.createdAt)}</Text>
                  <Text size="xs" c="dimmed">Updated {formatTimestamp(stepRow.updatedAt)}</Text>
                </Stack>
              )}
              {readOnly ? (
                <Text size="xs" c="dimmed" pb={8} style={{ whiteSpace: 'nowrap' }}>
                  Shared by {draft.ownerName ?? 'another user'}
                </Text>
              ) : (
                <Switch
                  mb={7}
                  label="Published"
                  description="Share with everyone"
                  checked={draft.published ?? false}
                  onChange={(e) => patch({ published: e.currentTarget.checked })}
                />
              )}
            </Group>

            <Box>
              <div className={styles.label}>Prompt</div>
              <PromptEditor
                value={draft.promptTemplate}
                readOnly={readOnly}
                inputClassName={styles.promptInput}
                freshStart={draft.freshStart}
                onChange={(v) => patch({ promptTemplate: v })}
              />
            </Box>

            <div className={styles.settings}>
              <div className={styles.control}>
                <span className={styles.controlLabel}>Model</span>
                <Select
                  w={168}
                  comboboxProps={modelComboboxProps}
                  // Any provider. A library step has no predecessor to cross, so
                  // the fresh-start rule is applied where it is knowable: on the
                  // step's position in a workflow, in StepCard.
                  data={modelSelectData(models, draft.model)}
                  renderOption={renderModelOption}
                  value={draft.model}
                  disabled={readOnly}
                  allowDeselect={false}
                  classNames={{ input: styles.fieldInput }}
                  onChange={(v) => v && patch({ model: v })}
                />
              </div>
              <div className={styles.control}>
                <span className={styles.controlLabel}>Permission mode</span>
                <Select
                  w={158}
                  comboboxProps={modelComboboxProps}
                  data={PERMISSION_MODES}
                  renderOption={renderPermissionModeOption}
                  value={draft.permissionMode}
                  disabled={readOnly}
                  allowDeselect={false}
                  classNames={{ input: styles.fieldInput }}
                  onChange={(v) => v && patch({ permissionMode: v as PermissionMode })}
                />
              </div>
              <Switch
                label="Auto-advance"
                description="Skip approval; run the next step automatically"
                checked={draft.autoAdvance}
                disabled={readOnly}
                onChange={(e) => patch({ autoAdvance: e.currentTarget.checked })}
              />
              <Switch
                label="Fresh start"
                description="Run in a clean session; seed with prior step's output + diff, not the full conversation"
                checked={draft.freshStart}
                disabled={readOnly}
                onChange={(e) => patch({ freshStart: e.currentTarget.checked })}
              />
              <div className={styles.control}>
                <span className={styles.controlLabel}>Output name</span>
                <TextInput
                  w={158}
                  placeholder="e.g. plan"
                  value={draft.outputName ?? ''}
                  disabled={readOnly}
                  error={outputNameError}
                  classNames={{ input: styles.fieldInput }}
                  onChange={(e) => patch({ outputName: e.currentTarget.value })}
                />
              </div>
            </div>

            {readOnly ? (
              <Group justify="flex-end">
                <Button variant="default" leftSection={<IconCopy size={13} />} onClick={duplicate}>
                  Duplicate to my steps
                </Button>
              </Group>
            ) : (
              <Group justify="space-between">
                {draft.id ? (
                  <Button variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                ) : (
                  <span />
                )}
                <Group gap="xs">
                  <Button variant="default" leftSection={<IconCopy size={13} />} onClick={duplicate}>
                    Duplicate
                  </Button>
                  <Button disabled={!valid || (!!draft.id && !dirty)} onClick={save}>
                    {draft.id ? (dirty ? 'Save changes' : 'Saved') : 'Save step'}
                  </Button>
                </Group>
              </Group>
            )}
          </Stack>
        </ScrollArea>
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }} gap="xs">
          <Text size="sm" c="dimmed">Select a step or create a new one.</Text>
          <Button variant="light" leftSection={<IconPlus size={13} />} onClick={newStep}>
            New step
          </Button>
        </Stack>
      )}

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
