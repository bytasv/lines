import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { markdownImageTarget } from '../../web/src/lib/markdownImage.ts';

/**
 * The markdown image rule, tested from the server's runner because that is the
 * only test runner this repo has. Nothing it returns is ever loaded inline, so
 * these cases are about what a click on the placeholder may open — and about
 * nothing remote ever passing for a local path.
 */
const PAGE = 'https://run.example.com/sessions/s1';

describe('markdownImageTarget', () => {
  test('an http(s) image is a URL to open, shown by its host', () => {
    assert.deepEqual(markdownImageTarget('https://evil.example/pixel.png?q=secret', PAGE), {
      kind: 'url',
      href: 'https://evil.example/pixel.png?q=secret',
      host: 'evil.example',
    });
    assert.deepEqual(markdownImageTarget('HTTP://Evil.Example:8080/x.png', PAGE), {
      kind: 'url',
      href: 'http://evil.example:8080/x.png',
      host: 'evil.example:8080',
    });
  });

  test('a protocol-relative image is remote, never a path', () => {
    // No scheme, so a check for `http` calls it relative — and the browser then
    // fetches it from evil.example all the same.
    assert.deepEqual(markdownImageTarget('//evil.example/x.png', PAGE), {
      kind: 'url',
      href: 'https://evil.example/x.png',
      host: 'evil.example',
    });
  });

  test("the page's own origin gets no exemption", () => {
    assert.deepEqual(markdownImageTarget('https://run.example.com/download', PAGE), {
      kind: 'url',
      href: 'https://run.example.com/download',
      host: 'run.example.com',
    });
  });

  test('a relative or rooted path is a file, not a URL on this origin', () => {
    assert.deepEqual(markdownImageTarget('/Users/me/proj/shot.png', PAGE), {
      kind: 'path',
      path: '/Users/me/proj/shot.png',
    });
    assert.deepEqual(markdownImageTarget('./docs/after.png', PAGE), { kind: 'path', path: './docs/after.png' });
    assert.deepEqual(markdownImageTarget('~/Desktop/shot.png', PAGE), { kind: 'path', path: '~/Desktop/shot.png' });
  });

  test('a path is decoded, and its query or fragment dropped', () => {
    assert.deepEqual(markdownImageTarget('shots/my%20shot.png?raw=1#top', PAGE), {
      kind: 'path',
      path: 'shots/my shot.png',
    });
    // A malformed escape keeps the path as written instead of throwing out of a render.
    assert.deepEqual(markdownImageTarget('bad%E0%A4%A.png', PAGE), { kind: 'path', path: 'bad%E0%A4%A.png' });
  });

  test('nothing to open', () => {
    // react-markdown has already emptied data:, blob:, javascript: and the rest.
    assert.deepEqual(markdownImageTarget('', PAGE), { kind: 'none' });
    assert.deepEqual(markdownImageTarget(undefined, PAGE), { kind: 'none' });
    assert.deepEqual(markdownImageTarget('mailto:a@example.com', PAGE), { kind: 'none' });
    assert.deepEqual(markdownImageTarget('#top', PAGE), { kind: 'none' });
  });
});
