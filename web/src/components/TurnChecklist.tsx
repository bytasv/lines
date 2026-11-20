import { Fragment, memo, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Box, Collapse, Group, Stack, Text } from '@mantine/core';
import { IconCheck, IconExclamationMark, type Icon } from '@tabler/icons-react';
import { activityOnScreen, type ActivityHandoff } from '../lib/activityHandoff';
import { MAIN_AGENT_META } from '../lib/agents';
import { groupDiffTotals, groupSummary, type TranscriptItem } from '../lib/transcript';
import type { TurnEntry, TurnStep } from '../lib/turnSteps';
import { useChangeKey } from '../lib/useChangeKey';
import { CrossfadeLine } from './CrossfadeLine';
import { Reveal } from './Reveal';
import { ShimmerText } from './ShimmerText';

/** A step label as data, so CrossfadeLine can render the outgoing one too. */
interface LabelValue {
  label: string;
  status: TurnStep['status'];
  /** Only on a hand-off from the activity row: its ` · 12s`. */
  suffix?: string;
}

const sameLabel = (a: LabelValue, b: LabelValue) => a.label === b.label && a.status === b.status;

// Every label is dimmed but a failure's; in progress, dimmed is the shimmer's base
// colour, so the ellipsis matches the sweep.
const labelTone = (v: LabelValue) =>
  v.status === 'failed' ? 'var(--mantine-color-red-text)' : 'var(--mantine-color-dimmed)';

const renderLabel = (v: LabelValue) => (
  <>
    {v.status === 'active' ? <ShimmerText>{v.label}</ShimmerText> : v.label}
    {v.suffix}
  </>
);

// Sticky per-step override, keyed `${sessionId}:${step.key}`. Module scope so it
// survives Transcript remount and rebuilds, like ToolGroup's stickyOverrides.
const stepOverrides = new Map<string, boolean>();

/** What an icon slot can show: a step status, or the agent glyph the activity row had. */
type IconKind = TurnStep['status'] | 'agent';

function StepIcon({
  kind,
  glyph = MAIN_AGENT_META.icon,
  className,
  onAnimationEnd,
}: {
  kind: IconKind;
  /** The glyph for `agent`: whichever the activity row was showing. */
  glyph?: Icon;
  className?: string;
  onAnimationEnd?: () => void;
}) {
  const props = (variant: string, label: string) => ({
    className: `tx-step-icon tx-step-icon-${variant}${className ? ` ${className}` : ''}`,
    'aria-label': label,
    onAnimationEnd,
  });
  if (kind === 'agent') {
    const Glyph = glyph;
    return (
      <span {...props('agent', 'working')}>
        <Glyph size={15} />
      </span>
    );
  }
  // The label's shimmer is the liveness cue (as in ActivityRow), so no spinner here.
  if (kind === 'active') return <span {...props('active', 'in progress')} />;
  if (kind === 'pending') return <span {...props('pending', 'pending')} />;
  if (kind === 'failed') {
    return (
      <span {...props('failed', 'failed')}>
        <IconExclamationMark size={12} stroke={3} />
      </span>
    );
  }
  return (
    <span {...props('done', 'done')}>
      <IconCheck size={12} stroke={3} />
    </span>
  );
}

/**
 * The step icon, crossfading on a status change: the old icon fades out on top
 * of the new one fading in, so the slot is never empty for a frame.
 * `introGlyph` starts the row on the glyph the activity row it replaces was
 * showing, crossfading from it.
 */
function IconSlot({ status, introGlyph }: { status: TurnStep['status']; introGlyph?: Icon }) {
  // `faded` as in CrossfadeLine: the current icon animates in for its lifetime.
  const [shown, setShown] = useState<{ cur: IconKind; prev: IconKind | null; n: number; faded: boolean }>(() => ({
    cur: status,
    prev: introGlyph ? 'agent' : null,
    n: 0,
    faded: !!introGlyph,
  }));
  if (shown.cur !== status) setShown({ cur: status, prev: shown.cur, n: shown.n + 1, faded: true });
  const { cur, prev, n, faded } = shown;
  return (
    <span className="tx-step-slot">
      {prev && (
        <StepIcon
          key={`out${n}`}
          kind={prev}
          glyph={introGlyph}
          className="tx-icon-out"
          onAnimationEnd={() => setShown((s) => (s.n === n ? { ...s, prev: null } : s))}
        />
      )}
      <StepIcon key={`in${n}`} kind={cur} className={faded ? 'tx-icon-in' : undefined} />
    </span>
  );
}

const StepRow = memo(function StepRow({
  step,
  sessionId,
  renderItem,
  meta,
  enter,
  intro,
}: {
  step: TurnStep;
  sessionId: string;
  renderItem: (item: TranscriptItem) => ReactNode;
  /** Trailing figures (the turn's cost and time), on the last row only. */
  meta?: ReactNode;
  /** The row is new since the checklist mounted: it grows in. Read once, at mount. */
  enter: boolean;
  /** What the activity row this row replaces was showing: the row starts on it
   *  and crossfades to its own icon and label. Read once, at mount. */
  intro: ActivityHandoff | null;
}) {
  const label = useMemo<LabelValue>(() => ({ label: step.label, status: step.status }), [step.label, step.status]);
  // The figures appear on a row that is already there (the first spend estimate):
  // fade them in. Moving to a new last row needs nothing, that row grows in.
  const metaKey = useChangeKey(meta != null);
  const k = `${sessionId}:${step.key}`;
  const [override, setOverride] = useState<boolean | null>(() => stepOverrides.get(k) ?? null);
  // Closed until the user opens it, the live step included: the rows are the summary.
  const expanded = override ?? false;
  const toggle = () => {
    stepOverrides.set(k, !expanded);
    setOverride(!expanded);
  };
  // Diffs every edit in the step; `step.tools` only changes when the turn does.
  const { tally, totals } = useMemo(
    () => ({
      // One call is already named by the label; a tally would only repeat it.
      tally: step.tools.length > 1 ? groupSummary(step.tools) : null,
      totals: groupDiffTotals(step.tools),
    }),
    [step.tools],
  );
  // A planned task nothing has happened under yet: nothing to open.
  const empty = step.items.length === 0;

  return (
    <Reveal on={enter}>
      <Group
        className={empty ? 'tx-row tx-step tx-static' : 'tx-row tx-step'}
        gap="xs"
        wrap="nowrap"
        justify="space-between"
        {...(empty
          ? {}
          : {
              onClick: toggle,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': expanded,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              },
            })}
      >
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <IconSlot status={step.status} introGlyph={intro?.glyph} />
          {/* A new label or status crossfades: active → done fades the shimmer out. */}
          <Text size="sm" component="div" style={{ minWidth: 0, flex: 1 }}>
            <CrossfadeLine
              value={label}
              same={sameLabel}
              tone={labelTone}
              render={renderLabel}
              from={intro ? { label: intro.label, status: 'active', suffix: intro.suffix } : null}
            />
          </Text>
        </Group>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          {tally && (
            <Text size="xs" c="dimmed" visibleFrom="xs">
              {tally}
            </Text>
          )}
          {totals && (
            <Text size="xs" ff="monospace">
              <Text span c="teal">
                +{totals.added}
              </Text>{' '}
              <Text span c="red">
                −{totals.removed}
              </Text>
            </Text>
          )}
          {meta != null && (
            <Box key={metaKey} className={metaKey > 0 ? 'tx-fade' : undefined}>
              {meta}
            </Box>
          )}
        </Group>
      </Group>
      {/* Only an open step renders its detail: a finished turn is mostly closed rows. */}
      <Collapse expanded={expanded && !empty} transitionDuration={150}>
        {expanded && !empty && (
          <Stack gap={6} className="tx-step-detail">
            {step.items.map((item) => (
              <Fragment key={item.key}>{renderItem(item)}</Fragment>
            ))}
          </Stack>
        )}
      </Collapse>
    </Reveal>
  );
});

/**
 * A folded turn's body as a checklist (Compact level). Passthrough items — a
 * pending permission, a failed result with Retry — render inline between rows,
 * never inside a step.
 */
export function TurnChecklist({
  entries,
  sessionId,
  renderItem,
  meta,
  live,
}: {
  entries: TurnEntry[];
  sessionId: string;
  /** Renders one transcript item the way the turn card would (Transcript's `Item`). */
  renderItem: (item: TranscriptItem) => ReactNode;
  /** The turn's cost and time, shown at the end of the last step row. */
  meta?: ReactNode;
  /** The turn's steps are live. Read once, at mount. */
  live: boolean;
}) {
  // What the checklist mounted with is already in place on a reload or a scroll
  // back: nothing animates. A live turn's first rows take over the activity
  // row's slot in place; if there was no activity row on screen (the first tool
  // call beat its settle delay), they grow in like everything added later.
  // Frozen at mount, so a row's answer never flips and an animation can't replay.
  const [initial] = useState(() => new Set(entries.map((e) => (e.kind === 'step' ? e.key : e.item.key))));
  // The activity row this checklist is replacing, if it was on screen a frame
  // ago: its in-progress row starts on that text and glyph and crossfades.
  const [handoff] = useState(() => (live ? activityOnScreen(sessionId) : null));
  const [introKey] = useState(() =>
    handoff ? (entries.find((e): e is TurnStep => e.kind === 'step' && e.status === 'active')?.key ?? null) : null,
  );
  const [growFirst] = useState(() => live && introKey === null);
  const isNew = (key: string) => growFirst || !initial.has(key);
  let lastStep: string | null = null;
  for (const e of entries) if (e.kind === 'step') lastStep = e.key;
  return (
    <Stack gap={2}>
      {entries.map((entry) =>
        entry.kind === 'step' ? (
          <StepRow
            key={entry.key}
            step={entry}
            sessionId={sessionId}
            renderItem={renderItem}
            meta={entry.key === lastStep ? meta : undefined}
            enter={isNew(entry.key)}
            intro={entry.key === introKey ? handoff : null}
          />
        ) : (
          <Reveal key={entry.item.key} on={isNew(entry.item.key)}>
            {renderItem(entry.item)}
          </Reveal>
        ),
      )}
    </Stack>
  );
}
