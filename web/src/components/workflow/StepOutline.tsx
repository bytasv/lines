import { useState } from 'react';
import type { ReactNode } from 'react';
import { Menu, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconGripVertical,
  IconHandStop,
  IconLock,
  IconPencil,
  IconPin,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconSquare,
} from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DraggableProvidedDragHandleProps, DragUpdate, DropResult } from '@hello-pangea/dnd';
import type { ModelOption, StepContent, StepDef } from '@lines/shared';
import type { DraftStep, StepErrors } from './useWorkflowDraft';
import { permissionModeLabel } from '../../lib/permissionModes';
import {
  crossesProvider,
  effortLabel,
  gateLabel,
  GATE_HINTS,
  modelLabel,
  startLabel,
  START_HINTS,
} from './StepSettings';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

const nameOf = (s: DraftStep) => s.name.trim() || 'Untitled step';

/** The `{outputs.<name>}` names a prompt reads, in order, once each. */
function outputsRead(template: string): string[] {
  const names = [...template.matchAll(/\{outputs\.([\w-]+)\}/g)].map((m) => m[1]!);
  return names.filter((n, i) => names.indexOf(n) === i);
}

/** A pinned step's gate and start mode belong to the library step, not to this workflow. */
const PINNED_NOTE = 'Set by the pinned step — make an editable copy to change it.';

function Choice({
  selected,
  title,
  hint,
  disabled,
  onClick,
}: {
  selected: boolean;
  title: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      leftSection={selected ? <IconCheck size={14} /> : <span style={{ width: 14, display: 'inline-block' }} />}
      onClick={onClick}
    >
      <Text size="sm">{title}</Text>
      <Text fz={11} c="dimmed" lh={1.35}>
        {hint}
      </Text>
    </Menu.Item>
  );
}

/** What happens when `from` finishes. */
function GateChoices({
  from,
  last = false,
  onPatch,
}: {
  from: DraftStep;
  last?: boolean;
  onPatch: (patch: Partial<StepContent>) => void;
}) {
  const locked = !!from.ref;
  return (
    <>
      <Menu.Label>When “{nameOf(from)}” finishes</Menu.Label>
      <Choice
        selected={!from.autoAdvance}
        title={gateLabel(false)}
        hint={GATE_HINTS.wait}
        disabled={locked}
        onClick={() => onPatch({ autoAdvance: false })}
      />
      <Choice
        selected={from.autoAdvance}
        title={gateLabel(true, last)}
        hint={last ? 'The workflow finishes as soon as this step does.' : GATE_HINTS.auto}
        disabled={locked}
        onClick={() => onPatch({ autoAdvance: true })}
      />
      {locked && (
        <Text fz={11} c="dimmed" px="sm" pb={4}>
          {PINNED_NOTE}
        </Text>
      )}
    </>
  );
}

/** How `to` starts, given the model of the step before it (if one is known). */
function StartChoices({
  to,
  previousModel,
  onPatch,
}: {
  to: DraftStep;
  previousModel?: string;
  onPatch: (patch: Partial<StepContent>) => void;
}) {
  const locked = !!to.ref;
  const forced = crossesProvider(previousModel, to.model);
  const fresh = to.freshStart || forced;
  return (
    <>
      <Menu.Label>“{nameOf(to)}” starts with</Menu.Label>
      <Choice
        selected={!fresh}
        title={startLabel(false)}
        hint={forced ? 'Not possible here: the conversation cannot move to another provider.' : START_HINTS.same}
        disabled={locked || forced}
        onClick={() => onPatch({ freshStart: false })}
      />
      <Choice
        selected={fresh}
        title={startLabel(true)}
        hint={START_HINTS.fresh}
        disabled={locked}
        onClick={() => onPatch({ freshStart: true })}
      />
      {locked && (
        <Text fz={11} c="dimmed" px="sm" pb={4}>
          {PINNED_NOTE}
        </Text>
      )}
    </>
  );
}

/**
 * Plain dimmed text that opens a menu — or just text, read-only. The tooltip
 * sits on the text inside the button: a Tooltip between Menu.Target and its
 * button would take the menu's aria props for itself.
 */
function TextLink({
  icon,
  text,
  ariaLabel,
  tooltip,
  readOnly,
  wrap = false,
  menu,
}: {
  icon?: ReactNode;
  text: string;
  ariaLabel: string;
  tooltip?: string;
  readOnly: boolean;
  /** Wrap onto a second line rather than cut the text short. */
  wrap?: boolean;
  menu: ReactNode;
}) {
  const label = (
    <span className={styles.linkText}>
      {tooltip ? (
        <Tooltip label={tooltip} withArrow multiline w={260} openDelay={300}>
          <span>{text}</span>
        </Tooltip>
      ) : (
        text
      )}
    </span>
  );
  if (readOnly) {
    return (
      <span className={cn(styles.link, wrap && styles.linkWrap)} data-static aria-label={ariaLabel}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <Menu position="bottom-start" width={300} shadow="md" withinPortal>
      <Menu.Target>
        <UnstyledButton className={cn(styles.link, wrap && styles.linkWrap)} aria-label={`${ariaLabel}. Change`}>
          {icon}
          {label}
          <IconChevronDown size={11} className={styles.linkChevron} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>{menu}</Menu.Dropdown>
    </Menu>
  );
}

/**
 * The link between two steps. It shows — and edits — the two settings that only
 * mean something between steps: the gate, read from the step before (`from`'s
 * `autoAdvance`), and how the next one starts, read from the step after (`to`'s
 * `freshStart`). What `to` reads from earlier steps rides along, so the hand-off
 * is visible without opening either step.
 */
function OutlineConnector({
  from,
  to,
  readOnly,
  hidden,
  dragging,
  dropTarget,
  onPatchFrom,
  onPatchTo,
}: {
  from: DraftStep;
  to: DraftStep;
  readOnly: boolean;
  /** Keeps its height but draws nothing — the connector riding on the dragged row. */
  hidden: boolean;
  /** A drag is in progress: neighbours are about to change, so only the rail shows. */
  dragging: boolean;
  /** The dragged step would land here. */
  dropTarget: boolean;
  onPatchFrom: (patch: Partial<StepContent>) => void;
  onPatchTo: (patch: Partial<StepContent>) => void;
}) {
  const forced = crossesProvider(from.model, to.model);
  // Pinned on both sides: the gate is `from`'s library step's, the start mode
  // `to`'s, so there is nothing here to change — say why instead of a dead menu.
  const locked = !!from.ref && !!to.ref;
  const reads = outputsRead(to.promptTemplate);
  const text = [
    gateLabel(from.autoAdvance),
    forced ? `${startLabel(true)} (required)` : startLabel(to.freshStart),
    ...(reads.length ? [`uses ${reads.join(', ')}`] : []),
  ].join(' · ');
  return (
    <div className={cn(styles.connector, hidden && styles.connectorHidden, dropTarget && styles.connectorDrop)}>
      {!dragging && (
        <TextLink
          icon={from.autoAdvance ? <IconPlayerTrackNext size={12} /> : <IconHandStop size={12} />}
          text={text}
          ariaLabel={`Between “${nameOf(from)}” and “${nameOf(to)}”: ${text}`}
          tooltip={
            forced
              ? `Fresh start required: “${nameOf(from)}” and “${nameOf(to)}” run on different providers, and a conversation cannot move between them.`
              : locked && !readOnly
                ? 'Both steps are pinned, so their library versions set this. Make an editable copy of either to change its side.'
                : undefined
          }
          readOnly={readOnly || locked}
          wrap
          menu={
            <>
              <GateChoices from={from} onPatch={onPatchFrom} />
              <Menu.Divider />
              <StartChoices to={to} previousModel={from.model} onPatch={onPatchTo} />
            </>
          }
        />
      )}
    </div>
  );
}

/** First of a step's validation errors, as the row's second line. */
function firstError(e?: StepErrors): string | undefined {
  if (!e) return undefined;
  return (e.name && `Name: ${e.name}`) || e.prompt || e.ref || e.outputName || e.routing;
}

function OutlineRow({
  step,
  index,
  active,
  error,
  readOnly,
  models,
  owned,
  update,
  unavailable,
  dragging,
  dragHandleProps,
  onSelect,
}: {
  step: DraftStep;
  index: number;
  active: boolean;
  error?: string;
  readOnly: boolean;
  models: ModelOption[];
  owned: boolean;
  update?: StepDef;
  unavailable: boolean;
  dragging: boolean;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  onSelect: () => void;
}) {
  const output = (step.outputName ?? '').trim();
  const meta = [
    modelLabel(models, step.model),
    step.reasoningEffort ? effortLabel(step.reasoningEffort) : null,
    permissionModeLabel(step.permissionMode),
    output ? `→ ${output}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const modelKnown = models.length === 0 || models.some((m) => m.id === step.model);

  const source = step.ref ? (
    <Tooltip
      label={owned ? 'Pinned to a step in your library' : `From ${step.ref.ownerName ?? 'another user'}, read-only`}
      withArrow
    >
      <span className={styles.rowAside}>
        {owned ? <IconPin size={11} /> : <IconLock size={11} />}
        {owned ? `v${step.ref.version}` : `${step.ref.ownerName ?? 'Shared'} · v${step.ref.version}`}
      </span>
    </Tooltip>
  ) : step.publishStepId ? (
    <Tooltip label="Opened for editing from your library, and not saved back there yet" withArrow multiline w={220}>
      <span className={styles.rowAside}>
        <IconPencil size={11} />
        editing
      </span>
    </Tooltip>
  ) : null;

  return (
    <div className={cn(styles.outlineRow, active && styles.rowActive, dragging && styles.outlineRowDragging)}>
      {readOnly ? (
        <span className={styles.grip} aria-hidden />
      ) : (
        <span {...dragHandleProps} className={styles.grip} aria-label={`Drag to reorder ${nameOf(step)}`}>
          <IconGripVertical size={14} />
        </span>
      )}
      <UnstyledButton
        className={styles.rowButton}
        data-step-uid={step._uid}
        aria-current={active ? 'step' : undefined}
        onClick={onSelect}
      >
        <span className={cn(styles.num, active && !error && styles.numActive, !!error && styles.numInvalid)}>
          {index + 1}
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowName}>{nameOf(step)}</span>
          <span className={cn(styles.rowMeta, !!error && styles.rowMetaError)}>{error ?? meta}</span>
        </span>
        {(source || update || unavailable || !modelKnown) && (
          <span className={styles.rowAside} style={{ paddingTop: 2 }}>
            {source}
            {update && (
              <Tooltip label={`Update available — v${update.version}`} withArrow>
                <span className={styles.updateDot} />
              </Tooltip>
            )}
            {(unavailable || !modelKnown) && (
              <Tooltip
                label={unavailable ? 'Pinned step unavailable here' : `Model "${step.model}" is no longer available`}
                withArrow
              >
                <span style={{ display: 'flex', color: 'var(--mantine-color-yellow-5)' }}>
                  <IconAlertTriangle size={12} />
                </span>
              </Tooltip>
            )}
          </span>
        )}
      </UnstyledButton>
    </div>
  );
}

/**
 * The workflow as the order it runs in: start, each step with the link to the
 * next, done. Rows only pick which step the pane edits; everything between two
 * steps (the gate, the start mode) is set on the link itself.
 */
export function StepOutline({
  steps,
  selected,
  readOnly,
  models,
  errors,
  ownsRef,
  updateFor,
  isUnavailable,
  onSelect,
  onPatch,
  onReorder,
  empty,
  addStep,
}: {
  steps: DraftStep[];
  /** The step open in the pane, by uid; null = the workflow itself. */
  selected: string | null;
  readOnly: boolean;
  models: ModelOption[];
  /** Per-step validation errors, once a save has been attempted. */
  errors?: Record<string, StepErrors>;
  ownsRef: (s: DraftStep) => boolean;
  updateFor: (s: DraftStep) => StepDef | undefined;
  isUnavailable: (s: DraftStep) => boolean;
  onSelect: (uid: string) => void;
  onPatch: (uid: string, patch: Partial<StepContent>) => void;
  onReorder: (from: number, to: number) => void;
  /** Shown between start and done while there are no steps. */
  empty?: ReactNode;
  /** The add-step menu; absent when read-only. */
  addStep?: ReactNode;
}) {
  // While dragging: where the dragged step would land, as the index of the step
  // whose top edge borders the gap (`steps.length` = the end), or null for "where
  // it started". Undefined when nothing is being dragged.
  const [dropAt, setDropAt] = useState<number | null | undefined>(undefined);
  const dragging = dropAt !== undefined;
  const first = steps[0];
  const last = steps[steps.length - 1];

  // The library opens a gap where the step will land, carrying each step's
  // connector with it; the line goes on the connector at the gap's lower edge.
  const onDragUpdate = (update: DragUpdate) => {
    const from = update.source.index;
    const to = update.destination?.index;
    setDropAt(to === undefined || to === from ? null : to < from ? to : to + 1);
  };

  const onDragEnd = (result: DropResult) => {
    setDropAt(undefined);
    if (result.destination) onReorder(result.source.index, result.destination.index);
  };

  return (
    <>
      {/* The first step's start mode lives on the start: its predecessor is the
          session itself, so there is no gate to show and no provider to cross. */}
      <div className={styles.cap}>
        <Tooltip label="Runs when the session gets its task" withArrow>
          <span className={styles.capIcon}>
            <IconPlayerPlay size={10} />
          </span>
        </Tooltip>
        <Text size="xs" fw={600}>
          Start
        </Text>
        {first && (
          <TextLink
            text={startLabel(first.freshStart)}
            ariaLabel={`“${nameOf(first)}” starts with: ${startLabel(first.freshStart)}`}
            tooltip={first.ref && !readOnly ? PINNED_NOTE : undefined}
            readOnly={readOnly || !!first.ref}
            menu={<StartChoices to={first} onPatch={(patch) => onPatch(first._uid, patch)} />}
          />
        )}
      </div>

      <DragDropContext onDragStart={() => setDropAt(null)} onDragUpdate={onDragUpdate} onDragEnd={onDragEnd}>
        <Droppable droppableId="steps">
          {(dropProvided) => (
            <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
              {steps.map((step, i) => {
                const previous = steps[i - 1];
                return (
                  <Draggable key={step._uid} draggableId={step._uid} index={i} isDragDisabled={readOnly}>
                    {(dragProvided, dragSnapshot) => (
                      <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                        {/* Inside the draggable, not between them: the library only
                            measures draggables, so anything else in the list would be
                            left behind as the rows shift. */}
                        {previous ? (
                          <OutlineConnector
                            from={previous}
                            to={step}
                            readOnly={readOnly}
                            hidden={dragSnapshot.isDragging}
                            dragging={dragging}
                            dropTarget={dropAt === i}
                            onPatchFrom={(patch) => onPatch(previous._uid, patch)}
                            onPatchTo={(patch) => onPatch(step._uid, patch)}
                          />
                        ) : (
                          <div className={cn(styles.firstLink, dropAt === 0 && styles.connectorDrop)} />
                        )}
                        <OutlineRow
                          step={step}
                          index={i}
                          active={selected === step._uid}
                          error={firstError(errors?.[step._uid])}
                          readOnly={readOnly}
                          models={models}
                          owned={ownsRef(step)}
                          update={updateFor(step)}
                          unavailable={isUnavailable(step)}
                          dragging={dragSnapshot.isDragging}
                          dragHandleProps={dragProvided.dragHandleProps}
                          onSelect={() => onSelect(step._uid)}
                        />
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {dropProvided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
      {steps.length === 0 && empty}

      {/* The last step's gate: it finishes the workflow rather than starting another step. */}
      {last && (
        <div className={cn(styles.connector, dropAt === steps.length && styles.connectorDrop)}>
          {!dragging && (
            <TextLink
              icon={last.autoAdvance ? <IconPlayerTrackNext size={12} /> : <IconHandStop size={12} />}
              text={gateLabel(last.autoAdvance, true)}
              ariaLabel={`After “${nameOf(last)}”: ${gateLabel(last.autoAdvance, true)}`}
              tooltip={last.ref && !readOnly ? PINNED_NOTE : undefined}
              readOnly={readOnly || !!last.ref}
              menu={<GateChoices from={last} last onPatch={(patch) => onPatch(last._uid, patch)} />}
            />
          )}
        </div>
      )}
      <div className={styles.cap}>
        <span className={cn(styles.capIcon, styles.capIconEnd)}>
          <IconSquare size={8} />
        </span>
        <Text size="xs" fw={600}>
          Done
        </Text>
        {addStep}
      </div>
    </>
  );
}
