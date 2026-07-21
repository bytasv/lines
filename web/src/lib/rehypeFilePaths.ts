// Detects file-path-like spans in rendered markdown and wraps them in
// <a class="file-link" data-filepath="…"> so Markdown.tsx can open a preview.
// Requires ≥1 slash and a letter-initial extension; optional :line(:col) suffix.
const PATH_RE =
  /(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]\w{0,9}(?::\d+(?::\d+)?)?/g;

interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** A match is a false positive if it sits inside a URL (scheme:// or preceded by a word char). */
function isUrlContext(text: string, index: number): boolean {
  if (text.slice(index - 3, index) === '://') return true;
  const before = text[index - 1];
  return before !== undefined && /[\w./]/.test(before);
}

function linkify(value: string): HastNode[] | null {
  PATH_RE.lastIndex = 0;
  const out: HastNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = PATH_RE.exec(value)) !== null) {
    if (isUrlContext(value, m.index)) continue;
    matched = true;
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { className: ['file-link'], dataFilepath: m[0], href: '#' },
      children: [{ type: 'text', value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (!matched) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: HastNode): void {
  if (!('children' in node) || !node.children) return;
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'element') {
      const tag = (child as HastElement).tagName;
      // Never linkify inside fenced code blocks or existing anchors.
      if (tag === 'pre' || tag === 'a') continue;
      walk(child);
    } else if (child.type === 'text') {
      const replaced = linkify((child as HastText).value);
      if (replaced) {
        children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
    }
  }
}

export function rehypeFilePaths() {
  return (tree: HastNode) => walk(tree);
}
