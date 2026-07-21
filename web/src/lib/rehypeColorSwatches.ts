// Detects CSS color literals in rendered markdown and inserts an empty
// <span class="color-chip" data-color="…"> marker after each one, which
// Markdown.tsx renders as an inline swatch. The literal text stays visible.
// Walks into inline <code> (plain text) but never into <pre> or <a>.
import { findColorLiterals } from './colorLiterals';

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

function swatchify(value: string): HastNode[] | null {
  const matches = findColorLiterals(value);
  if (matches.length === 0) return null;
  const out: HastNode[] = [];
  let last = 0;
  for (const m of matches) {
    out.push({ type: 'text', value: value.slice(last, m.end) });
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['color-chip'], dataColor: m.value },
      children: [],
    });
    last = m.end;
  }
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
      // Skip fenced code blocks and links (incl. file-link anchors).
      if (tag === 'pre' || tag === 'a') continue;
      walk(child);
    } else if (child.type === 'text') {
      const replaced = swatchify((child as HastText).value);
      if (replaced) {
        children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
    }
  }
}

export function rehypeColorSwatches() {
  return (tree: HastNode) => walk(tree);
}
