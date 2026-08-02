import { fileBase } from './files';
import { withAuthToken } from '../ws';

/**
 * The feature manifest at `docs/codebase/index.json` — one client shared by the
 * composer's `@feature` mentions and the documentation reader's card home, so
 * the file is fetched and cached once per project rather than once per consumer.
 */

export interface FeatureEntry {
  id: string;
  name: string;
  doc?: string;
  purpose?: string;
  entryPoints?: string[];
}

export interface FeatureIndex {
  version?: number;
  features?: FeatureEntry[];
}

const FEATURE_TTL_MS = 30_000;
/** Per-cwd cache; a null value marks "no manifest here" so we don't refetch per keystroke. */
const featureCache = new Map<string, { at: number; features: FeatureEntry[] | null }>();

export async function loadFeatures(cwd: string): Promise<FeatureEntry[] | null> {
  const cached = featureCache.get(cwd);
  if (cached && Date.now() - cached.at < FEATURE_TTL_MS) return cached.features;
  let features: FeatureEntry[] | null = null;
  try {
    const path = `${cwd}/docs/codebase/index.json`;
    const res = await fetch(withAuthToken(`${fileBase}/file?path=${encodeURIComponent(path)}`));
    if (res.ok) {
      const data = (await res.json()) as { content?: string };
      const parsed = JSON.parse(data.content ?? '') as FeatureIndex;
      features = Array.isArray(parsed.features) ? parsed.features : [];
    }
  } catch {
    features = null; // parse error / too large / offline — kind silently absent
  }
  featureCache.set(cwd, { at: Date.now(), features });
  return features;
}

/** Drop the cached manifest so the next load refetches — the reader's Refresh button. */
export function invalidateFeatures(cwd?: string): void {
  if (cwd) featureCache.delete(cwd);
  else featureCache.clear();
}
