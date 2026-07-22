import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import type { PermissionMode, WorkflowDef, WorkflowStep } from '@claude-ui/shared';
import { DEFAULT_MODEL } from '@claude-ui/shared';
import { useStore } from '../store';
import { send } from '../ws';

const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Agent' },
  { value: 'auto', label: 'Auto (guarded)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

function emptyStep(): WorkflowStep {
  return {
    name: 'New step',
    promptTemplate: '',
    model: DEFAULT_MODEL,
    permissionMode: 'default',
    autoAdvance: false,
  };
}

export function WorkflowEditor({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const workflows = useStore((s) => s.workflows);
  const models = useStore((s) => s.models);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDef | null>(null);

  useEffect(() => {
    if (!opened) return;
    setSelectedId((prev) => {
      const source = workflows.find((w) => w.id === prev) ?? workflows[0] ?? null;
      setDraft(source ? structuredClone(source) : null);
      return source?.id ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, workflows.length]);

  const newWorkflow = () => {
    const wf: WorkflowDef = { id: '', name: 'New workflow', steps: [emptyStep()] };
    setSelectedId(null);
    setDraft(wf);
  };

  const updateStep = (i: number, patch: Partial<WorkflowStep>) => {
    if (!draft) return;
    const steps = draft.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    setDraft({ ...draft, steps });
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    if (!draft) return;
    const j = i + dir;
    if (j < 0 || j >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setDraft({ ...draft, steps });
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Workflows" size="xl" centered>
      <Group align="flex-start" gap="md" wrap="nowrap">
        <Stack gap="xs" w={200} style={{ flexShrink: 0 }}>
          {workflows.map((w) => (
            <Button
              key={w.id}
              variant={w.id === selectedId ? 'light' : 'subtle'}
              color="gray"
              justify="start"
              onClick={() => {
                setSelectedId(w.id);
                setDraft(structuredClone(w));
              }}
            >
              <Text size="xs" truncate>
                {w.name}
              </Text>
            </Button>
          ))}
          <Button variant="default" leftSection={<IconPlus size={13} />} onClick={newWorkflow}>
            New workflow
          </Button>
        </Stack>
        <Divider orientation="vertical" />
        {draft ? (
          <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
            <TextInput
              label="Workflow name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
            {draft.steps.map((step, i) => (
              <Paper key={i} withBorder radius="md" p="sm">
                <Group justify="space-between" mb={6}>
                  <TextInput
                    w={220}
                    value={step.name}
                    onChange={(e) => updateStep(i, { name: e.currentTarget.value })}
                  />
                  <Group gap={4}>
                    <Tooltip label="Move up">
                      <ActionIcon size="sm" variant="subtle" onClick={() => moveStep(i, -1)}>
                        <IconArrowUp size={13} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Move down">
                      <ActionIcon size="sm" variant="subtle" onClick={() => moveStep(i, 1)}>
                        <IconArrowDown size={13} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Remove step">
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) })
                        }
                      >
                        <IconTrash size={13} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
                <Textarea
                  autosize
                  minRows={2}
                  maxRows={6}
                  placeholder="Step prompt. {task} = user task, {feedback} = retry feedback."
                  value={step.promptTemplate}
                  onChange={(e) => updateStep(i, { promptTemplate: e.currentTarget.value })}
                  mb={6}
                />
                <Group gap="xs">
                  <Select
                    w={140}
                    data={models.map((m) => ({ value: m.id, label: m.label }))}
                    value={step.model}
                    onChange={(v) => v && updateStep(i, { model: v })}
                    allowDeselect={false}
                  />
                  <Select
                    w={130}
                    data={MODE_OPTIONS}
                    value={step.permissionMode}
                    onChange={(v) => v && updateStep(i, { permissionMode: v as PermissionMode })}
                    allowDeselect={false}
                  />
                  <Switch
                    size="xs"
                    label="Auto-advance"
                    checked={step.autoAdvance}
                    onChange={(e) => updateStep(i, { autoAdvance: e.currentTarget.checked })}
                  />
                </Group>
              </Paper>
            ))}
            <Button
              variant="default"
              leftSection={<IconPlus size={13} />}
              onClick={() => setDraft({ ...draft, steps: [...draft.steps, emptyStep()] })}
            >
              Add step
            </Button>
            <Group justify="space-between">
              {selectedId ? (
                <Button
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    if (confirm('Delete this workflow?')) {
                      send({ type: 'deleteWorkflow', workflowId: selectedId });
                      setSelectedId(null);
                      setDraft(null);
                    }
                  }}
                >
                  Delete workflow
                </Button>
              ) : (
                <span />
              )}
              <Button
                disabled={draft.steps.length === 0 || !draft.name.trim()}
                onClick={() => {
                  send({ type: 'saveWorkflow', workflow: draft });
                  onClose();
                }}
              >
                Save workflow
              </Button>
            </Group>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" pt="lg">
            Select or create a workflow.
          </Text>
        )}
      </Group>
    </Modal>
  );
}
