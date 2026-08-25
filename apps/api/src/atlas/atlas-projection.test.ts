import { describe, it, expect } from 'vitest';
import { projectAtlasEntry } from './atlas-projection';
import type { AtlasEntry } from '@kolonie/core/account/atlas';

function baseEntry(overrides: Partial<AtlasEntry> = {}): AtlasEntry {
  return {
    id: 'execution.market',
    handle: 'execution.market',
    kind: 'bounty-board',
    earnFacets: ['microtask-board'],
    shelf: 'data-apis',
    categoryIsFallback: true,
    ...overrides,
  };
}

describe('projectAtlasEntry', () => {
  it('projects execution.market without leading data-apis', () => {
    const entry = baseEntry();
    const proj = projectAtlasEntry(entry);

    expect(proj.kind).toBe('bounty-board');
    expect(proj.earnFacets).toEqual(['microtask-board']);
    expect(proj.shelf).toBeNull();
    expect(proj.categoryIsFallback).toBe(true);
    expect(proj.headerChipsHtml).toContain('bounty-board');
    expect(proj.headerChipsHtml).toContain('microtask-board');
    expect(proj.headerChipsHtml).not.toContain('data-apis');
    expect(proj.headerChipsHtml).toContain('Uncategorised utility shelf');
  });

  it('projects clawlancer without leading data-apis', () => {
    const entry = baseEntry({ id: 'clawlancer', handle: 'clawlancer', kind: 'gig-marketplace', earnFacets: ['gig-marketplace'] });
    const proj = projectAtlasEntry(entry);

    expect(proj.kind).toBe('gig-marketplace');
    expect(proj.earnFacets).toEqual(['gig-marketplace']);
    expect(proj.shelf).toBeNull();
    expect(proj.headerChipsHtml).toContain('gig-marketplace');
    expect(proj.headerChipsHtml).not.toContain('data-apis');
  });

  it('includes shelf when not a fallback', () => {
    const entry = baseEntry({ categoryIsFallback: false, shelf: 'developer-tools' });
    const proj = projectAtlasEntry(entry);

    expect(proj.shelf).toBe('developer-tools');
    expect(proj.headerChipsHtml).toContain('developer-tools');
  });
});
