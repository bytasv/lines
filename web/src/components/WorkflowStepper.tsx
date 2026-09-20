import { useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCoins,
  IconPlayerPlay,
} from '@tabler/icons-react';
import type { SessionMeta, WorkflowDef, WorkflowStep, WorkflowStepStatus } from '@lines/shared';
import {
  capabilitiesFor,
  hasEstimatedSpend,
  isSessionActive,
  isSessionInterruptible,
  isStepRef,
  providerForModel,
} from '@lines/shared';
import { formatDuration, formatSpendUsd } from '../lib/format';
import { useIsPhone, useReveal } from '../lib/layout';
import { useStore } from '../store';
import { send } from '../ws';
import { revealWorkflowStep } from '../lib/workflowReveal';
import { ConfirmModal } from './ConfirmModal';

function StepIcon({
  status,
  index,
  advanceLabel,
  advanceIcon = 'check',
  onAdvance,
}: {
  status: WorkflowStepStatus;
  index: number;
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
          variant={status === 'pending' && !showAdvance ? 'default' : 'filled'}
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
  const pinnedSteps = useStore((s) => s.pinnedSteps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const steps = useStore((s) => s.steps);

  /** Display name for a step, resolving pinned references through the step library. */
  const nameOf = (step: WorkflowStep): string => {
    if (!isStepRef(step)) return step.name;
    const all = [...pinnedSteps, ...steps, ...sharedSteps];
    const found =
      all.find(
        (d) => d.ownerId === step.ownerId && d.id === step.stepId && d.version === step.version,
      ) ?? all.find((d) => d.ownerId === step.ownerId && d.id === step.stepId);
    return found?.name ?? 'Shared step';
  };

  const currentStatus = state.stepStatuses[state.stepIndex];
  const waiting = currentStatus === 'waiting-approval';
  /** A parked step with a live turn over it can only be a manual compaction — nothing
   *  else runs a turn on a parked step. The server refuses approve/force-advance for
   *  the duration (see WorkflowEngine.approve), so the button must not offer it. */
  const compacting = waiting && isSessionInterruptible(session.status);
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
  /** Step index awaiting the "mark as completed" confirmation. */
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const confirmRunning = confirmIndex !== null && state.stepStatuses[confirmIndex] === 'running';
  /** A stalled step is started, not completed — different question, different message. */
  const confirmPending = confirmIndex !== null && state.stepStatuses[confirmIndex] === 'pending';
  const confirmLast = confirmIndex !== null && confirmIndex === workflow.steps.length - 1;
  const confirmName = confirmIndex !== null ? nameOf(workflow.steps[confirmIndex]!) : '';

  /**
   * How many steps fit side by side with their names readable — four across a
   * desktop row, one on a phone.
   *
   * Past that the row becomes a list instead: the current step alone, with the
   * rest an accordion behind a chevron. The in-between version — a few names
   * plus a run of bare numbered circles — showed the shape of the workflow and
   * none of its content, which reads as decoration rather than as state.
   */
  const isPhone = useIsPhone();
  const inRow = workflow.steps.length <= (isPhone ? 1 : 4);
  const [expanded, setExpanded] = useState(false);

  return (
    <Paper withBorder={false} px="md" pt="xs" pb="xs">
      {/* Every step stays in the DOM in index order whichever way this renders,
          hidden rather than dropped: Transcript counts `[data-progress-fill]`
          elements to learn how many steps there are, so a missing one would
          renumber the workflow's scroll segments underneath it. */}
      <Box
        style={{
          display: 'flex',
          flexDirection: inRow ? 'row' : 'column',
          alignItems: inRow ? 'center' : 'stretch',
          gap: inRow ? 12 : 2,
        }}
      >
        {workflow.steps.map((step, i) => {
          const current = i === state.stepIndex;
          const shown = inRow || expanded || current;
          const status = state.stepStatuses[i];
          const clickable = status !== 'pending';
          const cost = state.stepCostsUsd?.[i] ?? 0;
          const tokens = state.stepTokens?.[i] ?? 0;
          const durationMs = state.stepDurationsMs?.[i] ?? 0;
          // The step's own model where the server stamped one — a workflow may
          // cross providers, so only that answers per step. Steps run before
          // `stepModels` existed fall back to the session-wide reading.
          const stepModel = state.stepModels?.[i];
          const estimated = stepModel
            ? !capabilitiesFor(providerForModel(stepModel)).cost
            : hasEstimatedSpend(session.costByModel);
          return (
            <Group
              key={i}
              gap={8}
              wrap="nowrap"
              // Title row and metrics row are the same height (18px), so centering the
              // icon against the column lands it exactly on the progress track.
              align="center"
              style={{
                flex: inRow ? 1 : undefined,
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
                <Text size="xs" lh="18px" fw={current ? 600 : 500} truncate>
                  {nameOf(step)}
                </Text>
                {/* Underline doubles as this step's scroll-progress track,
                    filled imperatively by Transcript. */}
                <Box
                  style={{
                    width: '100%',
                    minWidth: 12,
                    height: 3,
                    borderRadius: 2,
                    background: 'var(--mantine-color-default-hover)',
                  }}
                >
                  <Box
                    data-progress-fill
                    style={{
                      height: '100%',
                      width: 0,
                      borderRadius: 2,
                      background: 'var(--mantine-color-sandstone-6)',
                    }}
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
              {/* The expander rides the current step's row, which is the one row
                  that never hides — so "3/8" and the chevron stay put whether the
                  rest of the list is open or closed, and the steps keep their
                  index order around it. */}
              {!inRow && current && (
                <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Text fz={11} c="dimmed">
                    {state.stepIndex + 1}/{workflow.steps.length}
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={expanded ? 'Hide the other steps' : 'Show every step'}
                    onClick={(e) => {
                      // The row itself jumps the transcript to this step; only the
                      // chevron opens the list.
                      e.stopPropagation();
                      setExpanded((v) => !v);
                    }}
                  >
                    {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                  </ActionIcon>
                </Group>
              )}
            </Group>
          );
        })}
      </Box>
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
            boxShadow: 'inset 2px 0 0 var(--mantine-color-sandstone-6)',
          }}
        >
          <Text size="xs" truncate style={{ minWidth: 0 }}>
            {compacting
              ? 'Compacting context — still waiting for you'
              : advancing
                ? 'Approved — wrapping up the output…'
                : stopping
                  ? 'Stopping — the next step starts once it settles'
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
