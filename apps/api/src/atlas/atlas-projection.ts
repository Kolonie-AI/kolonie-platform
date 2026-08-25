import { AtlasEntry } from '@kolonie/core/account/atlas';
import { buildProviderHeaderChips, renderProviderHeaderChips } from '../account/provider-header';

/**
 * Public projection for an Atlas entry used in HTML responses.
 * Ensures the frozen taxonomy ordering: kind + earn facets first,
 * fallback shelf never leads.
 */
export interface AtlasPublicProjection {
  id: string;
  handle: string;
  kind: string | null;
  earnFacets: string[];
  shelf: string | null;
  categoryIsFallback: boolean;
  headerChipsHtml: string;
}

export function projectAtlasEntry(entry: AtlasEntry): AtlasPublicProjection {
  return {
    id: entry.id,
    handle: entry.handle,
    kind: entry.kind ?? null,
    earnFacets: entry.earnFacets ?? [],
    shelf: entry.categoryIsFallback === true ? null : (entry.shelf ?? null),
    categoryIsFallback: entry.categoryIsFallback ?? false,
    headerChipsHtml: renderProviderHeaderChips(entry),
  };
}
