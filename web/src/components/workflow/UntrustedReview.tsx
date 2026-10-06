import { useState } from 'react';
import { Badge, Button, Code, Group, Modal, Paper, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { IconShieldQuestion } from '@tabler/icons-react';
import type { ClientMessage, RecipeDef, StepContent, StepDef, UntrustedMark, WorkflowDef } from '@lines/shared';
import { isBundle, isStepRef } from '@lines/shared';
import { PERMISSION_MODES } from '../../lib/permissionModes';
import { send } from '../../ws';
import { ConfirmModal } from '../ConfirmModal';

type TrustMessage = Extract<ClientMessage, { type: 'trustSyncedItem' }>;

/**
 * Whether the bridge refuses to run what carries this mark. A mark with
 * `held: false` only records provenance — a machine this account trusts signed
 * it, or strict sync is off and it arrived unsigned — and nothing waits on it.
 */
export function isHeld(mark?: UntrustedMark): boolean {
  return !!mark && mark.held !== false;
}

/**
 * Whether a mark is something to show the user: every one except the record
 * that a machine the account trusts signed the item. That content is the
 * user's own, so it gets no badge, no banner and no review.
 */
export function needsReview(mark?: UntrustedMark): mark is UntrustedMark {
  return !!mark && !(mark.reason === 'unknown-signer' && mark.held === false);
}

/** Why an item is marked, in the words the badge tooltip and the review both use. */
export function untrustedReason(mark: UntrustedMark, ownerName?: string): string {
  const why = (() => {
    switch (mark.reason) {
      case 'unsigned':
        return 'It arrived through cloud sync without a signature from any of your machines — from an older version of Lines, or from something that is not Lines at all.';
      case 'forged':
        return 'Its signature does not match its content: it was changed after it was signed — by an older version of Lines on another machine, or by something else.';
      case 'unknown-signer':
        return `It was signed by another machine (fingerprint ${mark.signerFingerprint ?? 'unavailable'}), and this one only runs another machine’s content once you have reviewed it — or trusted that machine.`;
      case 'foreign':
        return `Published by ${ownerName ?? 'another user'}, and not reviewed on this machine yet.`;
    }
  })();
  return isHeld(mark)
    ? why
    : `${why} It still runs here because strict sync is off on this machine, but it is never signed as this machine’s own.`;
}

/** The marker for an item this machine has not verified. Renders nothing for a trusted one. */
export function UntrustedBadge({ mark, ownerName }: { mark?: UntrustedMark; ownerName?: string }) {
  if (!needsReview(mark)) return null;
  return (
    <Tooltip label={untrustedReason(mark, ownerName)} multiline w={260} withArrow>
      <Badge
        size="xs"
        variant="light"
        color="orange"
        tt="none"
        leftSection={<IconShieldQuestion size={10} />}
        style={{ flexShrink: 0 }}
      >
        {mark.reason === 'foreign' ? 'Not reviewed' : 'Unverified'}
      </Badge>
    </Tooltip>
  );
}

/**
 * One thing a review shows: what the user reads, and — when it is held back —
 * the confirmation that allowing it sends. An item without a mark is shown for
 * context only (a workflow's own inline steps, say, which its mark covers).
 */
export interface ReviewItem {
  key: string;
  title: string;
  ownerName?: string;
  mark?: UntrustedMark;
  /** Settings that change what the prompt is allowed to do, shown beside it. */
  details?: string[];
  /** The full text that would run, never a summary. */
  prompt: string;
  trust?: TrustMessage;
}

const modeLabel = (mode: string) => PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;

function stepDetails(content: StepContent): string[] {
  return [
    `Permission mode: ${modeLabel(content.permissionMode)}`,
    `Model: ${content.model}`,
    content.autoAdvance ? 'Runs the next step without waiting' : 'Waits for approval before the next step',
  ];
}

/** A step version's review item — the step library's, and each pinned step of a workflow's. */
export function stepReviewItem(def: StepDef, title = def.name): ReviewItem {
  return {
    key: `step:${def.ownerId}/${def.id}/${def.version}`,
    title,
    ownerName: def.ownerName,
    mark: def.untrusted,
    details: stepDetails(def),
    prompt: def.promptTemplate,
    trust: def.untrusted && {
      type: 'trustSyncedItem',
      kind: 'step',
      ownerId: def.ownerId,
      id: def.id,
      version: def.version,
      digest: def.untrusted.digest,
    },
  };
}

/**
 * Everything one workflow runs, step by step: its inline prompts (covered by
 * the workflow's own mark) and each pinned version, resolved through `lookup`
 * to the exact content that would run, each with a mark of its own.
 */
export function workflowReviewItems(
  wf: WorkflowDef,
  lookup: (ownerId: string, stepId: string, version: number) => StepDef | undefined,
  ownerId: string,
): ReviewItem[] {
  const steps = wf.steps.map((step, i): ReviewItem => {
    if (!isStepRef(step)) {
      return { key: `inline:${i}`, title: `Step ${i + 1} · ${step.name}`, details: stepDetails(step), prompt: step.promptTemplate };
    }
    const pinned = lookup(step.ownerId, step.stepId, step.version);
    // Only the exact pin: the resolver's latest-version fallback is not what runs.
    if (!pinned || pinned.version !== step.version) {
      return { key: `ref:${i}`, title: `Step ${i + 1} · pinned step not available here`, prompt: '' };
    }
    return stepReviewItem(pinned, `Step ${i + 1} · ${pinned.name} (pinned v${pinned.version})`);
  });
  const own: ReviewItem = {
    key: `workflow:${wf.id}`,
    title: `Workflow “${wf.name}”`,
    ownerName: wf.ownerName,
    mark: wf.untrusted,
    prompt: '',
    trust: wf.untrusted && {
      type: 'trustSyncedItem',
      kind: 'workflow',
      ownerId: wf.ownerId ?? ownerId,
      id: wf.id,
      digest: wf.untrusted.digest,
    },
  };
  return [own, ...steps];
}

/** A recipe's review item. A bundle's content is its member list, which is what is shown. */
export function recipeReviewItem(def: RecipeDef, resolve: (ownerId: string, id: string) => RecipeDef | undefined): ReviewItem {
  return {
    key: `recipe:${def.ownerId}/${def.id}/${def.version}`,
    title: `Recipe “${def.title}”`,
    ownerName: def.ownerName,
    mark: def.untrusted,
    prompt: isBundle(def)
      ? (def.members ?? [])
          .map((m, i) => `${i + 1}. ${resolve(m.ownerId, m.recipeId)?.title ?? 'Unavailable recipe'}`)
          .join('\n')
      : def.prompt,
    trust: def.untrusted && {
      type: 'trustSyncedItem',
      kind: 'recipe',
      ownerId: def.ownerId,
      id: def.id,
      version: def.version,
      digest: def.untrusted.digest,
    },
  };
}

function ReviewRow({ item }: { item: ReviewItem }) {
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" fw={600} style={{ flex: 1, minWidth: 0 }} truncate>
          {item.title}
        </Text>
        <UntrustedBadge mark={item.mark} ownerName={item.ownerName} />
      </Group>
      {item.mark && (
        <Text size="xs" c="orange">
          {untrustedReason(item.mark, item.ownerName)}
        </Text>
      )}
      {item.details?.map((d) => (
        <Text key={d} size="xs" c="dimmed">
          {d}
        </Text>
      ))}
      {item.prompt && (
        <Code block style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
          {item.prompt}
        </Code>
      )}
    </Stack>
  );
}

/**
 * The review gate for synced content this machine will not run yet — the same
 * shape as the memory and connections reviews: the whole text that would run,
 * then an explicit choice. Allowing sends one `trustSyncedItem` per held-back
 * item, each echoing the digest of exactly what is on screen, so content that
 * changed meanwhile is refused by the bridge rather than trusted unseen.
 */
export function UntrustedReviewModal({
  opened,
  title,
  items,
  onClose,
}: {
  opened: boolean;
  title: string;
  items: ReviewItem[];
  onClose: () => void;
}) {
  // What the dialog shows is frozen when it opens, and the confirmation sends
  // exactly those digests: content that changes while it is open is not what the
  // user read, so the bridge refuses the stale digest rather than this dialog
  // quietly re-rendering and confirming the new text.
  const [frozen, setFrozen] = useState<ReviewItem[] | null>(null);
  if (opened && frozen === null) setFrozen(items);
  if (!opened && frozen !== null) setFrozen(null);
  const shown = frozen ?? items;
  const marked = shown.filter((i) => needsReview(i.mark) && i.trust);
  const allow = () => {
    for (const item of marked) send(item.trust!);
    onClose();
  };
  // The other machines whose signature is the only thing holding something here
  // back — each offered separately, and deliberately, as a machine to trust.
  const machines = [
    ...new Map(
      marked
        .map((i) => i.mark!)
        .filter((m) => m.reason === 'unknown-signer' && m.signer && m.signerFingerprint)
        .map((m) => [m.signer!, { key: m.signer!, fingerprint: m.signerFingerprint! }] as const),
    ).values(),
  ];
  const [trusting, setTrusting] = useState<{ key: string; fingerprint: string } | null>(null);
  const trustMachine = () => {
    if (!trusting) return;
    send({ type: 'trustSigner', key: trusting.key, fingerprint: trusting.fingerprint });
    setTrusting(null);
    onClose();
  };
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" centered>
      <Stack gap="sm">
        <Text size="sm">
          This runs as prompts on this machine, with your permissions. Nothing here runs until you allow it, so read
          what it does first.
        </Text>
        <ScrollArea.Autosize mah={440} type="auto">
          <Stack gap="md" pr="xs">
            {shown.map((item) => (
              <ReviewRow key={item.key} item={item} />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Text size="xs" c="dimmed">
          Allowing approves exactly what is shown here — not the machine or person it came from. A later change to any
          of it is held back for review again.
        </Text>
        {machines.map((m) => (
          <Paper key={m.key} withBorder radius="md" p="xs">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text size="xs">Signed by another machine</Text>
                <Code>{m.fingerprint}</Code>
              </Stack>
              <Button size="xs" variant="default" onClick={() => setTrusting(m)}>
                Trust this machine…
              </Button>
            </Group>
          </Paper>
        ))}
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={onClose}>
            Not now
          </Button>
          <Button color="orange" disabled={marked.length === 0} onClick={allow}>
            Allow on this machine
          </Button>
        </Group>
      </Stack>
      <ConfirmModal
        opened={!!trusting}
        title="Trust this machine?"
        message={
          `Only do this if Settings → Sync on one of your own other machines shows exactly this fingerprint: ` +
          `${trusting?.fingerprint ?? ''}. A fingerprint you have not seen there could be anyone's. Once trusted, ` +
          'everything that machine signs — what is held back now and whatever it signs later — runs here without ' +
          'a review, until you remove it in Settings → Sync.'
        }
        confirmLabel="Trust this machine"
        confirmColor="orange"
        onConfirm={trustMachine}
        onCancel={() => setTrusting(null)}
      />
    </Modal>
  );
}
