import { mapKindToEarnFacet, hasEarnFacetMapping, EarnFacetKind } from './kind-to-earn-facet';

describe('mapKindToEarnFacet', () => {
  it('maps bounty-board to bounty-board earn facet', () => {
    expect(mapKindToEarnFacet('bounty-board')).toBe('bounty-board');
  });

  it('maps gig-marketplace to gig-marketplace earn facet', () => {
    expect(mapKindToEarnFacet('gig-marketplace')).toBe('gig-marketplace');
  });

  it('maps microtask-board to bounty-board earn facet (closest v1 equivalent)', () => {
    expect(mapKindToEarnFacet('microtask-board')).toBe('bounty-board');
  });

  it('maps survey-panel to creator-payout earn facet', () => {
    expect(mapKindToEarnFacet('survey-panel')).toBe('creator-payout');
  });

  it('maps rewards-platform to creator-payout earn facet', () => {
    expect(mapKindToEarnFacet('rewards-platform')).toBe('creator-payout');
  });

  it('returns undefined for mailbox kind (no auto mapping)', () => {
    expect(mapKindToEarnFacet('mailbox')).toBeUndefined();
  });

  it('returns undefined for social kind (no auto mapping)', () => {
    expect(mapKindToEarnFacet('social')).toBeUndefined();
  });

  it('returns undefined for unknown kind', () => {
    expect(mapKindToEarnFacet('unknown-kind')).toBeUndefined();
  });
});

describe('hasEarnFacetMapping', () => {
  it('returns true for kinds with mapping', () => {
    expect(hasEarnFacetMapping('bounty-board')).toBe(true);
    expect(hasEarnFacetMapping('gig-marketplace')).toBe(true);
    expect(hasEarnFacetMapping('microtask-board')).toBe(true);
    expect(hasEarnFacetMapping('survey-panel')).toBe(true);
    expect(hasEarnFacetMapping('rewards-platform')).toBe(true);
  });

  it('returns false for kinds without mapping', () => {
    expect(hasEarnFacetMapping('mailbox')).toBe(false);
    expect(hasEarnFacetMapping('social')).toBe(false);
    expect(hasEarnFacetMapping('unknown-kind')).toBe(false);
  });
});
