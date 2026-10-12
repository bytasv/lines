import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionMeta, SessionStatus, WorkflowState } from '@lines/shared';
import {
  compareSessions,
  machineActivity,
  projectStatusMeta,
  sessionRowMeta,
} from '../../web/src/lib/format.ts';

/**
 * How a workflow step's clean park reads in the web UI.
 *
 * The park is `waiting-approval`, but approval only matters for moving on, so it
 * presents like `done`: a calm "step finished" row that lights neither the
 * project tab nor the machine's "needs you" count, and sorts above plain done.
 */

const wf: WorkflowState = {
  workflowId: 'w1',
  stepIndex: 0,
  stepStatuses: ['waiting-approval', 'pending'],
  started: true,
};

const s = (id: string, status: SessionStatus, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, name: id, status, createdAt: 1, updatedAt: 1, ...over }) as SessionMeta;

const park = (id = 'park') => s(id, 'waiting-approval', { workflow: wf });

describe('a clean workflow park', () => {
  test('reads as step finished, not actionable', () => {
    const meta = sessionRowMeta(park());
    assert.equal(meta.label, 'step finished');
    assert.equal(meta.actionable, false);
  });

  test('does not light the project tab', () => {
    assert.equal(projectStatusMeta([park()], {}), null);
    const perm = s('perm', 'waiting-permission', { pendingPermissionTool: 'Bash' });
    assert.equal(projectStatusMeta([park(), perm], {})?.label, 'needs permission');
  });

  test("is not counted as needing the user on the machine summary", () => {
    assert.deepEqual(machineActivity([park()]), { running: 0, actionable: 0 });
  });

  test('sorts after anything that needs the user and before done', () => {
    const sorted = [s('done', 'done'), park(), s('perm', 'waiting-permission')].sort(
      compareSessions('status'),
    );
    assert.deepEqual(
      sorted.map((m) => m.id),
      ['perm', 'park', 'done'],
    );
  });
});
