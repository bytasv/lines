import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InlineStep, StepDef, WorkflowDef } from '@lines/shared';
import { isStepRef } from '@lines/shared';
import { inlineWorkflow } from '../../web/src/lib/machines.ts';

/**
 * A guest's own workflow, made self-contained before it travels to the host.
 *
 * The host has none of the guest's step library, so every ref has to be swapped
 * for its content on the guest's side — and a ref that cannot be resolved must
 * stop the launch rather than run a workflow with a step missing.
 */

const inline = (name: string): InlineStep => ({
  name,
  promptTemplate: `Run ${name}`,
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  autoAdvance: false,
  freshStart: false,
});

const version = (stepId: string, v: number, name: string): StepDef => ({
  ...inline(name),
  id: stepId,
  ownerId: 'u-2',
  ownerName: 'Ana',
  version: v,
  published: true,
});

const def: WorkflowDef = {
  id: 'wf-1',
  name: 'Mine',
  steps: [inline('first'), { kind: 'ref', stepId: 'st-1', ownerId: 'u-2', version: 1 }],
};

describe('inlineWorkflow', () => {
  test('every ref becomes its pinned content, inline steps pass through', () => {
    const out = inlineWorkflow(def, [], [version('st-1', 1, 'pinned'), version('st-1', 2, 'latest')]);
    assert.ok(out);
    assert.equal(out.id, 'wf-1');
    assert.equal(out.steps.some(isStepRef), false);
    assert.deepEqual(
      out.steps.map((s) => (s as InlineStep).name),
      ['first', 'pinned'],
    );
  });

  test('the library identity stays behind', () => {
    const out = inlineWorkflow(def, [], [version('st-1', 1, 'pinned')]);
    const step = out!.steps[1] as unknown as Record<string, unknown>;
    for (const key of ['id', 'ownerId', 'ownerName', 'version', 'published', 'kind']) {
      assert.equal(key in step, false, `${key} must not travel`);
    }
  });

  test('a missing exact pin falls back to the latest version known', () => {
    const out = inlineWorkflow(def, [version('st-1', 3, 'library')], []);
    assert.equal((out!.steps[1] as InlineStep).name, 'library');
  });

  test('shared steps resolve too', () => {
    const out = inlineWorkflow(def, [], [], [version('st-1', 1, 'shared')]);
    assert.equal((out!.steps[1] as InlineStep).name, 'shared');
  });

  test('an unresolvable ref returns null', () => {
    assert.equal(inlineWorkflow(def, [], []), null);
  });
});
