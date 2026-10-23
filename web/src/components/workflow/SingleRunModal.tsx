import { useEffect, useState } from 'react';
import { Anchor, Button, Group, Modal, SegmentedControl, Select, Stack, Switch, Text } from '@mantine/core';
import type { PermissionMode, ReasoningEffort, WorkflowDef, WorkflowStepOverride } from '@lines/shared';
import { capabilitiesForModel, providerForModel } from '@lines/shared';
import type { NewSessionDefaults } from '../../store';
import { useStore } from '../../store';
import {
  AUTO_EFFORT,
  effortSelectData,
  modelComboboxProps,
  modelSelectData,
  renderModelOption,
  renderOptionWithDescription,
} from '../../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../../lib/permissionModes';
import { effortForModel } from '../../lib/stepOverrides';
import { StepOverrideRows, useStepOverrideRows } from './WorkflowRunModal';

/**
 * What one Single run launch uses. `model` and `reasoningEffort` are present only
 * for a bare run (a workflow's first step seeds its own); `reasoningEffort`
 * undefined there means Auto, not "fall back to the default".
 */
export interface SingleRunChoice {
  workflowId?: string;
  stepOverrides?: (WorkflowStepOverride | null)[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode: PermissionMode;
  worktree: boolean;
}

/** Select value for "no workflow": Mantine treats an empty string as no selection. */
const BARE = '__bare__';

/**
 * The Cmd/Ctrl+click launcher on the sidebar's new-session entries: workflow or
 * bare, model and effort (bare), per-step models (workflow), permission mode and
 * worktree — for this one launch. Nothing here is written back: the caller must
 * not persist `lastChoice`, the new-session defaults or the worktree switch.
 */
export function SingleRunModal({
  workflows,
  ownWorkflows,
  foreignWorkflows,
  resolveWorkflow,
  initialWorkflowId,
  defaults,
  worktree,
  onConfirm,
  onClose,
}: {
  /** The library this machine runs from (the host's on a shared machine). */
  workflows: WorkflowDef[];
  /** On a shared machine, the user's own workflows that travel inline. */
  ownWorkflows: WorkflowDef[];
  foreignWorkflows: WorkflowDef[];
  /** The def a launch would run — the inlined one for an own workflow. */
  resolveWorkflow: (id: string) => WorkflowDef | undefined;
  /** '' = bare session. */
  initialWorkflowId: string;
  defaults: NewSessionDefaults;
  worktree: boolean;
  onConfirm: (choice: SingleRunChoice) => void;
  onClose: () => void;
}) {
  const models = useStore((s) => s.models);
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);

  const seedEffort = defaults.reasoningEffort ?? AUTO_EFFORT;
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState<string>(seedEffort);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(defaults.permissionMode);
  const [inWorktree, setInWorktree] = useState(worktree);

  const workflow = workflowId ? resolveWorkflow(workflowId) : undefined;
  const rows = useStepOverrideRows(workflow);

  // A different workflow has different steps: its rows start from its own values.
  // Keyed on the id: `resolveWorkflow` may build a fresh (inlined) def per render.
  useEffect(() => {
    rows.reseed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const efforts = capabilitiesForModel(model, providerForModel).reasoningEfforts;

  const reset = () => {
    setWorkflowId(initialWorkflowId);
    setModel(defaults.model);
    setEffort(seedEffort);
    setPermissionMode(defaults.permissionMode);
    setInWorktree(worktree);
    // Same workflow as before: the effect above won't fire, so reseed here too.
    if (workflowId === initialWorkflowId) rows.reseed();
  };

  const confirm = () => {
    const choice: SingleRunChoice = workflow
      ? {
          workflowId: workflow.id,
          stepOverrides: rows.overrides(),
          permissionMode,
          worktree: inWorktree,
        }
      : {
          model,
          reasoningEffort: effort === AUTO_EFFORT ? undefined : (effort as ReasoningEffort),
          permissionMode,
          worktree: inWorktree,
        };
    onConfirm(choice);
    onClose();
  };

  const item = (w: WorkflowDef) => ({ value: w.id, label: w.name });
  const workflowData = [
    { value: BARE, label: 'Bare session' },
    ...(workflows.length + ownWorkflows.length
      ? [{ group: 'Workflows', items: [...workflows, ...ownWorkflows].map(item) }]
      : []),
    ...(foreignWorkflows.length ? [{ group: 'Shared by others', items: foreignWorkflows.map(item) }] : []),
  ];

  return (
    <Modal opened onClose={onClose} title="Single run" size="lg" centered transitionProps={{ transition: 'fade' }}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          These choices apply to this session only. Your defaults and last-used workflow stay as they are.
        </Text>
        <Select
          label="Workflow"
          size="xs"
          data={workflowData}
          value={workflowId || BARE}
          allowDeselect={false}
          onChange={(v) => typeof v === 'string' && setWorkflowId(v === BARE ? '' : v)}
        />
        {workflow ? (
          <StepOverrideRows state={rows} />
        ) : (
          <Group gap="xs" grow wrap="nowrap">
            <Select
              label="Model"
              size="xs"
              comboboxProps={modelComboboxProps}
              // Both providers, as in the new-session defaults: a bare run may use
              // OpenAI, shown disabled while no account is connected.
              data={modelSelectData(models, model, {
                ...(openaiConnected
                  ? {}
                  : { unavailable: { openai: 'Connect an OpenAI account in Settings' } }),
              })}
              renderOption={renderModelOption}
              value={model}
              allowDeselect={false}
              onChange={(v) => {
                if (!v) return;
                setModel(v);
                setEffort((e) => effortForModel(e, capabilitiesForModel(v, providerForModel).reasoningEfforts));
              }}
            />
            <Select
              label="Reasoning effort"
              size="xs"
              comboboxProps={modelComboboxProps}
              data={effortSelectData(efforts, effort)}
              renderOption={renderOptionWithDescription}
              value={effort}
              allowDeselect={false}
              onChange={(v) => v && setEffort(v)}
            />
          </Group>
        )}
        <Stack gap={4}>
          <Text size="xs" fw={500}>
            Permission mode
          </Text>
          <SegmentedControl
            size="xs"
            fullWidth
            data={PERMISSION_MODE_SEGMENTS}
            value={permissionMode}
            onChange={(v) => setPermissionMode(v as PermissionMode)}
          />
        </Stack>
        <Switch
          size="xs"
          label="Run in a new worktree"
          description="Work is committed to a separate branch"
          checked={inWorktree}
          onChange={(e) => setInWorktree(e.currentTarget.checked)}
        />
        <Group justify="space-between" mt="xs">
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={reset}>
            Reset
          </Anchor>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={confirm}>Start session</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
