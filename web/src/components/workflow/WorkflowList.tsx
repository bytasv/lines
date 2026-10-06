import { Box, Button, Menu, ScrollArea, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import type { UntrustedMark, WorkflowDef } from '@lines/shared';
import { WORKFLOW_PRESETS } from '../../lib/workflowPresets';
import type { WorkflowPreset } from '../../lib/workflowPresets';
import { UntrustedBadge } from './UntrustedReview';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

function DirtyDot() {
  return (
    <Box
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--mantine-primary-color-filled)',
        flexShrink: 0,
      }}
    />
  );
}

const stepCount = (w: WorkflowDef) => `${w.steps.length} step${w.steps.length === 1 ? '' : 's'}`;

export function WorkflowList({
  workflows,
  sharedWorkflows,
  selectedId,
  dirty,
  markOf,
  onSelect,
  onNew,
}: {
  workflows: WorkflowDef[];
  sharedWorkflows: WorkflowDef[];
  selectedId: string | null;
  dirty: boolean;
  /** Why this machine will not run a workflow yet — its own mark or a pinned step's. */
  markOf?: (w: WorkflowDef) => UntrustedMark | undefined;
  onSelect: (w: WorkflowDef) => void;
  onNew: (preset: WorkflowPreset | null) => void;
}) {
  // An id in both lists is the user's own (a stale shared snapshot, or their own
  // published row pulled back under a second identity) — render it once, above.
  const foreign = sharedWorkflows.filter((s) => !workflows.some((w) => w.id === s.id));
  return (
    <div className={styles.listColumn} style={{ width: 'clamp(190px, 15vw, 230px)' }}>
      <ScrollArea style={{ flex: 1 }} type="hover">
        <div className={styles.listBody}>
          <div className={styles.listSection}>Your workflows</div>
          {workflows.map((w) => (
            <UnstyledButton
              key={w.id}
              className={cn(styles.listRow, w.id === selectedId && styles.rowActive)}
              onClick={() => onSelect(w)}
            >
              <span className={styles.rowText}>
                <span className={styles.rowName}>{w.name}</span>
                <span className={styles.rowMeta}>
                  {stepCount(w)}
                  {w.published ? ' · shared' : ''}
                </span>
              </span>
              <UntrustedBadge mark={markOf?.(w)} ownerName={w.ownerName} />
              {w.id === selectedId && dirty && <DirtyDot />}
            </UnstyledButton>
          ))}
          {workflows.length === 0 && (
            <Text size="xs" c="dimmed" px={10} py={6}>
              No workflows yet.
            </Text>
          )}
          {foreign.length > 0 && (
            <>
              <div className={styles.listSection}>Shared by others</div>
              {foreign.map((w) => (
                <UnstyledButton
                  key={w.id}
                  className={cn(styles.listRow, w.id === selectedId && styles.rowActive)}
                  onClick={() => onSelect(w)}
                >
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{w.name}</span>
                    <span className={styles.rowMeta}>
                      {w.ownerName ?? 'Unknown'} · {stepCount(w)}
                    </span>
                  </span>
                  <UntrustedBadge mark={markOf?.(w)} ownerName={w.ownerName} />
                </UnstyledButton>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <Box p={10}>
        <Menu position="bottom-start" width={240} withinPortal>
          <Menu.Target>
            <Button
              fullWidth
              variant="default"
              leftSection={<IconPlus size={13} />}
              rightSection={<IconChevronDown size={13} />}
            >
              New workflow
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => onNew(null)}>Blank workflow</Menu.Item>
            <Menu.Label>From preset</Menu.Label>
            {WORKFLOW_PRESETS.map((p) => (
              <Menu.Item key={p.id} onClick={() => onNew(p)}>
                <Text size="sm">{p.name}</Text>
                <Text size="xs" c="dimmed">
                  {p.description}
                </Text>
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Box>
    </div>
  );
}
