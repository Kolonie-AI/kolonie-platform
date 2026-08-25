import { describe, it, expect } from 'vitest';
import { buildProviderHeaderChips, renderProviderHeaderChips } from './provider-header';
import type { AtlasEntry } from '@kolonie/core/account/atlas';

function baseEntry(overrides: Partial<AtlasEntry> = {}): AtlasEntry {
  return {
    id: 'test-provider',
    handle: 'test',
    kind: 'bounty-board',
    earnFacets: ['microtask-board'],
    shelf: 'data-apis',
    categoryIsFallback: false,
    ...overrides,
  };
}

describe('buildProviderHeaderChips', () => {
  it('shows kind + earn facets first when no fallback', () => {
    const entry = baseEntry();
    const chips = buildProviderHeaderChips(entry);

    expect(chips.kindChip).toBe('bounty-board');
    expect(chips.earnFacetChips).toEqual(['microtask-board']);
    expect(chips.shelfChip).toBe('data-apis');
  });

  it('omits fallback shelf chip when categoryIsFallback is true', () => {
    const entry = baseEntry({ categoryIsFallback: true });
    const chips = buildProviderHeaderChips(entry);

    expect(chips.kindChip).toBe('bounty-board');
    expect(chips.earnFacetChips).toEqual(['microtask-board']);
    expect(chips.shelfChip).toBeNull();
  });

  it('shows earn facet even when kind is missing', () => {
    const entry = baseEntry({ kind: null, earnFacets: ['gig-marketplace'] });
    const chips = buildProviderHeaderChips(entry);

    expect(chips.kindChip).toBeNull();
    expect(chips.earnFacetChips).toEqual(['gig-marketplace']);
    expect(chips.shelfChip).toBe('data-apis');
  });

  it('shows earn facet when fallback and no shelf', () => {
    const entry = baseEntry({ categoryIsFallback: true, shelf: null });
    const chips = buildProviderHeaderChips(entry);

    expect(chips.earnFacetChips).toEqual(['microtask-board']);
    expect(chips.shelfChip).toBeNull();
  });

  it('handles multiple earn facets', () => {
    const entry = baseEntry({ earnFacets: ['bounty-board', 'microtask-board', 'gig-marketplace'] });
    const chips = buildProviderHeaderChips(entry);

    expect(chips.earnFacetChips).toEqual(['bounty-board', 'microtask-board', 'gig-marketplace']);
  });
});

describe('renderProviderHeaderChips', () => {
  it('renders kind + earn facets + shelf when no fallback', () => {
    const entry = baseEntry();
    const html = renderProviderHeaderChips(entry);

    expect(html).toContain('<span class="chip chip--kind">bounty-board</span>');
    expect(html).toContain('<span class="chip chip--earn">microtask-board</span>');
    expect(html).toContain('<span class="chip chip--shelf">data-apis</span>');
  });

  it('omits data-apis shelf chip when categoryIsFallback is true', () => {
    const entry = baseEntry({ categoryIsFallback: true });
    const html = renderProviderHeaderChips(entry);

    expect(html).toContain('<span class="chip chip--kind">bounty-board</span>');
    expect(html).toContain('<span class="chip chip--earn">microtask-board</span>');
    expect(html).not.toContain('data-apis');
    expect(html).toContain('<span class="chip chip--shelf chip--muted">Uncategorised utility shelf</span>');
  });

  it('escapes HTML in chip labels', () => {
    const entry = baseEntry({ kind: 'bounty<board>', earnFacets: ['micro&task'] });
    const html = renderProviderHeaderChips(entry);

    expect(html).toContain('bounty&lt;board&gt;');
    expect(html).toContain('micro&amp;task');
    expect(html).not.toContain('<board>');
    expect(html).not.toContain('&task');
  });

  it('renders only earn facets when kind is missing', () => {
    const entry = baseEntry({ kind: null });
    const html = renderProviderHeaderChips(entry);

    expect(html).not.toContain('chip--kind');
    expect(html).toContain('<span class="chip chip--earn">microtask-board</span>');
  });
});
