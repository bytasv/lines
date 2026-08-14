import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconGitBranch } from '@tabler/icons-react';
import type { Project } from '@lines/shared';
import { ConfirmModal } from './ConfirmModal';
import { useStore } from '../store';
import { send } from '../ws';

/**
 * Create one work tree, or manage (and remove) an existing one.
 *
 * A modal rather than the red-row-per-root pattern `extraRoots` uses, because
 * removal needs two controls a `Menu.Item` cannot host: a checkbox for the branch,
 * and a "Remove anyway" escalation that only appears *after* git has refused once.
 */
export function WorktreeModal({
  project,
  target,
  onClose,
}: {
  project: Project;
  /** null = the create form; a path = manage that record. */
  target: string | null;
  onClose: () => void;
}) {
  const actionError = useStore((s) => s.actionError);
  const setActionError = useStore((s) => s.setActionError);
  const sessions = useStore((s) => s.sessions);

  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [path, setPath] = useState('');
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Only a refusal *this* modal provoked may offer the escalation.
  const [attempted, setAttempted] = useState(false);
  const [awaitingBranch, setAwaitingBranch] = useState<string | null>(null);

  const record = target ? (project.worktrees ?? []).find((w) => w.path === target) : null;
  const session = record?.sessionId ? sessions[record.sessionId] : undefined;
  const refused = attempted && actionError !== null;

  // A stale notice from an earlier action would read as this one's refusal.
  useEffect(() => {
    setActionError(null);
    setAttempted(false);
    setAwaitingBranch(null);
    setDeleteBranch(false);
  }, [target, setActionError]);

  // There is no ack for either action, so success is read off the record list the
  // `projects` broadcast carries: the new branch appeared, or the record is gone.
  const created = awaitingBranch !== null && (project.worktrees ?? []).some((w) => w.branch === awaitingBranch);
  const removed = target !== null && !record;
  useEffect(() => {
    if (created || removed) onClose();
  }, [created, removed, onClose]);

  const create = () => {
    const name = branch.trim();
    if (!name) return;
    setAttempted(true);
    setAwaitingBranch(name);
    send({
      type: 'createWorktree',
      project: project.path,
      branch: name,
      ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
      ...(path.trim() ? { path: path.trim() } : {}),
    });
  };

  const remove = (force: boolean) => {
    if (!target) return;
    setAttempted(true);
    setActionError(null);
    send({
      type: 'removeWorktree',
      project: project.path,
      path: target,
      ...(deleteBranch ? { deleteBranch: true } : {}),
      ...(force ? { force: true } : {}),
    });
  };

  return (
    <>
      <Modal
        opened={!confirming}
        onClose={onClose}
        title={target ? 'Worktree' : 'New worktree'}
        size="md"
        centered
      >
        <Stack gap="sm">
          {target ? (
            record ? (
              <>
                {/* The session's name leads when there is one: the branch was minted
                    before any prompt existed, so it names nothing, while the session
                    gets an auto-title a few seconds in. */}
                {session && (
                  <Text size="sm" fw={600}>
                    {session.name}
                  </Text>
                )}
                <Group gap={6} wrap="nowrap">
                  <IconGitBranch size={14} />
                  <Text size="sm" fw={session ? 400 : 600} c={session ? 'dimmed' : undefined}>
                    {record.branch ?? 'detached'}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" ff="monospace">
                  {record.path}
                </Text>
                {record.sessionId && !session && (
                  <Text size="xs" c="dimmed">
                    Its session is gone — the files here are not.
                  </Text>
                )}
                {record.baseRef && (
                  <Text size="xs" c="dimmed">
                    cut from {record.baseRef}
                  </Text>
                )}
                {/* Only a branch Lines created may be deleted — never one that was
                    already there when the work tree was adopted. */}
                {record.createdByLines && record.branch && (
                  <Checkbox
                    size="xs"
                    label={`Also delete branch ${record.branch}`}
                    checked={deleteBranch}
                    onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                  />
                )}
                {refused && (
                  <Alert color="red" icon={<IconAlertTriangle size={16} />} py={6}>
                    <Text size="xs">{actionError}</Text>
                  </Alert>
                )}
                <Group justify="flex-end" gap="xs">
                  <Button variant="default" size="compact-sm" onClick={onClose}>
                    Close
                  </Button>
                  {/* Offered only after a refusal, never as the default: past this
                      point uncommitted work goes with no reflog to recover it. */}
                  {refused && (
                    <Button color="red" variant="light" size="compact-sm" onClick={() => remove(true)}>
                      Remove anyway
                    </Button>
                  )}
                  <Button color="red" size="compact-sm" onClick={() => setConfirming(true)}>
                    Remove
                  </Button>
                </Group>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                This worktree is no longer registered.
              </Text>
            )
          ) : (
            <>
              <TextInput
                size="xs"
                label="Branch"
                placeholder="feature/my-change"
                description="Created fresh off the base ref below."
                value={branch}
                onChange={(e) => setBranch(e.currentTarget.value)}
                data-autofocus
              />
              <TextInput
                size="xs"
                label="Base ref"
                placeholder="HEAD"
                value={baseRef}
                onChange={(e) => setBaseRef(e.currentTarget.value)}
              />
              {/* Typed, not picked: the native picker is macOS-only and picks
                  directories that already exist, while a work-tree path must not. */}
              <TextInput
                size="xs"
                label="Path"
                // No computed hint: the default lives under the app's own directory
                // on the *bridge* machine, which this browser cannot know.
                description="Leave empty to let Lines manage the folder."
                placeholder="~/.lines-app/worktrees/<repo>/<branch>"
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
                styles={{ input: { fontFamily: 'monospace' } }}
              />
              {refused && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} py={6}>
                  <Text size="xs">{actionError}</Text>
                </Alert>
              )}
              <Group justify="flex-end" gap="xs">
                <Button variant="default" size="compact-sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button size="compact-sm" disabled={!branch.trim()} onClick={create}>
                  Create
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
      {/* The copy is `removeProjectRoot`'s, inverted: this one does delete files. */}
      <ConfirmModal
        opened={confirming}
        title="Remove worktree"
        message={`Remove ${target ?? ''}? Its files are deleted from disk.`}
        confirmLabel="Remove"
        confirmColor="red"
        onConfirm={() => {
          setConfirming(false);
          remove(false);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
