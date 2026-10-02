import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconChevronDown,
  IconCopy,
  IconLibrary,
  IconLock,
  IconPlus,
  IconSettings,
  IconTemplate,
  IconTrash,
} from '@tabler/icons-react';
import type { StepContent, StepDef } from '@lines/shared';
import { formatTimestamp, isStepRef } from '@lines/shared';
import { useStore } from '../../store';
import { useIsPhone } from '../../lib/layout';
import { MOD } from '../../lib/platform';
import { BestOnDesktop } from '../BestOnDesktop';
import { ConfirmModal } from '../ConfirmModal';
import { WORKFLOW_PRESETS } from '../../lib/workflowPresets';
import type { DraftWorkflow } from './useWorkflowDraft';
import { useWorkflowDraft } from './useWorkflowDraft';
import { WorkflowList } from './WorkflowList';
import { StepLibrary } from './StepLibrary';
import { StepCard } from './StepCard';
import { StepOutline } from './StepOutline';
import { StepBanner } from './StepPane';
import { RecipeLibrary } from '../recipe/RecipeLibrary';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

/** Which library the modal opens on. */
export type WorkflowEditorView = 'workflows' | 'steps' | 'recipes';

/** "Add step": blank, pinned from a library, or copied from a preset's steps. */
function AddStepMenu({
  ownSteps,
  sharedSteps,
  onBlank,
  onPick,
  onPreset,
}: {
  ownSteps: StepDef[];
  sharedSteps: StepDef[];
  onBlank: () => void;
  onPick: (def: StepDef) => void;
  onPreset: (content: StepContent) => void;
}) {
  const byOwner = new Map<string, StepDef[]>();
  // Own beats shared: a step id in both lists is the user's own (a stale shared
  // snapshot), so it is offered once, under their library.
  for (const s of sharedSteps.filter((sh) => !ownSteps.some((own) => own.id === sh.id))) {
    const key = s.ownerName ?? 'Unknown';
    (byOwner.get(key) ?? byOwner.set(key, []).get(key)!).push(s);
  }
  const StepItem = (s: StepDef) => (
    <Menu.Item
      key={`${s.ownerId}/${s.id}`}
      onClick={() => onPick(s)}
      rightSection={
        <Text fz={11} c="dimmed">
          v{s.version}
        </Text>
      }
    >
      <Text size="sm" truncate>{s.name}</Text>
    </Menu.Item>
  );
  return (
    <Menu position="bottom-start" width={220} shadow="md" withinPortal>
      <Menu.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<IconPlus size={12} />}
          rightSection={<IconChevronDown size={12} />}
        >
          Add step
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconPlus size={14} />} onClick={onBlank}>
          Blank step
        </Menu.Item>
        {(ownSteps.length > 0 || byOwner.size > 0) && (
          <Menu.Sub>
            <Menu.Sub.Target>
              <Menu.Sub.Item leftSection={<IconLibrary size={14} />}>From a library</Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown w={280} mah={380} style={{ overflowY: 'auto' }}>
              {ownSteps.length > 0 && (
                <>
                  <Menu.Label>Your library</Menu.Label>
                  {ownSteps.map(StepItem)}
                </>
              )}
              {byOwner.size > 0 && <Menu.Label>Shared by others</Menu.Label>}
              {[...byOwner.entries()].map(([owner, list]) => (
                <Box key={owner}>
                  <Text size="10px" c="dimmed" px="sm" pt={4} tt="uppercase" fw={600}>
                    {owner}
                  </Text>
                  {list.map(StepItem)}
                </Box>
              ))}
            </Menu.Sub.Dropdown>
          </Menu.Sub>
        )}
        <Menu.Sub>
          <Menu.Sub.Target>
            <Menu.Sub.Item leftSection={<IconTemplate size={14} />}>From a preset</Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown w={240} mah={380} style={{ overflowY: 'auto' }}>
            {WORKFLOW_PRESETS.map((p) => (
              <Box key={p.id}>
                <Menu.Label>{p.name}</Menu.Label>
                {p.steps
                  .filter((s): s is StepContent => !isStepRef(s))
                  .map((s, j) => (
                    <Menu.Item key={j} onClick={() => onPreset(s)}>
                      <Text size="sm" truncate>{s.name}</Text>
                    </Menu.Item>
                  ))}
              </Box>
            ))}
          </Menu.Sub.Dropdown>
        </Menu.Sub>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * What the pane shows with no step picked: the workflow's own settings — its
 * name, who sees it, whether pinned steps have moved on — and how to read the
 * outline beside it.
 */
function WorkflowOverview({
  draft,
  readOnly,
  nameError,
  updatesAvailable,
  onPatch,
  onUpdateAll,
}: {
  draft: DraftWorkflow;
  readOnly: boolean;
  nameError?: string;
  updatesAvailable: number;
  onPatch: (patch: Partial<DraftWorkflow>) => void;
  onUpdateAll: () => void;
}) {
  const n = draft.steps.length;
  return (
    <div className={styles.pane}>
      <div>
        <div className={styles.label}>Workflow</div>
        <TextInput
          variant="unstyled"
          placeholder="Workflow name"
          aria-label="Workflow name"
          classNames={{ input: styles.titleInput }}
          value={draft.name}
          readOnly={readOnly}
          error={nameError}
          onChange={(e) => onPatch({ name: e.currentTarget.value })}
        />
        {/* Nothing at all for an unsaved new workflow — it has no birthday yet. */}
        {draft.createdAt !== undefined && (
          <Text fz={11} c="dimmed" mt={2}>
            Created {formatTimestamp(draft.createdAt)} · Updated {formatTimestamp(draft.updatedAt)}
          </Text>
        )}
      </div>
      {readOnly ? (
        <StepBanner icon={<IconLock size={14} />}>
          Shared by <b>{draft.ownerName ?? 'another user'}</b>, read-only. Make an editable copy to change it.
        </StepBanner>
      ) : (
        <Switch
          label="Share with everyone"
          description="Others see it under Shared by others and can run it."
          checked={draft.published ?? false}
          onChange={(e) => onPatch({ published: e.currentTarget.checked })}
        />
      )}
      {updatesAvailable > 0 && !readOnly && (
        <StepBanner
          icon={<IconAlertTriangle size={14} />}
          actions={
            <Button size="compact-xs" variant="light" color="yellow" onClick={onUpdateAll}>
              Update all
            </Button>
          }
        >
          {updatesAvailable} pinned step{updatesAvailable === 1 ? ' has' : 's have'} a newer version. Update all
          re-pins without reviewing each change — open a step to see its diff first.
        </StepBanner>
      )}
      <Text size="sm" c="dimmed" maw={560}>
        {n === 0
          ? 'No steps yet — add one at the bottom of the flow.'
          : `${n} step${n === 1 ? '' : 's'}, run top to bottom. Pick one on the left to edit its prompt and settings. The line between two steps says whether the first waits for your approval and how the next one starts; click it to change either.`}
      </Text>
    </div>
  );
}

export function WorkflowEditor({
  opened,
  onClose,
  initialView = 'workflows',
}: {
  opened: boolean;
  onClose: () => void;
  initialView?: WorkflowEditorView;
}) {
  const models = useStore((s) => s.models);
  const isPhone = useIsPhone();
  const [view, setView] = useState<WorkflowEditorView>(initialView);
  const wf = useWorkflowDraft(opened, onClose);
  const { draft, readOnly, validation, submitAttempted, selectedStep } = wf;
  const [confirmUnpublished, setConfirmUnpublished] = useState(false);

  // Each open honours the entry point (the sidebar has one icon per library);
  // the tab the user picked while it was open is not worth remembering.
  useEffect(() => {
    if (opened) setView(initialView);
  }, [opened, initialView]);

  const selectStep = (uid: string | null) => {
    wf.selectStep(uid);
    if (!uid) return;
    requestAnimationFrame(() =>
      document.querySelector(`[data-step-uid="${uid}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  };

  const updatesAvailable = draft?.steps.filter((s) => wf.updateFor(s)).length ?? 0;

  // Steps opened for editing from the library and not saved back there. Saving
  // the workflow stores them as its own copies; the library step stays as it was.
  const unpublished = draft?.steps.filter((s) => !s.ref && s.publishStepId) ?? [];

  const requestSave = () => {
    if (!draft || readOnly || !wf.dirty) return;
    // Validation first: confirming a save that then fails to validate asks the
    // wrong question. `save()` is what reports the errors.
    if (validation?.ok && unpublished.length > 0) setConfirmUnpublished(true);
    else wf.save();
  };

  const saveHotkey =
    opened &&
    !isPhone &&
    view === 'workflows' &&
    !!draft &&
    !readOnly &&
    !wf.pendingAction &&
    !wf.confirmDelete &&
    !confirmUnpublished;
  useHotkeys(
    [['mod+S', () => saveHotkey && requestSave(), { preventDefault: saveHotkey }]],
    [], // from the prompt and name fields too — that is where the edits happen
    true,
  );

  const shownErrors = submitAttempted && validation && !validation.ok ? validation : undefined;
  const failing = draft && shownErrors ? draft.steps.filter((s) => shownErrors.steps[s._uid]) : [];

  if (isPhone) {
    // A three-pane editor. Nothing here is reachable at 390px, and a
    // phone-shaped rewrite would be a second editor to keep in step with this one.
    return (
      <Modal opened={opened} onClose={onClose} title="Workflows, steps & recipes" fullScreen>
        <BestOnDesktop what="Editing workflows" onClose={onClose} />
      </Modal>
    );
  }

  const stepIndex = draft ? draft.steps.findIndex((s) => s._uid === selectedStep) : -1;
  const step = draft && stepIndex >= 0 ? draft.steps[stepIndex] : undefined;
  const unpublishedNames = unpublished.map((s) => `“${s.name.trim() || 'Untitled step'}”`).join(', ');

  return (
    <>
      <Modal
        opened={opened}
        onClose={wf.requestClose}
        title="Workflows, steps & recipes"
        size="90%"
        centered
        padding={0}
        transitionProps={{ transition: 'fade' }}
        styles={{
          content: { height: '88vh', display: 'flex', flexDirection: 'column' },
          body: { flex: 1, minHeight: 0, display: 'flex', padding: 0 },
          header: { padding: 'var(--mantine-spacing-md)', paddingBottom: 'var(--mantine-spacing-xs)' },
        }}
      >
        <Stack gap={0} style={{ flex: 1, minHeight: 0, width: '100%' }}>
          <Box px="md" pt={4} pb="xs">
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as WorkflowEditorView)}
              data={[
                { value: 'workflows', label: 'Workflows' },
                { value: 'steps', label: 'Steps' },
                { value: 'recipes', label: 'Recipes' },
              ]}
            />
          </Box>
          <Divider />
          {view === 'steps' ? (
            <StepLibrary />
          ) : view === 'recipes' ? (
            // Plain onClose, not wf.requestClose: a run is not a workflow-draft
            // edit, so it must not raise the discard-changes prompt.
            <RecipeLibrary onRan={onClose} />
          ) : (
        <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
          <WorkflowList
            workflows={wf.workflows}
            sharedWorkflows={wf.sharedWorkflows}
            selectedId={wf.selectedId}
            dirty={wf.dirty}
            onSelect={wf.select}
            onNew={wf.newFromPreset}
          />
          <Divider orientation="vertical" />
          {draft ? (
            <Stack gap={0} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
                {/* The outline: the workflow itself, then its steps in run order. */}
                <div className={styles.listColumn} style={{ width: 'clamp(290px, 23vw, 344px)' }}>
                  <Box px={10} pt={10}>
                    <UnstyledButton
                      className={cn(styles.listRow, selectedStep === null && styles.rowActive)}
                      aria-current={selectedStep === null ? 'page' : undefined}
                      onClick={() => selectStep(null)}
                    >
                      <span className={styles.rowText}>
                        <span className={styles.rowName}>{draft.name.trim() || 'Untitled workflow'}</span>
                        <span className={cn(styles.rowMeta, !!shownErrors?.name && styles.rowMetaError)}>
                          {shownErrors?.name ??
                            `${draft.steps.length} step${draft.steps.length === 1 ? '' : 's'}${
                              readOnly
                                ? ` · by ${draft.ownerName ?? 'another user'}`
                                : draft.published
                                  ? ' · shared with everyone'
                                  : ''
                            }`}
                        </span>
                      </span>
                      {updatesAvailable > 0 && !readOnly && (
                        <Tooltip label={`${updatesAvailable} pinned step${updatesAvailable === 1 ? ' has' : 's have'} a newer version`} withArrow>
                          <span className={styles.updateDot} />
                        </Tooltip>
                      )}
                      <Tooltip label="Workflow settings" withArrow>
                        <span className={styles.rowAside}>
                          <IconSettings size={14} />
                        </span>
                      </Tooltip>
                    </UnstyledButton>
                  </Box>
                  <ScrollArea style={{ flex: 1 }} type="hover">
                    <div className={styles.listBody}>
                      <StepOutline
                        steps={draft.steps}
                        selected={selectedStep}
                        readOnly={readOnly}
                        models={models}
                        errors={shownErrors?.steps}
                        ownsRef={wf.ownsRef}
                        updateFor={wf.updateFor}
                        isUnavailable={(s) => !!s.ref && !wf.resolveRef(s.ref)}
                        onSelect={selectStep}
                        onPatch={wf.updateStep}
                        onReorder={wf.reorder}
                        empty={
                          <Text size="xs" c={shownErrors?.noSteps ? 'red' : 'dimmed'} px={10} py={6}>
                            {validation?.noSteps ?? 'No steps yet.'}
                          </Text>
                        }
                        addStep={
                          readOnly ? undefined : (
                            <AddStepMenu
                              ownSteps={wf.steps}
                              sharedSteps={wf.sharedSteps}
                              onBlank={() => selectStep(wf.addStep())}
                              onPick={(def) => selectStep(wf.addSharedStep(def))}
                              onPreset={(content) => selectStep(wf.addStep(content))}
                            />
                          )
                        }
                      />
                    </div>
                  </ScrollArea>
                </div>
                <Divider orientation="vertical" />
                {step ? (
                  <StepCard
                    // Per step: the pane's own state (the history popover, the
                    // Advanced disclosure) belongs to the step it was opened for.
                    key={step._uid}
                    step={step}
                    index={stepIndex}
                    total={draft.steps.length}
                    previousModel={draft.steps[stepIndex - 1]?.model}
                    availableOutputs={draft.steps
                      .slice(0, stepIndex)
                      .map((s) => s.outputName?.trim())
                      .filter((n): n is string => !!n)}
                    errors={shownErrors?.steps[step._uid]}
                    readOnly={readOnly}
                    models={models}
                    ownsRef={wf.ownsRef(step)}
                    updateDef={wf.updateFor(step)}
                    editingFrom={step.publishStepId ? wf.steps.find((s) => s.id === step.publishStepId) : undefined}
                    unavailable={!!step.ref && !wf.resolveRef(step.ref)}
                    onPatch={(patch) => wf.updateStep(step._uid, patch)}
                    onDuplicate={() => wf.duplicateStep(step._uid)}
                    onRemove={() => wf.removeStep(step._uid)}
                    onPublish={() => wf.publishStep(step._uid)}
                    onEdit={() => wf.editStep(step._uid)}
                    onDetach={() => wf.detachStep(step._uid)}
                    onMove={(delta) => wf.reorder(stepIndex, stepIndex + delta)}
                    onUpdateToLatest={() => wf.updateStepToLatest(step._uid)}
                    versions={wf.versionsFor(step)}
                    onShowVersions={() => wf.requestStepVersions(step)}
                    onPinVersion={(def) => wf.pinStepToVersion(step._uid, def)}
                  />
                ) : (
                  <WorkflowOverview
                    draft={draft}
                    readOnly={readOnly}
                    nameError={submitAttempted ? validation?.name : undefined}
                    updatesAvailable={updatesAvailable}
                    onPatch={wf.patchDraft}
                    onUpdateAll={wf.updateAllToLatest}
                  />
                )}
              </Group>

              <Divider />
              {/* Footer */}
              {readOnly ? (
                <Group justify="flex-end" px="md" py={10}>
                  <Button variant="default" leftSection={<IconCopy size={13} />} onClick={wf.duplicate}>
                    Make an editable copy
                  </Button>
                </Group>
              ) : (
                <Group justify="space-between" wrap="nowrap" px="md" py={10}>
                  <Group gap="xs" wrap="nowrap">
                    <Button variant="default" leftSection={<IconCopy size={13} />} onClick={wf.duplicate}>
                      Duplicate
                    </Button>
                    {wf.selectedId && (
                      <Button variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={wf.requestDelete}>
                        Delete
                      </Button>
                    )}
                  </Group>
                  <Group gap="sm" wrap="nowrap">
                    {failing.length > 0 ? (
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        color="red"
                        leftSection={<IconAlertCircle size={14} />}
                        onClick={() => selectStep(failing[0]!._uid)}
                      >
                        {failing.length} step{failing.length === 1 ? ' needs' : 's need'} attention
                      </Button>
                    ) : shownErrors ? (
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        color="red"
                        leftSection={<IconAlertCircle size={14} />}
                        onClick={() => selectStep(null)}
                      >
                        {shownErrors.name ?? shownErrors.noSteps}
                      </Button>
                    ) : null}
                    {wf.dirty && (
                      <Group gap={6} wrap="nowrap">
                        <Box
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: 'var(--mantine-primary-color-filled)',
                          }}
                        />
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                          Unsaved changes · {MOD}S
                        </Text>
                      </Group>
                    )}
                    <Button disabled={!wf.dirty} onClick={requestSave}>
                      {wf.dirty ? 'Save changes' : 'Saved'}
                    </Button>
                  </Group>
                </Group>
              )}
            </Stack>
          ) : (
            <ScrollArea style={{ flex: 1 }} type="hover">
              <Stack gap="md" p="xl">
                <Text size="sm" fw={600}>
                  Start a new workflow
                </Text>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                  {WORKFLOW_PRESETS.map((p) => (
                    <Paper
                      key={p.id}
                      withBorder
                      radius="md"
                      p="md"
                      style={{ cursor: 'pointer' }}
                      onClick={() => wf.newFromPreset(p)}
                    >
                      <Group justify="space-between">
                        <Text size="sm" fw={600}>{p.name}</Text>
                        <Badge size="xs" variant="light" color="gray">{p.steps.length} steps</Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>{p.description}</Text>
                    </Paper>
                  ))}
                  <Paper
                    withBorder
                    radius="md"
                    p="md"
                    style={{ cursor: 'pointer', borderStyle: 'dashed' }}
                    onClick={() => wf.newFromPreset(null)}
                  >
                    <Text size="sm" fw={600}>Blank workflow</Text>
                    <Text size="xs" c="dimmed" mt={4}>Start from a single empty step.</Text>
                  </Paper>
                </SimpleGrid>
              </Stack>
            </ScrollArea>
          )}
        </Group>
          )}
        </Stack>
      </Modal>

      <ConfirmModal
        opened={wf.confirmDelete}
        title="Delete workflow"
        message={`Delete "${draft?.name ?? ''}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmColor="red"
        onConfirm={wf.deleteSelected}
        onCancel={wf.cancelDelete}
      />
      <ConfirmModal
        opened={!!wf.pendingAction}
        title="Discard changes"
        message="You have unsaved changes. Discard them?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        confirmColor="red"
        onConfirm={wf.confirmDiscard}
        onCancel={wf.cancelDiscard}
      />
      <ConfirmModal
        opened={confirmUnpublished}
        title="Library edits not saved"
        message={
          `${unpublishedNames} ${unpublished.length === 1 ? 'was' : 'were'} opened for editing from your library ` +
          `but not saved back there. Saving the workflow keeps ${unpublished.length === 1 ? 'that copy' : 'those copies'} ` +
          `in this workflow only — the library ${unpublished.length === 1 ? 'step stays as it is' : 'steps stay as they are'}.`
        }
        confirmLabel="Save workflow anyway"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setConfirmUnpublished(false);
          wf.save();
        }}
        onCancel={() => setConfirmUnpublished(false)}
      />
    </>
  );
}
