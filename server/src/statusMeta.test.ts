import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionMeta, SessionStatus, WorkflowState } from '@lines/shared';
import {
  compareSessions,
  machineActivity,
  projectStatusMeta,
  sessionRowMeta,
  tracksSeen,
} from '../../web/src/lib/format.ts';

/**
 * How a workflow step's clean park reads in the web UI.
 *
 * The park is `waiting-approval`, but approval only matters for moving on, so it
 * presents like `done`: a calm "step finished" row that lights the project tab
 * only as a steady recent-finish dot, never the machine's "needs you" count, and
 * sorts above plain done.
 */

const HOUR = 60 * 60 * 1000;
const now = 100 * HOUR;

const wf: WorkflowState = {
  workflowId: 'w1',
  stepIndex: 0,
  stepStatuses: ['waiting-approval', 'pending'],
  started: true,
};

const s = (id: string, status: SessionStatus, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, name: id, status, createdAt: 1, updatedAt: now - HOUR, ...over }) as SessionMeta;

const park = (id = 'park') => s(id, 'waiting-approval', { workflow: wf });

describe('a clean workflow park', () => {
  test('reads as step finished, not actionable', () => {
    const meta = sessionRowMeta(park());
    assert.equal(meta.label, 'step finished');
    assert.equal(meta.actionable, false);
  });

  test('lights the project tab as a steady dot only while recent and unseen', () => {
    assert.deepEqual(projectStatusMeta([park()], {}, now), {
      color: 'green',
      label: 'step finished',
      pulse: false,
    });
    assert.equal(projectStatusMeta([park()], { park: 'step finished' }, now), null);
    const old = s('park', 'waiting-approval', { workflow: wf, updatedAt: now - 25 * HOUR });
    assert.equal(projectStatusMeta([old], {}, now), null);
    const perm = s('perm', 'waiting-permission', { pendingPermissionTool: 'Bash' });
    assert.equal(projectStatusMeta([park(), perm], {}, now)?.label, 'needs permission');
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

describe('project tab dot', () => {
  test('running reads as a steady blue dot, whatever the seen map says', () => {
    assert.deepEqual(projectStatusMeta([s('r', 'running')], { r: 'running' }, now), {
      color: 'blue',
      label: 'running',
      pulse: false,
    });
  });

  test('a settled turn with background tasks reads as steady background work', () => {
    const bg = s('bg', 'done', { backgroundTasks: [{}] as SessionMeta['backgroundTasks'] });
    const dot = projectStatusMeta([bg], {}, now);
    assert.equal(dot?.label, 'background work');
    assert.equal(dot?.pulse, false);
  });

  test('actionable beats live, and live beats a recent finish', () => {
    const perm = s('perm', 'waiting-permission');
    const run = s('run', 'running');
    const done = s('done', 'done');
    assert.deepEqual(projectStatusMeta([done, run, perm], {}, now), {
      color: 'yellow',
      label: 'needs permission',
      pulse: true,
    });
    assert.equal(projectStatusMeta([done, run], {}, now)?.label, 'running');
  });

  test('done lights green only while unseen and within 24h', () => {
    assert.deepEqual(projectStatusMeta([s('d', 'done')], {}, now), {
      color: 'green',
      label: 'done',
      pulse: false,
    });
    assert.equal(projectStatusMeta([s('d', 'done')], { d: 'done' }, now), null);
    assert.equal(projectStatusMeta([s('d', 'done', { updatedAt: now - 25 * HOUR })], {}, now), null);
  });

  test('archived and idle sessions never light the tab', () => {
    assert.equal(projectStatusMeta([s('a', 'done', { archived: true })], {}, now), null);
    assert.equal(projectStatusMeta([s('i', 'idle')], {}, now), null);
  });

  test('tracksSeen covers actionable states and finishes, not live work', () => {
    const meta = (m: SessionMeta) => sessionRowMeta(m);
    assert.equal(tracksSeen(meta(s('p', 'waiting-permission'))), true);
    assert.equal(tracksSeen(meta(s('e', 'error'))), true);
    assert.equal(tracksSeen(meta(s('d', 'done'))), true);
    assert.equal(tracksSeen(meta(park())), true);
    assert.equal(tracksSeen(meta(s('r', 'running'))), false);
    assert.equal(tracksSeen(meta(s('i', 'idle'))), false);
    const bg = s('bg', 'done', { backgroundTasks: [{}] as SessionMeta['backgroundTasks'] });
    assert.equal(tracksSeen(meta(bg)), false);
  });
});
