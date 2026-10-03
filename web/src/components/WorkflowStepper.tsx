import { Fragment, useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Drawer,
  Group,
  HoverCard,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconCoins,
  IconHandStop,
  IconPlayerPlay,
  IconPlayerTrackNext,
} from '@tabler/icons-react';
import type {
  ModelOption,
  SessionMeta,
  StepContent,
  WorkflowDef,
  WorkflowStep,
  WorkflowStepOverride,
  WorkflowStepStatus,
} from '@lines/shared';
import {
  capabilitiesFor,
  hasEstimatedSpend,
  isSessionActive,
  isSessionInterruptible,
  providerForModel,
} from '@lines/shared';
import { useCan } from '../lib/can';
import { formatDuration, formatSpendUsd, withLiveSpend } from '../lib/format';
import { permissionModeLabel } from '../lib/permissionModes';
import { useStepResolver } from '../lib/useStepResolver';
import { useIsPhone, useReveal } from '../lib/layout';
import { useStore } from '../store';
import { send } from '../ws';
import { revealWorkflowStep } from '../lib/workflowReveal';
import { ConfirmModal } from './ConfirmModal';
import { WorkflowRunModal } from './workflow/WorkflowRunModal';
import { crossesProvider, effortLabel, gateLabel, modelLabel, startLabel } from './workflow/StepSettings';

/**
 * What a step runs on, for the desktop stepper's hover card: the step's own
 * settings, and this run's override of them when there is one. Holds no
 * `[data-progress-fill]` — Transcript counts those across the whole document.
 */
function StepDetails({
  name,
  content,
  freshStart,
  last,
  override,
  models,
}: {
  name: string;
  content: StepContent | undefined;
  /** Whether the step starts fresh, provider switches included. */
  freshStart: boolean;
  last: boolean;
  override?: WorkflowStepOverride | null;
  models: ModelOption[];
}) {
  if (!content) {
    return (
      <Text size="xs" c="dimmed">
        This pinned step is not available here.
      </Text>
    );
  }
  const rows: [string, string][] = [
    ['Model', modelLabel(models, content.model)],
    ['Effort', effortLabel(content.reasoningEffort)],
    ['Permission', permissionModeLabel(content.permissionMode)],
    ['Starts with', startLabel(freshStart)],
    ['When it finishes', gateLabel(content.autoAdvance, last)],
  ];
  // Absent fields mean "the step's own"; a null effort means Auto even when the
  // step names one.
  const overridden = override
    ? [
        override.model ? modelLabel(models, override.model) : null,
        override.reasoningEffort !== undefined ? effortLabel(override.reasoningEffort) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <Stack gap={5}>
      <Text size="xs" fw={600} truncate>
        {name}
      </Text>
      {rows.map(([label, value]) => (
        <Group key={label} justify="space-between" gap="md" wrap="nowrap">
          <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text fz={11} truncate>
            {value}
          </Text>
        </Group>
      ))}
      {overridden && (
        <Group justify="space-between" gap="md" wrap="nowrap">
          <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
            This run
          </Text>
          <Text fz={11} fw={600} truncate>
            {overridden}
          </Text>
        </Group>
      )}
    </Stack>
  );
}

function StepIcon({
  status,
  index,
  current = false,
  advanceLabel,
  advanceIcon = 'check',
  onAdvance,
}: {
  status: WorkflowStepStatus;
  index: number;
  /** The step the workflow is on. With no accent hue, it is the one solid chip. */
  current?: boolean;
  /** Tooltip for the force-advance affordance; undefined when this step can't be advanced. */
  advanceLabel?: string;
  /** What the affordance does: complete this step, or start one that never began. */
  advanceIcon?: 'check' | 'play';
  onAdvance?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Touch has no hover, so on a phone the force-advance affordance would not
  // exist — and it is the only way past a step that will not settle.
  const show = useReveal(hovered);
  // Hovering an advanceable step swaps its number/loader for the action's glyph — the
  // affordance lives on the icon only, so the rest of the row keeps its
  // scroll-to-marker click.
  const showAdvance = !!advanceLabel && show;
  // Monochrome, so emphasis is fill: the current step (and the advance glyph) is
  // solid, finished steps recede to a tint, and steps still to come are a
  // hairline outline with a dimmed number.
  const variant =
    showAdvance || current ? 'filled' : status === 'done' ? 'light' : 'default';
  // Fixed width so the title (and the metrics row indented under it) never shifts
  // when a step flips between the 20px loader and the 22px icon.
  const icon = (
    <Center
      w={22}
      style={{ flexShrink: 0, cursor: advanceLabel ? 'pointer' : undefined }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={
        advanceLabel
          ? (e) => {
              e.stopPropagation();
              onAdvance?.();
            }
          : undefined
      }
    >
      {status === 'running' && !showAdvance ? (
        <Loader size={20} />
      ) : (
        <ThemeIcon
          size={22}
          radius="xl"
          variant={variant}
          c={variant === 'default' ? 'dimmed' : undefined}
        >
          {showAdvance ? (
            advanceIcon === 'play' ? (
              <IconPlayerPlay size={12} />
            ) : (
              <IconCheck size={13} />
            )
          ) : status === 'done' ? (
            <IconCheck size={13} />
          ) : (
            <Text fz={11}>{index + 1}</Text>
          )}
        </ThemeIcon>
      )}
    </Center>
  );
  return advanceLabel ? (
    <Tooltip label={advanceLabel} withArrow fz="xs">
      {icon}
    </Tooltip>
  ) : (
    icon
  );
}

export function WorkflowStepper({
  session,
  workflow,
}: {
  session: SessionMeta;
  workflow: WorkflowDef;
}) {
  const state = session.workflow!;
  const { resolveStepContent } = useStepResolver();
  const models = useStore((s) => s.models);

  /** Display name for a step, resolving pinned references through the step library. */
  const nameOf = (step: WorkflowStep): string => resolveStepContent(step)?.name ?? 'Pinned step';
  const contents = workflow.steps.map((step) => resolveStepContent(step));
  /** Starts fresh, by its own setting or because the step before it is on another provider. */
  const startsFresh = (i: number): boolean => {
    const c = contents[i];
    if (!c) return false;
    return c.freshStart || crossesProvider(contents[i - 1]?.model, c.model);
  };

  /** Per-run model/effort editor: offered while a step is still to come. */
  const canSetModel = useCan('setModel');
  const [tuneOpen, setTuneOpen] = useState(false);
  const tunable = canSetModel && state.stepStatuses.some((st) => st === 'pending');

  const currentStatus = state.stepStatuses[state.stepIndex];
  const waiting = currentStatus === 'waiting-approval';
  /** A parked step with a live turn over it can only be a manual compaction — nothing
   *  else runs a turn on a parked step. The server refuses approve/force-advance for
   *  the duration (see WorkflowEngine.approve), so the button must not offer it. */
  const compacting = waiting && isSessionInterruptible(session.status);
  /** Parked only because the main thread ended its turn while a background agent
   *  works on; that agent's result opens a turn that re-opens the step. Approve
   *  stays available — the user may still proceed without waiting. */
  const backgroundBusy = waiting && !!session.backgroundTasks?.length;
  /** Server-owned: an approve is in flight and the step's output is being consolidated. */
  const advancing = !!state.advancing;
  /** A force-advance stopped the live turn and the advance waits on it settling. */
  const stopping = state.advanceOnComplete === 'interrupted';
  /** The current step never got its first turn and nothing is in flight to give it one
   *  (an advance that died mid-flight) — so only the user can start it. */
  const stalled =
    state.started &&
    currentStatus === 'pending' &&
    !advancing &&
    !stopping &&
    !isSessionActive(session.status);
  /** The advance marked the current step done but never started the next one (a bridge
   *  death mid-consolidation). Deliberately NOT gated on isSessionActive: the session
   *  status is whatever it was before the approve — usually the stale 'waiting-approval'
   *  from the park — and `advancing` is the only honest marker of a live advance. */
  const resumable =
    state.started &&
    currentStatus === 'done' &&
    state.stepIndex + 1 < workflow.steps.length &&
    !advancing &&
    !stopping;
  const connected = useStore((s) => s.connectionStatus === 'connected');
  /** The in-flight turn's live estimate; only the running step is charged it,
   *  since steps are billed when their turn completes. */
  const liveSpend = useStore((s) => s.turnSpend[session.id]);
  /** Step index awaiting the "mark as completed" confirmation. */
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const confirmRunning = confirmIndex !== null && state.stepStatuses[confirmIndex] === 'running';
  /** A stalled step is started, not completed — different question, different message. */
  const confirmPending = confirmIndex !== null && state.stepStatuses[confirmIndex] === 'pending';
  const confirmLast = confirmIndex !== null && confirmIndex === workflow.steps.length - 1;
  const confirmName = confirmIndex !== null ? nameOf(workflow.steps[confirmIndex]!) : '';

  /**
   * A desktop shows the whole workflow across the row, however long it is —
   * that overview is the point of the stepper, and a wide row can carry it.
   *
   * A phone cannot: one step is all that fits with its name readable. So there
   * it shows the current step and nothing else, and the rest are a tap away in
   * a sheet rather than folded into the page — expanding in place would push
   * the transcript down by the height of the list every time you looked.
   */
  const isPhone = useIsPhone();
  const [listOpen, setListOpen] = useState(false);

  return (
    <Paper withBorder={false} px="md" pt="xs" pb="xs">
      {/* Every step stays in the DOM in index order on both layouts, hidden
          rather than dropped: Transcript counts `[data-progress-fill]` elements
          to learn how many steps there are and reads them in order, so dropping
          one — or letting the sheet below render a second set — would renumber
          the workflow's scroll segments. */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {workflow.steps.map((step, i) => {
          const current = i === state.stepIndex;
          const shown = !isPhone || current;
          const status = state.stepStatuses[i];
          const clickable = status !== 'pending';
          const tokens = state.stepTokens?.[i] ?? 0;
          const durationMs = state.stepDurationsMs?.[i] ?? 0;
          // The step's own model where the server stamped one — a workflow may
          // cross providers, so only that answers per step. Steps run before
          // `stepModels` existed fall back to the session-wide reading.
          const stepModel = state.stepModels?.[i];
          const stepCost = withLiveSpend(
            state.stepCostsUsd?.[i],
            current && status === 'running' ? liveSpend : undefined,
            stepModel
              ? !capabilitiesFor(providerForModel(stepModel)).cost
              : hasEstimatedSpend(session.costByModel),
          );
          const cost = stepCost.usd ?? 0;
          const estimated = stepCost.estimated;
          const content = contents[i];
          const next = contents[i + 1];
          // The gate between this step and the next, in the editor's words.
          const gate =
            content && next ? `${gateLabel(content.autoAdvance)} · ${startLabel(startsFresh(i + 1))}` : '';
          return (
            <Fragment key={i}>
            <Group
              gap={8}
              wrap="nowrap"
              // Title row and metrics row are the same height (18px), so centering the
              // icon against the column lands it exactly on the progress track.
              align="center"
              style={{
                flex: 1,
                minWidth: 0,
                display: shown ? undefined : 'none',
                cursor: clickable ? 'pointer' : undefined,
              }}
              onClick={
                clickable
                  ? () =>
                      // Jump to the step's start marker in the transcript, which
                      // may still be outside its rendered window.
                      revealWorkflowStep(i)
                  : undefined
              }
            >
              <Box display="inline-flex">
                <StepIcon
                  status={status}
                  index={i}
                  current={current}
                  advanceLabel={
                    i !== state.stepIndex
                      ? undefined
                      : status === 'running'
                        ? 'Mark as completed'
                        : status === 'waiting-approval'
                          ? // Frozen while a compaction runs over the park: approve
                            // would be refused server-side, so offer nothing.
                            compacting
                            ? undefined
                            : 'Proceed to next step'
                          : stalled
                            ? 'Start this step'
                            : resumable
                              ? 'Continue to the next step'
                              : undefined
                  }
                  advanceIcon={(stalled || resumable) && i === state.stepIndex ? 'play' : 'check'}
                  // A resumable step is already done — there is nothing to confirm
                  // overriding, so it skips the modal the other two paths use.
                  onAdvance={() =>
                    resumable && i === state.stepIndex
                      ? send({
                          type: 'workflowForceAdvance',
                          sessionId: session.id,
                          stepIndex: i,
                        })
                      : setConfirmIndex(i)
                  }
                />
              </Box>
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                {/* Hover only: a phone has none, and its row is the current step,
                    whose settings the composer already shows. */}
                <HoverCard
                  disabled={isPhone}
                  openDelay={350}
                  closeDelay={80}
                  position="bottom-start"
                  width={240}
                  shadow="md"
                  withArrow
                >
                  <HoverCard.Target>
                    <Text
                      size="xs"
                      lh="18px"
                      fw={current ? 600 : 500}
                      c={status === 'pending' && !current ? 'dimmed' : undefined}
                      truncate
                    >
                      {nameOf(step)}
                    </Text>
                  </HoverCard.Target>
                  <HoverCard.Dropdown>
                    <StepDetails
                      name={nameOf(step)}
                      content={content}
                      freshStart={startsFresh(i)}
                      last={i === workflow.steps.length - 1}
                      override={state.stepOverrides?.[i]}
                      models={models}
                    />
                  </HoverCard.Dropdown>
                </HoverCard>
                {/* Underline doubles as this step's scroll-progress track,
                    filled imperatively by Transcript. */}
                <Box
                  style={{
                    width: '100%',
                    minWidth: 12,
                    height: 3,
                    borderRadius: 2,
                    background: 'var(--mantine-color-default-border)',
                  }}
                >
                  <Box
                    data-progress-fill
                    className="lines-progress-fill"
                    data-running={status === 'running' || undefined}
                    style={{ height: '100%', width: 0, borderRadius: 2 }}
                  />
                </Box>
                {/* Always rendered — an invisible placeholder holds the row's height so
                    steps don't jump as metrics arrive. */}
                <Group gap={6} wrap="nowrap" h={18}>
                  {cost === 0 && tokens === 0 && durationMs === 0 && (
                    <Text fz={11} c="dimmed" style={{ visibility: 'hidden' }} aria-hidden>
                      $0.00
                    </Text>
                  )}
                  {cost > 0 && (
                    <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
                      {formatSpendUsd(cost, estimated)}
                    </Text>
                  )}
                  {tokens > 0 && (
                    <Tooltip label={`${tokens.toLocaleString()} tokens spent`} withArrow fz="xs">
                      <Center c="dimmed" style={{ flexShrink: 0 }}>
                        <IconCoins size={11} />
                      </Center>
                    </Tooltip>
                  )}
                  {durationMs > 0 && (
                    <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
                      {formatDuration(durationMs)}
                    </Text>
                  )}
                </Group>
              </Stack>
              {/* Rides the current step's row, the one row a phone always shows,
                  so "3/8" and the chevron sit beside the step they are counting
                  and the rows keep their index order around them. */}
              {isPhone && current && workflow.steps.length > 1 && (
                <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Text fz={11} c="dimmed">
                    {state.stepIndex + 1}/{workflow.steps.length}
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Show every step"
                    onClick={(e) => {
                      // The row itself jumps the transcript to this step; only the
                      // chevron opens the list.
                      e.stopPropagation();
                      setListOpen(true);
                    }}
                  >
                    <IconChevronDown size={14} />
                  </ActionIcon>
                </Group>
              )}
            </Group>
            {/* The gate to the next step. Holds no `[data-progress-fill]` —
                Transcript counts those, in DOM order, as the steps. Desktop
                only: a phone's row is the current step alone. */}
            {!isPhone && gate && (
              <Tooltip label={gate} withArrow fz="xs">
                <Center c="dimmed" role="img" aria-label={gate} style={{ flexShrink: 0 }}>
                  {content!.autoAdvance ? <IconPlayerTrackNext size={12} /> : <IconHandStop size={12} />}
                </Center>
              </Tooltip>
            )}
            </Fragment>
          );
        })}
        {tunable && (
          <Tooltip label="Models for the steps still to come" withArrow fz="xs">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Choose models for the remaining steps"
              style={{ flexShrink: 0 }}
              onClick={() => setTuneOpen(true)}
            >
              <IconAdjustmentsHorizontal size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Box>
      <WorkflowRunModal
        opened={tuneOpen}
        workflow={workflow}
        initialOverrides={state.stepOverrides}
        lockedIndices={state.stepStatuses.flatMap((st, i) => (st === 'pending' ? [] : [i]))}
        confirmLabel="Apply"
        onConfirm={(stepOverrides) =>
          send({ type: 'setWorkflowStepOverrides', sessionId: session.id, stepOverrides })
        }
        onClose={() => setTuneOpen(false)}
      />
      {(waiting || advancing || stopping || stalled || resumable) && (
        // One line, not a card. This strip is on screen for as long as a step is
        // parked — which is most of a workflow's life, and the whole of it when
        // the user is the one being waited on — so it competes with the
        // transcript for a phone's screen. The step's name is directly above it
        // in bold, so repeating it here bought a third line of text and no
        // information.
        <Group
          justify="space-between"
          wrap="nowrap"
          gap="xs"
          mt={6}
          px="xs"
          py={4}
          style={{
            borderRadius: 'var(--mantine-radius-sm)',
            background: 'var(--mantine-color-default-hover)',
            boxShadow: 'inset 2px 0 0 var(--mantine-color-text)',
          }}
        >
          <Text size="xs" truncate style={{ minWidth: 0 }}>
            {compacting
              ? 'Compacting context — still waiting for you'
              : advancing
                ? 'Approved — wrapping up the output…'
                : stopping
                  ? 'Stopping — the next step starts once it settles'
                  : backgroundBusy
                    ? 'Background agent still running — its result will resume this step'
                    : stalled
                      ? 'Never started, and nothing is running'
                      : resumable
                        ? 'Done, but the next step never started'
                        : 'Finished — approve, or reply to keep iterating'}
          </Text>
          {/* Busy state is server-owned (state.advancing) so every tab agrees and the
              loader can't hang on a dropped message. Disabled offline: ws.ts silently
              drops non-prompt messages when the socket is closed. */}
          <Button
            size="compact-xs"
            style={{ flexShrink: 0 }}
            leftSection={compacting || advancing || stopping ? <Loader size={12} /> : undefined}
            disabled={compacting || advancing || stopping || !connected}
            onClick={() =>
              stalled
                ? setConfirmIndex(state.stepIndex)
                : send({
                    // A resumable step is already approved and done; re-approving it
                    // would be refused, so the resume goes through forceAdvance.
                    type: resumable ? 'workflowForceAdvance' : 'workflowApprove',
                    sessionId: session.id,
                    stepIndex: state.stepIndex,
                  })
            }
          >
            {stalled ? 'Start step' : resumable ? 'Continue' : 'Approve'}
          </Button>
        </Group>
      )}
      {/* The other steps, over the page rather than wedged into it: the stepper
          sits above the transcript, so expanding in place pushes the
          conversation down by the height of the list every time you check where
          you are. The same bottom sheet the composer's Options uses.

          Deliberately free of `data-progress-fill`: Transcript counts those to
          learn the workflow's length, so a second set here would double it.
          Progress per step lives on the row behind the sheet, which is the one
          you can actually watch fill. */}
      <Drawer
        opened={isPhone && listOpen}
        onClose={() => setListOpen(false)}
        position="bottom"
        size="auto"
        padding="sm"
        title={`Step ${state.stepIndex + 1} of ${workflow.steps.length}`}
        classNames={{ content: 'lines-mobile-sheet', inner: 'lines-mobile-sheet-inner' }}
      >
        <Stack gap={2} className="lines-safe-bottom">
          {workflow.steps.map((step, i) => {
            const status = state.stepStatuses[i];
            const tokens = state.stepTokens?.[i] ?? 0;
            const durationMs = state.stepDurationsMs?.[i] ?? 0;
            const stepModel = state.stepModels?.[i];
            const stepCost = withLiveSpend(
              state.stepCostsUsd?.[i],
              i === state.stepIndex && status === 'running' ? liveSpend : undefined,
              stepModel
                ? !capabilitiesFor(providerForModel(stepModel)).cost
                : hasEstimatedSpend(session.costByModel),
            );
            const cost = stepCost.usd ?? 0;
            const estimated = stepCost.estimated;
            const metrics = [
              cost > 0 ? formatSpendUsd(cost, estimated) : '',
              tokens > 0 ? `${tokens.toLocaleString()} tokens` : '',
              durationMs > 0 ? formatDuration(durationMs) : '',
            ].filter(Boolean);
            return (
              <Group
                key={i}
                gap="sm"
                wrap="nowrap"
                py={6}
                px={4}
                style={{
                  borderRadius: 'var(--mantine-radius-sm)',
                  background:
                    i === state.stepIndex ? 'var(--mantine-color-default-hover)' : undefined,
                  // A pending step has no transcript to jump to yet.
                  cursor: status === 'pending' ? 'default' : 'pointer',
                }}
                onClick={() => {
                  if (status === 'pending') return;
                  revealWorkflowStep(i);
                  setListOpen(false);
                }}
              >
                <StepIcon status={status} index={i} current={i === state.stepIndex} />
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" fw={i === state.stepIndex ? 600 : 400} truncate>
                    {nameOf(step)}
                  </Text>
                  {metrics.length > 0 && (
                    <Text fz={11} c="dimmed" truncate>
                      {metrics.join(' · ')}
                    </Text>
                  )}
                </Stack>
              </Group>
            );
          })}
        </Stack>
      </Drawer>
      <ConfirmModal
        opened={confirmIndex !== null}
        title={confirmPending ? 'Start this step?' : 'Mark step as completed?'}
        message={
          confirmPending
            ? `“${confirmName}” never started and nothing is running. Starting it runs the step now, ` +
              "with the previous step's output handed over as usual."
            : (confirmRunning
                ? `“${confirmName}” is still running — its turn is stopped and whatever it said last becomes the step's output. `
                : `“${confirmName}” is marked done. `) +
              (confirmLast ? 'The workflow finishes.' : 'The next step starts right away.')
        }
        confirmLabel={confirmPending ? 'Start step' : 'Mark completed'}
        onConfirm={() => {
          if (confirmIndex !== null) {
            send({
              type: confirmPending ? 'workflowStartStep' : 'workflowForceAdvance',
              sessionId: session.id,
              stepIndex: confirmIndex,
            });
          }
          setConfirmIndex(null);
        }}
        onCancel={() => setConfirmIndex(null)}
      />
    </Paper>
  );
}
