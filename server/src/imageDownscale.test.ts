import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ATTACHMENT_MAX_EDGE,
  ATTACHMENT_SKIP_BYTES,
  isDownscalableType,
  shouldDownscale,
  targetSize,
  withExtension,
} from '../../web/src/lib/imageDownscalePolicy.ts';
import {
  clearSent,
  failSending,
  finishSending,
  progressSending,
  removeSending,
  startSending,
  type SendingPrompts,
} from '../../web/src/lib/sendingPrompts.ts';

/**
 * The attachment downscale decision and the sending-row lifecycle, tested from
 * the server's runner because that is the only test runner this repo has. The
 * canvas half of the downscale needs a browser and is left to a manual check.
 */
const MB = 1024 * 1024;

describe('shouldDownscale', () => {
  test('a large phone photo is resized', () => {
    assert.equal(shouldDownscale({ type: 'image/jpeg', size: 12 * MB, width: 4032, height: 3024 }), true);
  });

  test('a small screenshot within the edge limit stays byte-identical', () => {
    assert.equal(shouldDownscale({ type: 'image/png', size: 400 * 1024, width: 1170, height: 2532 - 600 }), false);
    assert.equal(shouldDownscale({ type: 'image/png', size: ATTACHMENT_SKIP_BYTES, width: 2048, height: 1000 }), false);
  });

  test('a small file with an oversized edge is resized', () => {
    assert.equal(shouldDownscale({ type: 'image/png', size: 300 * 1024, width: 4000, height: 200 }), true);
  });

  test('a heavy file within the edge limit is re-encoded', () => {
    assert.equal(shouldDownscale({ type: 'image/png', size: 3 * MB, width: 1800, height: 1200 }), true);
  });

  test('GIF, SVG and non-images are never touched', () => {
    for (const type of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/plain', '']) {
      assert.equal(shouldDownscale({ type, size: 20 * MB, width: 5000, height: 5000 }), false, type);
    }
  });

  test('HEIC/HEIF and WebP count as photos, case-insensitively', () => {
    assert.equal(isDownscalableType('image/heic'), true);
    assert.equal(isDownscalableType('image/HEIF'), true);
    assert.equal(isDownscalableType('image/webp'), true);
  });
});

describe('targetSize', () => {
  test('scales the long edge to the limit and keeps the aspect', () => {
    assert.deepEqual(targetSize(4032, 3024, ATTACHMENT_MAX_EDGE), { width: 2048, height: 1536 });
    assert.deepEqual(targetSize(3024, 4032, ATTACHMENT_MAX_EDGE), { width: 1536, height: 2048 });
  });

  test('never upscales', () => {
    assert.deepEqual(targetSize(800, 600, ATTACHMENT_MAX_EDGE), { width: 800, height: 600 });
  });

  test('never yields a zero dimension', () => {
    assert.deepEqual(targetSize(10000, 1, ATTACHMENT_MAX_EDGE), { width: 2048, height: 1 });
    assert.deepEqual(targetSize(0, 0, ATTACHMENT_MAX_EDGE), { width: 1, height: 1 });
  });
});

describe('withExtension', () => {
  test('swaps or adds the extension', () => {
    assert.equal(withExtension('IMG_0001.HEIC', 'jpg'), 'IMG_0001.jpg');
    assert.equal(withExtension('photo', 'jpg'), 'photo.jpg');
    assert.equal(withExtension('my.trip.png', 'jpg'), 'my.trip.jpg');
  });
});

describe('sending prompt rows', () => {
  const row = { id: 'p1', text: 'look', attachmentCount: 1, bytes: 5 * MB };

  test('start, progress, done, then cleared by the bridge answering', () => {
    let map: SendingPrompts = {};
    map = startSending(map, 's1', row);
    assert.equal(map.s1[0].phase, 'encrypting');
    assert.equal(map.s1[0].progress, 0);
    map = progressSending(map, 's1', 'p1', 0.63, 'sending');
    assert.equal(map.s1[0].phase, 'sending');
    assert.equal(map.s1[0].progress, 0.63);
    map = finishSending(map, 's1', 'p1');
    assert.equal(map.s1[0].phase, 'sent');
    assert.equal(map.s1[0].progress, 1);
    map = clearSent(map, 's1');
    assert.equal(map.s1, undefined);
  });

  test('an event clears only rows already sent', () => {
    let map: SendingPrompts = {};
    map = startSending(map, 's1', row);
    map = startSending(map, 's1', { ...row, id: 'p2' });
    map = finishSending(map, 's1', 'p1');
    map = clearSent(map, 's1');
    assert.deepEqual(map.s1.map((r) => r.id), ['p2']);
  });

  test('a close mid-send fails the row, and a late poll cannot revive it', () => {
    let map: SendingPrompts = startSending({}, 's1', row);
    map = failSending(map, 's1', 'p1');
    assert.equal(map.s1[0].phase, 'failed');
    map = progressSending(map, 's1', 'p1', 0.9, 'sending');
    map = finishSending(map, 's1', 'p1');
    assert.equal(map.s1[0].phase, 'failed');
    map = clearSent(map, 's1');
    assert.equal(map.s1.length, 1);
    map = removeSending(map, 's1', 'p1');
    assert.equal(map.s1, undefined);
  });

  test('progress is clamped and unknown rows are a no-op', () => {
    let map: SendingPrompts = startSending({}, 's1', row);
    map = progressSending(map, 's1', 'p1', 1.7, 'sending');
    assert.equal(map.s1[0].progress, 1);
    assert.equal(progressSending(map, 's1', 'nope', 0.5, 'sending'), map);
    assert.equal(clearSent(map, 's2'), map);
  });
});
