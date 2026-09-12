import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconGripVertical, IconInfoCircle, IconPlayerPlay, IconStack2 } from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import type { PermissionMode, RecipeDef } from '@lines/shared';
import { isBundle } from '@lines/shared';
import { useStore } from '../../store';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../../lib/modelSelect';
import { PERMISSION_MODES, renderPermissionModeOption } from '../../lib/permissionModes';
import { send } from '../../ws';

/** Sentinel for "plain session" — a Select can't carry null as an option value,
 *  and a real workflow id is a uuid, so this can never collide with one. */
const NO_WORKFLOW = 'none';

/** `"<first title> +N more"` — the default name of the workflow a multi-recipe run creates. */
function defaultBundleName(recipes: RecipeDef[]): string {
  if (recipes.length === 0) return '';
  return recipes.length === 1 ? recipes[0].title : `${recipes[0].title} +${recipes.length - 1} more`;
}

/**
 * Run one recipe, or several as one session. Both cases live here because the
 * only real difference is ordering and the workflow the server synthesizes —
 * splitting them would duplicate the model/mode pickers verbatim.
 *
 * There is no project picker: a run always lands in the active project tab, the
 * context the user is already looking at.
 */
export function RecipeRunModal({
  opened,
  recipes,
  onClose,
  onRan,
  onSaveAsBundle,
}: {
  opened: boolean;
  recipes: RecipeDef[];
  onClose: () => void;
  /** Fired after a run is sent, so the browser behind this modal can get out of
   *  the way — the point of running is to watch the session it just created. */
  onRan?: () => void;
  onSaveAsBundle?: (recipes: RecipeDef[]) => void;
}) {
  const activeProject = useStore((s) => s.activeProject);
  const models = useStore((s) => s.models);
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);
  const newSessionDefaults = useStore((s) => s.newSessionDefaults);

  const [order, setOrder] = useState<RecipeDef[]>(recipes);
  const [bundleName, setBundleName] = useState('');
  const [review, setReview] = useState(false);
  const [model, setModel] = useState(newSessionDefaults.model);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(newSessionDefaults.permissionMode);
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  // Re-seed on each open: the selection (and the active project) moves between opens.
  useEffect(() => {
    if (!opened) return;
    setOrder(recipes);
    setBundleName(defaultBundleName(recipes));
    setReview(false);
    setModel(newSessionDefaults.model);
    setPermissionMode(newSessionDefaults.permissionMode);
    setWorkflowId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const multi = order.length > 1;
  // A single saved bundle expands server-side, so it becomes a workflow too —
  // it just has no member order to offer here.
  const synthesizesWorkflow = multi || (order.length === 1 && isBundle(order[0]));

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    setOrder((list) => {
      const next = [...list];
      next.splice(result.destination!.index, 0, ...next.splice(result.source.index, 1));
      return next;
    });
  };

  const run = () => {
    // The project tab is the context the user is already in — a picker here
    // would only offer them a way to run somewhere they aren't looking.
    const cwd = activeProject;
    if (!cwd) return;
    send({
      type: 'runRecipe',
      runId: crypto.randomUUID(),
      recipes: order.map((r) => ({ ownerId: r.ownerId, recipeId: r.id })),
      cwd,
      model,
      permissionMode,
      ...(multi ? { bundleName: bundleName.trim() || defaultBundleName(order) } : {}),
      ...(synthesizesWorkflow ? { autoAdvance: !review } : {}),
      ...(!synthesizesWorkflow && workflowId ? { workflowId } : {}),
    });
    onClose();
    onRan?.();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={multi ? `Run ${order.length} recipes` : order[0]?.title ?? 'Run recipe'}
      size="lg"
      centered
      transitionProps={{ transition: 'fade' }}
    >
      <Stack gap="sm">
        {multi ? (
          <>
            <Text size="xs" c="dimmed">
              Recipes run top to bottom — drag to change the order.
            </Text>
            <ScrollArea.Autosize mah={260} type="auto">
              <DragDropContext onDragEnd={onDragEnd}>
                <Droppable droppableId="recipes">
                  {(dropProvided) => (
                    <Stack gap={6} ref={dropProvided.innerRef} {...dropProvided.droppableProps} pr="xs">
                      {order.map((r, i) => (
                        <Draggable key={`${r.ownerId}/${r.id}`} draggableId={`${r.ownerId}/${r.id}`} index={i}>
                          {(dragProvided) => (
                            <Paper
                              withBorder
                              radius="md"
                              p="xs"
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                            >
                              <Group gap={8} wrap="nowrap">
                                <span {...dragProvided.dragHandleProps} style={{ display: 'flex', cursor: 'grab' }}>
                                  <IconGripVertical size={14} opacity={0.5} />
                                </span>
                                <Text size="xs" c="dimmed" w={16}>{i + 1}</Text>
                                <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>{r.title}</Text>
                                {isBundle(r) && (
                                  <Badge size="xs" variant="light" color="gray" leftSection={<IconStack2 size={10} />}>
                                    {r.members?.length ?? 0}
                                  </Badge>
                                )}
                                <Text fz={10} c="dimmed" truncate maw={110}>{r.ownerName ?? 'Unknown'}</Text>
                              </Group>
                            </Paper>
                          )}
                        </Draggable>
                      ))}
                      {dropProvided.placeholder}
                    </Stack>
                  )}
                </Droppable>
              </DragDropContext>
            </ScrollArea.Autosize>
            <TextInput
              label="Workflow name"
              value={bundleName}
              onChange={(e) => setBundleName(e.currentTarget.value)}
            />
          </>
        ) : (
          order[0]?.description && (
            <Text size="xs" c="dimmed">{order[0].description}</Text>
          )
        )}

        {synthesizesWorkflow && (
          <Alert variant="light" color="gray" p="xs" icon={<IconInfoCircle size={16} />}>
            <Text size="xs">
              This creates a saved workflow with one step per recipe, then runs it in a new session.
            </Text>
          </Alert>
        )}

        {synthesizesWorkflow ? (
          <Switch
            label="Review between recipes"
            description="Off runs the whole set unattended"
            checked={review}
            onChange={(e) => setReview(e.currentTarget.checked)}
          />
        ) : (
          <Select
            label="Run inside a workflow"
            // An explicit first option rather than only the clear button: going
            // back to a plain session is a real choice here, not an "unset".
            data={[
              { value: NO_WORKFLOW, label: 'No workflow — plain session' },
              ...[...workflows, ...sharedWorkflows].map((w) => ({ value: w.id, label: w.name })),
            ]}
            value={workflowId ?? NO_WORKFLOW}
            allowDeselect={false}
            onChange={(v) => setWorkflowId(v && v !== NO_WORKFLOW ? v : null)}
          />
        )}

        {/* A chosen workflow carries a model and a permission mode per step and
            applies them as each one starts, so picking them here would only show
            a value the first step is about to overwrite. A synthesized workflow
            is the opposite case: its steps have none of their own, which is
            exactly where these two go. */}
        {workflowId ? (
          <Text size="xs" c="dimmed">
            Each workflow step brings its own model and permission mode.
          </Text>
        ) : (
          <Group grow align="flex-start">
            <Select
              label="Model"
              comboboxProps={modelComboboxProps}
              // Any provider: a recipe run creates fresh sessions, so there is no
              // conversation for a provider change to strand.
              data={modelSelectData(models, model)}
              renderOption={renderModelOption}
              value={model}
              allowDeselect={false}
              onChange={(v) => v && setModel(v)}
            />
            <Select
              label="Permission mode"
              comboboxProps={modelComboboxProps}
              data={PERMISSION_MODES}
              renderOption={renderPermissionModeOption}
              value={permissionMode}
              allowDeselect={false}
              onChange={(v) => v && setPermissionMode(v as PermissionMode)}
            />
          </Group>
        )}

        <Group justify="space-between" mt="xs">
          {multi && onSaveAsBundle ? (
            <Button variant="default" leftSection={<IconStack2 size={13} />} onClick={() => onSaveAsBundle(order)}>
              Save as bundle
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="subtle" color="gray" onClick={onClose}>
              Cancel
            </Button>
            <Tooltip label="Open a project first" disabled={!!activeProject}>
              <Button leftSection={<IconPlayerPlay size={13} />} disabled={!activeProject} onClick={run}>
                {multi ? 'Run together' : 'Run recipe'}
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
