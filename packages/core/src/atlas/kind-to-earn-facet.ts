export type EarnFacetKind =
  | 'bounty-board'
  | 'gig-marketplace'
  | 'creator-payout';

export type WalkKindWithEarnMapping =
  | 'bounty-board'
  | 'gig-marketplace'
  | 'microtask-board'
  | 'survey-panel'
  | 'rewards-platform';

/**
 * Maps a walk kind to its corresponding earn facet kind.
 * Returns undefined for kinds that don't have an automatic earn facet mapping.
 *
 * Mapping rules (v1):
 * - bounty-board → bounty-board
 * - gig-marketplace → gig-marketplace
 * - microtask-board → bounty-board (closest v1 equivalent)
 * - survey-panel / rewards-platform → creator-payout (v1 mapping)
 * - mailbox / social kinds → no automatic mapping (require explicit override)
 */
export function mapKindToEarnFacet(kind: string): EarnFacetKind | undefined {
  switch (kind) {
    case 'bounty-board':
      return 'bounty-board';
    case 'gig-marketplace':
      return 'gig-marketplace';
    case 'microtask-board':
      return 'bounty-board';
    case 'survey-panel':
    case 'rewards-platform':
      return 'creator-payout';
    default:
      return undefined;
  }
}

/**
 * Checks if a kind has an automatic earn facet mapping.
 */
export function hasEarnFacetMapping(kind: string): boolean {
  return mapKindToEarnFacet(kind) !== undefined;
}
