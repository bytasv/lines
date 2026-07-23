import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import { useStore } from '../../store';
import { ConfirmModal } from '../ConfirmModal';
import { WORKFLOW_PRESETS } from '../../lib/workflowPresets';
import { useWorkflowDraft } from './useWorkflowDraft';
import { WorkflowList } from './WorkflowList';
import { WorkflowPipeline } from './WorkflowPipeline';
import { StepCard } from './StepCard';

export function WorkflowEditor({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const models = useStore((s) => s.models);
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

  return (
    <>
      <Modal
        opened={opened}
        onClose={wf.requestClose}
        title="Workflows"
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
            <Stack gap="sm" p="md" style={{ flex: 1, minWidth: 0 }}>
              {/* Header */}
              <Group justify="space-between" align="flex-end" wrap="nowrap">
                <TextInput
                  label="Workflow name"
                  style={{ flex: 1 }}
                  value={draft.name}
                  disabled={readOnly}
                  error={submitAttempted ? validation?.name : undefined}
                  onChange={(e) => wf.patchDraft({ name: e.currentTarget.value })}
                />
                <TextInput
                  label="Preview task"
                  w={240}
                  value={wf.sampleTask}
                  placeholder="Sample task for prompt preview…"
                  onChange={(e) => wf.setSampleTask(e.currentTarget.value)}
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

              <WorkflowPipeline
                draft={draft}
                collapsed={collapsed}
                validation={validation}
                submitAttempted={submitAttempted}
                readOnly={readOnly}
                onSelectStep={selectStep}
                onAddStep={() => selectStep(wf.addStep())}
              />

              {/* Steps */}
              <ScrollArea style={{ flex: 1 }} type="hover">
                <DragDropContext onDragStart={wf.collapseAll} onDragEnd={onDragEnd}>
                  <Droppable droppableId="steps">
                    {(dropProvided) => (
                      <Stack gap="sm" ref={dropProvided.innerRef} {...dropProvided.droppableProps} pr="xs">
                        {draft.steps.map((step, i) => (
                          <Draggable
                            key={step._uid}
                            draggableId={step._uid}
                            index={i}
                            isDragDisabled={readOnly}
                          >
                            {(dragProvided) => (
                              <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                                <StepCard
                                  step={step}
                                  index={i}
                                  collapsed={collapsed.has(step._uid)}
                                  errors={submitAttempted ? validation?.steps[step._uid] : undefined}
                                  readOnly={readOnly}
                                  models={models}
                                  sampleTask={wf.sampleTask}
                                  canMoveUp={i > 0}
                                  canMoveDown={i < draft.steps.length - 1}
                                  dragHandleProps={dragProvided.dragHandleProps}
                                  onPatch={(patch) => wf.updateStep(step._uid, patch)}
                                  onToggle={() => wf.toggleCollapsed(step._uid)}
                                  onDuplicate={() => wf.duplicateStep(step._uid)}
                                  onRemove={() => wf.removeStep(step._uid)}
                                  onMove={(dir) => wf.moveStep(step._uid, dir)}
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
                    <Button variant="default" leftSection={<IconPlus size={13} />} onClick={() => selectStep(wf.addStep())}>
                      Add step
                    </Button>
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
                        <Text size="sm" fw={600}>
                          {p.name}
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                          {p.steps.length} steps
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        {p.description}
                      </Text>
                    </Paper>
                  ))}
                  <Paper
                    withBorder
                    radius="md"
                    p="md"
                    style={{ cursor: 'pointer', borderStyle: 'dashed' }}
                    onClick={() => wf.newFromPreset(null)}
                  >
                    <Text size="sm" fw={600}>
                      Blank workflow
                    </Text>
                    <Text size="xs" c="dimmed" mt={4}>
                      Start from a single empty step.
                    </Text>
                  </Paper>
                </SimpleGrid>
              </Stack>
            </ScrollArea>
          )}
        </Group>
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
