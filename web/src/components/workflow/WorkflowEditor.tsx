import { useState } from 'react';
import {
  Alert,
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
} from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import type { StepDef } from '@claude-ui/shared';
import { useStore } from '../../store';
import { ConfirmModal } from '../ConfirmModal';
import { WORKFLOW_PRESETS } from '../../lib/workflowPresets';
import { useWorkflowDraft } from './useWorkflowDraft';
import { WorkflowList } from './WorkflowList';
import { StepLibrary } from './StepLibrary';
import { StepCard } from './StepCard';

/** "Add step" with a blank option plus my own steps and the shared library. */
function AddStepMenu({
  ownSteps,
  sharedSteps,
  onBlank,
  onPick,
}: {
  ownSteps: StepDef[];
  sharedSteps: StepDef[];
  onBlank: () => void;
  onPick: (def: StepDef) => void;
}) {
  const byOwner = new Map<string, StepDef[]>();
  for (const s of sharedSteps) {
    const key = s.ownerName ?? 'Unknown';
    (byOwner.get(key) ?? byOwner.set(key, []).get(key)!).push(s);
  }
  const StepItem = (s: StepDef) => (
    <Menu.Item
      key={`${s.ownerId}/${s.id}`}
      onClick={() => onPick(s)}
      rightSection={
        <Badge size="xs" variant="light" color={s.published ? 'sandstone' : 'gray'}>
          v{s.version}
        </Badge>
      }
    >
      <Text size="sm" truncate>{s.name}</Text>
    </Menu.Item>
  );
  return (
    <Menu position="top-start" width={280} withinPortal>
      <Menu.Target>
        <Button variant="default" leftSection={<IconPlus size={13} />} rightSection={<IconChevronDown size={13} />}>
          Add step
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={onBlank}>Blank step</Menu.Item>
        {ownSteps.length > 0 && (
          <>
            <Menu.Label>My steps</Menu.Label>
            {ownSteps.map(StepItem)}
          </>
        )}
        {byOwner.size > 0 && <Menu.Label>Shared steps</Menu.Label>}
        {[...byOwner.entries()].map(([owner, list]) => (
          <Box key={owner}>
            <Text size="10px" c="dimmed" px="sm" pt={4} tt="uppercase" fw={600}>
              {owner}
            </Text>
            {list.map(StepItem)}
          </Box>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

export function WorkflowEditor({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const models = useStore((s) => s.models);
  const [view, setView] = useState<'workflows' | 'steps'>('workflows');
  const wf = useWorkflowDraft(opened, onClose);
  const { draft, readOnly, validation, submitAttempted, collapsed } = wf;

  const selectStep = (uid: string) => {
    wf.expandStep(uid);
    requestAnimationFrame(() =>
      document.querySelector(`[data-step-uid="${uid}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    wf.reorder(result.source.index, result.destination.index);
  };

  const updatesAvailable = draft?.steps.filter((s) => wf.updateFor(s)).length ?? 0;

  return (
    <>
      <Modal
        opened={opened}
        onClose={wf.requestClose}
        title="Workflows & steps"
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
              onChange={(v) => setView(v as 'workflows' | 'steps')}
              data={[
                { value: 'workflows', label: 'Workflows' },
                { value: 'steps', label: 'Steps' },
              ]}
            />
          </Box>
          {view === 'steps' ? (
            <StepLibrary />
          ) : (
        <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
          <Box p="md" style={{ display: 'flex' }}>
            <WorkflowList
              workflows={wf.workflows}
              sharedWorkflows={wf.sharedWorkflows}
              selectedId={wf.selectedId}
              dirty={wf.dirty}
              onSelect={wf.select}
              onNew={wf.newFromPreset}
            />
          </Box>
          <Divider orientation="vertical" />
          {draft ? (
            <Stack gap="xs" p="md" style={{ flex: 1, minWidth: 0 }}>
              {/* Header */}
              <Group justify="space-between" align="flex-end" wrap="nowrap">
                <TextInput
                  label="Workflow name"
                  size="sm"
                  style={{ flex: 1 }}
                  value={draft.name}
                  disabled={readOnly}
                  error={submitAttempted ? validation?.name : undefined}
                  onChange={(e) => wf.patchDraft({ name: e.currentTarget.value })}
                />
                {readOnly ? (
                  <Text size="xs" c="dimmed" pb={8} style={{ whiteSpace: 'nowrap' }}>
                    Shared by {draft.ownerName ?? 'another user'}
                  </Text>
                ) : (
                  <Switch
                    pb={8}
                    label="Published"
                    checked={draft.published ?? false}
                    onChange={(e) => wf.patchDraft({ published: e.currentTarget.checked })}
                  />
                )}
              </Group>

              {updatesAvailable > 0 && (
                <Alert
                  variant="light"
                  color="yellow"
                  icon={<IconAlertTriangle size={16} />}
                  p="xs"
                >
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="xs">
                      {updatesAvailable} shared step{updatesAvailable === 1 ? '' : 's'} {updatesAvailable === 1 ? 'has' : 'have'} a newer version.
                    </Text>
                    <Button size="xs" variant="light" color="yellow" onClick={wf.updateAllToLatest}>
                      Update all
                    </Button>
                  </Group>
                </Alert>
              )}

              {/* Steps */}
              <ScrollArea style={{ flex: 1 }} type="hover">
                <DragDropContext onDragStart={wf.collapseAll} onDragEnd={onDragEnd}>
                  <Droppable droppableId="steps">
                    {(dropProvided) => (
                      <Stack gap="xs" ref={dropProvided.innerRef} {...dropProvided.droppableProps} pr="xs">
                        {draft.steps.map((step, i) => (
                          <Draggable key={step._uid} draggableId={step._uid} index={i} isDragDisabled={readOnly}>
                            {(dragProvided) => (
                              <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                                <StepCard
                                  step={step}
                                  index={i}
                                  availableOutputs={draft.steps
                                    .slice(0, i)
                                    .map((s) => s.outputName?.trim())
                                    .filter((n): n is string => !!n)}
                                  collapsed={collapsed.has(step._uid)}
                                  errors={submitAttempted ? validation?.steps[step._uid] : undefined}
                                  readOnly={readOnly}
                                  models={models}
                                  ownsRef={wf.ownsRef(step)}
                                  updateDef={wf.updateFor(step)}
                                  dragHandleProps={dragProvided.dragHandleProps}
                                  onPatch={(patch) => wf.updateStep(step._uid, patch)}
                                  onToggle={() => wf.toggleCollapsed(step._uid)}
                                  onExpand={() => wf.expandStep(step._uid)}
                                  onDuplicate={() => wf.duplicateStep(step._uid)}
                                  onRemove={() => wf.removeStep(step._uid)}
                                  onPublish={() => wf.publishStep(step._uid)}
                                  onEdit={() => wf.editStep(step._uid)}
                                  onUpdateToLatest={() => wf.updateStepToLatest(step._uid)}
                                  versions={wf.versionsFor(step)}
                                  onShowVersions={() => wf.requestStepVersions(step)}
                                  onPinVersion={(def) => wf.pinStepToVersion(step._uid, def)}
                                />
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {dropProvided.placeholder}
                        {draft.steps.length === 0 && (
                          <Paper withBorder radius="md" p="lg" style={{ borderStyle: 'dashed' }}>
                            <Text size="sm" c="dimmed" ta="center">
                              {validation?.noSteps ?? 'No steps yet.'}
                            </Text>
                          </Paper>
                        )}
                      </Stack>
                    )}
                  </Droppable>
                </DragDropContext>
              </ScrollArea>

              {/* Footer */}
              {readOnly ? (
                <Group justify="flex-end">
                  <Button variant="default" leftSection={<IconCopy size={13} />} onClick={wf.duplicate}>
                    Duplicate to my workflows
                  </Button>
                </Group>
              ) : (
                <Group justify="space-between">
                  <Group gap="xs">
                    <AddStepMenu
                      ownSteps={wf.steps}
                      sharedSteps={wf.sharedSteps}
                      onBlank={() => selectStep(wf.addStep())}
                      onPick={(def) => selectStep(wf.addSharedStep(def))}
                    />
                    <Button variant="default" leftSection={<IconCopy size={13} />} onClick={wf.duplicate}>
                      Duplicate
                    </Button>
                  </Group>
                  <Group gap="xs">
                    {wf.selectedId && (
                      <Button variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={wf.requestDelete}>
                        Delete
                      </Button>
                    )}
                    <Button disabled={!wf.dirty} onClick={wf.save}>
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
    </>
  );
}
