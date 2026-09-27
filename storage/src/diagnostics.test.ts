import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeDiagReport } from './diagnostics.ts';

describe('sanitizeDiagReport', () => {
  test('rejects a body that is not a report', () => {
    assert.equal(sanitizeDiagReport(null), null);
    assert.equal(sanitizeDiagReport({}), null);
    assert.equal(sanitizeDiagReport({ entries: 'nope' }), null);
  });

  test('keeps well-formed entries and drops malformed ones', () => {
    const report = sanitizeDiagReport({
      source: 'pwa',
      deviceId: 'dev-1',
      userAgent: 'UA',
      entries: [{ t: 1, k: 'dial', d: { attempt: 2, ok: true, why: null } }, { k: 'no-time' }, 'junk', { t: 2, k: 'close' }],
    });
    assert.deepEqual(report, {
      source: 'pwa',
      deviceId: 'dev-1',
      userAgent: 'UA',
      entries: [
        { t: 1, k: 'dial', d: { attempt: 2, ok: true, why: null } },
        { t: 2, k: 'close' },
      ],
    });
  });

  test('an unknown source is not echoed into the log', () => {
    assert.equal(sanitizeDiagReport({ source: 'evil\nline', entries: [] })?.source, 'unknown');
  });

  test('drops nested objects and redacts a token that slipped into a string', () => {
    const report = sanitizeDiagReport({
      entries: [{ t: 1, k: 'dial', d: { url: 'wss://x/client?device=a&token=eyJabc.def', nested: { a: 1 } } }],
    });
    assert.deepEqual(report?.entries[0].d, { url: 'wss://x/client?device=a&token=[redacted]' });
  });

  test('bounds entry count and string length', () => {
    const entries = Array.from({ length: 1500 }, (_, i) => ({ t: i, k: 'x'.repeat(1000) }));
    const report = sanitizeDiagReport({ entries });
    assert.equal(report?.entries.length, 1000);
    assert.equal(report?.entries[0].t, 500, 'keeps the newest');
    assert.ok((report?.entries[0].k.length ?? 0) <= 301);
  });
});
