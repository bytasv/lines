import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasRenderedPreview, isHtmlPath } from '../../web/src/lib/language.ts';

/**
 * Which files the viewer opens rendered, tested from the server's runner
 * because that is the only test runner this repo has.
 */
describe('isHtmlPath', () => {
  test('.html and .htm in any case', () => {
    assert.equal(isHtmlPath('/tmp/report.html'), true);
    assert.equal(isHtmlPath('/tmp/REPORT.HTM'), true);
  });

  test('only the last extension counts', () => {
    assert.equal(isHtmlPath('/tmp/report.html.bak'), false);
  });

  test('.xhtml stays source', () => {
    assert.equal(isHtmlPath('/tmp/page.xhtml'), false);
  });
});

describe('hasRenderedPreview', () => {
  test('markdown and HTML open rendered', () => {
    assert.equal(hasRenderedPreview('/repo/README.md'), true);
    assert.equal(hasRenderedPreview('/repo/report.html'), true);
  });

  test('mdx and code do not', () => {
    assert.equal(hasRenderedPreview('/repo/page.mdx'), false);
    assert.equal(hasRenderedPreview('/repo/main.ts'), false);
  });
});
