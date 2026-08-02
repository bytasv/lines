import type { TreeNodeData } from '@mantine/core';
import { DOCS_INDEX_REL, docDirname, docSummary, docTitle, normalizeDocPath } from '@lines/shared';
import type { DocFile } from '@lines/shared';
import type { FeatureEntry } from './features';

/**
 * Derivations the documentation reader renders from an already-loaded bundle:
 * the doc tree, the feature cards, and the docs no index entry claims. Pure —
 * nothing here fetches.
 */

/** Build a Mantine tree from doc paths; directories first, then files, both alphabetical. */
export function toDocTreeNodes(paths: readonly string[]): TreeNodeData[] {
  const root: TreeNodeData[] = [];
  for (const rel of [...paths].sort()) {
    const segments = rel.split('/');
    let level = root;
    let prefix = '';
    segments.forEach((seg, i) => {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      const isLeaf = i === segments.length - 1;
      let node = level.find((n) => n.value === prefix);
      if (!node) {
        node = { value: prefix, label: seg, ...(isLeaf ? {} : { children: [] }) };
        level.push(node);
      }
      if (!isLeaf) level = node.children as TreeNodeData[];
    });
  }
  const sortLevel = (nodes: TreeNodeData[]) => {
    nodes.sort((a, b) => {
      const aDir = Array.isArray(a.children);
      const bDir = Array.isArray(b.children);
      return aDir === bDir ? a.value.localeCompare(b.value) : aDir ? -1 : 1;
    });
    for (const n of nodes) if (Array.isArray(n.children)) sortLevel(n.children);
  };
  sortLevel(root);
  return root;
}

/** Every directory on the way to `rel` — what the tree has to expand to reveal it. */
export function ancestorDirs(rel: string): string[] {
  const segments = rel.split('/').slice(0, -1);
  const out: string[] = [];
  let prefix = '';
  for (const seg of segments) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    out.push(prefix);
  }
  return out;
}

/** One feature as the home page shows it; `rel` is null when the index points at a missing doc. */
export interface FeatureCard {
  id: string;
  name: string;
  purpose?: string;
  entryPoints: string[];
  /** Bundle-relative path of the linked doc, or null when it isn't in the corpus. */
  rel: string | null;
}

/**
 * Resolve each index entry's `doc` (written relative to `docs/codebase/`, the
 * manifest's own directory) to a bundle-relative path. An entry whose doc is
 * missing still becomes a card — its name and purpose are useful on their own,
 * and the skew is worth showing rather than hiding.
 */
export function featureCards(
  features: readonly FeatureEntry[],
  hasDoc: (rel: string) => boolean,
): FeatureCard[] {
  const base = docDirname(DOCS_INDEX_REL);
  return features.map((f) => {
    const rel = f.doc ? normalizeDocPath(base ? `${base}/${f.doc}` : f.doc) : '';
    return {
      id: f.id,
      name: f.name,
      purpose: f.purpose,
      entryPoints: f.entryPoints ?? [],
      rel: rel && hasDoc(rel) ? rel : null,
    };
  });
}

/** Docs in the bundle that no feature card points at, with a title and summary for listing. */
export function unindexedDocs(
  docs: readonly DocFile[],
  cards: readonly FeatureCard[],
): { path: string; title: string; summary: string }[] {
  const claimed = new Set(cards.map((c) => c.rel).filter((r): r is string => r !== null));
  return docs
    .filter((d) => !claimed.has(d.path))
    .map((d) => ({
      path: d.path,
      title: docTitle(d.content, d.path),
      summary: docSummary(d.content),
    }));
}
