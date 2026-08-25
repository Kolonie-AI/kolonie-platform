import type { AtlasEntry } from '../atlas/types';
import { earnFacetOf, primaryKindOf } from '../atlas/kinds';
import { tagsOf } from '../atlas/tags';

/**
 * Score a candidate neighbour against a source entry.
 * Higher is better.
 *
 * Scoring rules (frozen):
 * 1. Same earn facet (or same primary kind if no earn facet) = primary signal
 * 2. Shared tags = secondary signal
 * 3. Recency / walked = tie-breaker
 * 4. Exclude if only shared signal is fallback shelf (categoryIsFallback / data-apis)
 */
export function neighbourScore(source: AtlasEntry, candidate: AtlasEntry): number {
  if (candidate.slug === source.slug) return -Infinity;

  const sourceEarn = earnFacetOf(source);
  const candEarn = earnFacetOf(candidate);
  const sourceKind = primaryKindOf(source);
  const candKind = primaryKindOf(candidate);

  // Primary signal: same earn facet, or same primary kind if no earn facet
  let score = 0;
  if (sourceEarn && sourceEarn === candEarn) {
    score += 100;
  } else if (!sourceEarn && !candEarn && sourceKind === candKind) {
    score += 80; // same kind but no earn facet on either
  }

  // Secondary signal: shared tags
  const sourceTags = tagsOf(source);
  const candTags = tagsOf(candidate);
  const sharedTags = sourceTags.filter((t) => candTags.includes(t));
  score += sharedTags.length * 10;

  // Tie-breaker: recency (newer first) and walked count
  if (candidate.updatedAt) {
    const daysSinceUpdate = (Date.now() - new Date(candidate.updatedAt).getTime()) / 86400000;
    score += Math.max(0, 10 - daysSinceUpdate / 30); // decays over ~30 days
  }
  if (typeof candidate.walked === 'number') {
    score += Math.min(candidate.walked / 100, 5); // cap at 5
  }

  // Exclusion: if the ONLY reason they'd be neighbours is fallback shelf
  const onlySharedIsFallback =
    score <= 80 && // no earn/kind match, at most tag matches
    (source.categoryIsFallback || candidate.categoryIsFallback) &&
    (source.shelf === 'data-apis' || candidate.shelf === 'data-apis');

  if (onlySharedIsFallback) return -Infinity;

  return score;
}

/**
 * Return up to 3 neighbours for the given entry, scored by earn/kind/tags.
 * Never pads with fallback-shelf peers.
 */
export function atlasNeighbours(source: AtlasEntry, all: AtlasEntry[]): AtlasEntry[] {
  const scored = all
    .map((c) => ({ entry: c, score: neighbourScore(source, c) }))
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ entry }) => entry);

  return scored;
}

/**
 * Subtitle for the neighbours section, reflecting the actual rule used.
 */
export function neighboursSubtitle(source: AtlasEntry): string {
  const earn = earnFacetOf(source);
  if (earn) return `Similar earn rails: ${earn}`;
  const kind = primaryKindOf(source);
  if (kind) return `Similar kind: ${kind}`;
  return 'Related';
}
