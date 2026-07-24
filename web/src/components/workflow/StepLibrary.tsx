import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import type { PermissionMode, StepContent, StepDef } from '@claude-ui/shared';
import { DEFAULT_MODEL } from '@claude-ui/shared';
import { useStore } from '../../store';
import { getOwnerName } from '../../lib/clerk';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../../lib/modelSelect';
import { send } from '../../ws';
import { ConfirmModal } from '../ConfirmModal';
import { MODE_OPTIONS } from './useWorkflowDraft';
import { PromptEditor } from './PromptEditor';
import styles from './workflow.module.css';

type Draft = StepContent & {
  id?: string;
  ownerId?: string;
  ownerName?: string;
  version?: number;
  published?: boolean;
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

export function StepLibrary() {
  const steps = useStore((s) => s.steps);
  const sharedSteps = useStore((s) => s.sharedSteps);
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
  const dirty = useMemo(
    () => (draft && baseline ? snapshot(draft) !== baseline : false),
    [draft, baseline],
  );
  const valid = !!draft && draft.name.trim() !== '' && draft.promptTemplate.trim() !== '';

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

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
              {sharedSteps.length > 0 && (
                <>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="xs">Shared by others</Text>
                  {sharedSteps.map((s) => (
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
                  data={modelSelectData(models)}
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
                  data={MODE_OPTIONS}
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
