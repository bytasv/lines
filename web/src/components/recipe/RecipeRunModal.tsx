import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
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
import { IconGripVertical, IconInfoCircle, IconPlayerPlay, IconShieldQuestion, IconStack2 } from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import type { PermissionMode, RecipeDef, RecipeRef } from '@lines/shared';
import { FOREIGN_RECIPE_MODES, isBundle } from '@lines/shared';
import { useStore } from '../../store';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../../lib/modelSelect';
import { PERMISSION_MODES, permissionModeSelectData, renderPermissionModeOption } from '../../lib/permissionModes';
import { send } from '../../ws';
import { isHeld, recipeReviewItem, UntrustedReviewModal } from '../workflow/UntrustedReview';

/** Sentinel for "plain session" — a Select can't carry null as an option value,
 *  and a real workflow id is a uuid, so this can never collide with one. */
const NO_WORKFLOW = 'none';

/** `"<first title> +N more"` — the default name of the workflow a multi-recipe run creates. */
function defaultBundleName(recipes: RecipeDef[]): string {
  if (recipes.length === 0) return '';
  return recipes.length === 1 ? recipes[0].title : `${recipes[0].title} +${recipes.length - 1} more`;
}

const keyOf = (r: { ownerId: string; id: string }) => `${r.ownerId}/${r.id}`;

/**
 * Run one recipe, or several as one session. Both cases live here because the
 * only real difference is ordering and the workflow the server synthesizes —
 * splitting them would duplicate the model/mode pickers verbatim.
 *
 * There is no project picker: a run always lands in the active project tab, the
 * context the user is already looking at.
 *
 * A run with someone else's recipe in it is different in four ways, each also
 * enforced by the bridge (recipeCommands.runRecipe): every prompt that will run
 * is shown in full and has to be confirmed, the mode is Plan or Assist, it
 * cannot run inside one of the user's workflows, and a run of several stops
 * after each recipe. An own recipe this machine has not verified does not run
 * at all until it is reviewed.
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
  const ownRecipes = useStore((s) => s.recipes);
  const sharedRecipes = useStore((s) => s.sharedRecipes);

  const [order, setOrder] = useState<RecipeDef[]>(recipes);
  const [bundleName, setBundleName] = useState('');
  const [review, setReview] = useState(false);
  const [model, setModel] = useState(newSessionDefaults.model);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(newSessionDefaults.permissionMode);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  /** The prompts the user confirmed, joined — a confirmation of other text is none. */
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Re-seed on each open: the selection (and the active project) moves between opens.
  useEffect(() => {
    if (!opened) return;
    setOrder(recipes);
    setBundleName(defaultBundleName(recipes));
    setReview(false);
    setModel(newSessionDefaults.model);
    setPermissionMode(newSessionDefaults.permissionMode);
    setWorkflowId(null);
    setConfirmedFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const isOwn = (r: { ownerId: string; id: string }) => ownRecipes.some((o) => keyOf(o) === keyOf(r));
  // The live row, not the one captured when the modal opened: a recipe can be
  // edited, or reviewed, while the modal is up, and the bridge runs the live one.
  const fresh = (r: RecipeDef) =>
    ownRecipes.find((o) => keyOf(o) === keyOf(r)) ?? sharedRecipes.find((s) => keyOf(s) === keyOf(r)) ?? r;
  /** A bundle member as the bridge resolves it: an own head, or a published one of someone else's. */
  const member = (ref: RecipeRef) =>
    ownRecipes.find((o) => o.ownerId === ref.ownerId && o.id === ref.recipeId) ??
    sharedRecipes.find((s) => s.ownerId === ref.ownerId && s.id === ref.recipeId && s.published);

  const current = order.map(fresh);
  // Exactly what will run, in run order — the same expansion the bridge does, so
  // the prompts confirmed here are the prompts it compares against.
  const expanded = current.flatMap((r) => (isBundle(r) ? (r.members ?? []).map(member) : [r]));
  const leaves = expanded.filter((r): r is RecipeDef => !!r);
  const missing = leaves.length !== expanded.length;
  const involved = [...current.filter((r) => isBundle(r)), ...leaves];
  const foreign = involved.some((r) => !isOwn(r));
  // Held back only: a mark that merely records provenance (strict sync off on
  // the bridge) does not stop the run there, so it does not stop it here.
  const unverified = involved.filter(
    (r, i) => isOwn(r) && isHeld(r.untrusted) && involved.findIndex((x) => keyOf(x) === keyOf(r)) === i,
  );
  const promptsKey = JSON.stringify(leaves.map((r) => r.prompt));
  const confirmed = confirmedFor === promptsKey;
  const effectiveMode: PermissionMode =
    foreign && !FOREIGN_RECIPE_MODES.includes(permissionMode) ? 'auto' : permissionMode;

  const multi = order.length > 1;
  // A single saved bundle expands server-side, so it becomes a workflow too —
  // it just has no member order to offer here.
  const synthesizesWorkflow = multi || (order.length === 1 && isBundle(order[0]));
  // Someone else's recipe never runs inside one of the user's workflows: those
  // steps bring their own permission modes, and the first would carry the prompt.
  const chosenWorkflow = !synthesizesWorkflow && !foreign ? workflowId : null;

  const blocked = !activeProject
    ? 'Open a project first'
    : unverified.length > 0
      ? 'Review the unverified recipe first'
      : foreign && missing
        ? 'A recipe in this bundle is no longer available'
        : foreign && !confirmed
          ? 'Confirm you have read what will run'
          : null;

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
    if (!cwd || blocked) return;
    send({
      type: 'runRecipe',
      runId: crypto.randomUUID(),
      recipes: order.map((r) => ({ ownerId: r.ownerId, recipeId: r.id })),
      cwd,
      model,
      permissionMode: effectiveMode,
      ...(multi ? { bundleName: bundleName.trim() || defaultBundleName(order) } : {}),
      ...(synthesizesWorkflow ? { autoAdvance: !foreign && !review } : {}),
      ...(chosenWorkflow ? { workflowId: chosenWorkflow } : {}),
      // Proof of what the user read, checked against the bridge's own expansion.
      ...(foreign ? { confirmedPrompts: leaves.map((r) => r.prompt) } : {}),
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

        {unverified.length > 0 && (
          <Alert variant="light" color="orange" p="xs" icon={<IconShieldQuestion size={16} />}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="xs">
                {unverified.length === 1
                  ? `“${unverified[0].title}” has`
                  : `${unverified.length} of these recipes have`}{' '}
                not been verified on this machine, so nothing runs until you review{' '}
                {unverified.length === 1 ? 'it' : 'them'}.
              </Text>
              <Button size="compact-xs" variant="light" color="orange" onClick={() => setReviewOpen(true)}>
                Review
              </Button>
            </Group>
          </Alert>
        )}

        {foreign && (
          <>
            <Alert variant="light" color="orange" p="xs" icon={<IconShieldQuestion size={16} />}>
              <Text size="xs">
                Someone else wrote {leaves.length === 1 ? 'this prompt' : 'some of these prompts'}. It runs in a
                session of its own that asks before risky tool calls (or only plans), and a run of several stops after
                each recipe so you can look before the next one starts.
              </Text>
            </Alert>
            <Stack gap={6}>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                What will run
              </Text>
              <ScrollArea.Autosize mah={300} type="auto">
                <Stack gap="sm" pr="xs">
                  {leaves.map((r, i) => (
                    <Stack key={`${keyOf(r)}/${i}`} gap={2}>
                      <Group gap={6} wrap="nowrap">
                        <Text size="xs" c="dimmed" w={16}>{i + 1}</Text>
                        <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>{r.title}</Text>
                        <Text fz={10} c="dimmed" truncate maw={140}>
                          {isOwn(r) ? 'Yours' : (r.ownerName ?? 'Unknown')}
                        </Text>
                      </Group>
                      <Code block style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                        {r.prompt}
                      </Code>
                    </Stack>
                  ))}
                  {missing && (
                    <Text size="xs" c="red">
                      A recipe in this bundle is no longer available, so it cannot run.
                    </Text>
                  )}
                </Stack>
              </ScrollArea.Autosize>
            </Stack>
          </>
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
            description={foreign ? 'Always on when a recipe is someone else’s' : 'Off runs the whole set unattended'}
            checked={foreign || review}
            disabled={foreign}
            onChange={(e) => setReview(e.currentTarget.checked)}
          />
        ) : (
          !foreign && (
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
          )
        )}

        {/* A chosen workflow carries a model and a permission mode per step and
            applies them as each one starts, so picking them here would only show
            a value the first step is about to overwrite. A synthesized workflow
            is the opposite case: its steps have none of their own, which is
            exactly where these two go. */}
        {chosenWorkflow ? (
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
              data={foreign ? PERMISSION_MODES.filter((m) => FOREIGN_RECIPE_MODES.includes(m.value)) : permissionModeSelectData(permissionMode)}
              renderOption={renderPermissionModeOption}
              value={effectiveMode}
              allowDeselect={false}
              onChange={(v) => v && setPermissionMode(v as PermissionMode)}
            />
          </Group>
        )}

        {foreign && (
          <Checkbox
            label={
              leaves.length === 1
                ? 'I have read this prompt and want to run it on this machine'
                : 'I have read these prompts and want to run them on this machine'
            }
            checked={confirmed}
            disabled={missing}
            onChange={(e) => setConfirmedFor(e.currentTarget.checked ? promptsKey : null)}
          />
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
            <Tooltip label={blocked ?? ''} disabled={!blocked}>
              <Button leftSection={<IconPlayerPlay size={13} />} disabled={!!blocked} onClick={run}>
                {multi ? 'Run together' : 'Run recipe'}
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </Stack>

      <UntrustedReviewModal
        opened={reviewOpen && unverified.length > 0}
        title="Review recipes"
        items={unverified.map((r) => recipeReviewItem(r, (ownerId, recipeId) => member({ ownerId, recipeId })))}
        onClose={() => setReviewOpen(false)}
      />
    </Modal>
  );
}
