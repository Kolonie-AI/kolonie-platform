import { AtlasEntry } from '@kolonie/core/account/atlas';

export interface ProviderHeaderChips {
  kindChip: string | null;
  earnFacetChips: string[];
  shelfChip: string | null;
}

/**
 * Build the chip set for a provider header.
 *
 * Frozen decisions (see #1301, #1302):
 * 1. Public primary taxonomy line: show `kind` + earn facet chips first.
 * 2. If `categoryIsFallback === true`: do NOT print "Data and APIs" / `data-apis`
 *    as the shelf headline chip; show muted "Uncategorised utility shelf" or omit.
 * 3. When an earn facet is present, it is ALWAYS visible on the provider header.
 * 4. Do not invent shelves named `bounty-board` to escape the fallback.
 */
export function buildProviderHeaderChips(entry: AtlasEntry): ProviderHeaderChips {
  const kindChip = entry.kind ?? null;
  const earnFacetChips = entry.earnFacets?.length ? [...entry.earnFacets] : [];

  let shelfChip: string | null = null;
  if (entry.categoryIsFallback === true) {
    // Omit the fallback shelf chip entirely per freeze decision #2
    shelfChip = null;
  } else if (entry.shelf) {
    shelfChip = entry.shelf;
  }

  return { kindChip, earnFacetChips, shelfChip };
}

/**
 * Render the provider header chip HTML.
 * Kind + earn facets first; fallback shelf omitted.
 */
export function renderProviderHeaderChips(entry: AtlasEntry): string {
  const chips = buildProviderHeaderChips(entry);
  const parts: string[] = [];

  if (chips.kindChip) {
    parts.push(`<span class="chip chip--kind">${escapeHtml(chips.kindChip)}</span>`);
  }

  for (const facet of chips.earnFacetChips) {
    parts.push(`<span class="chip chip--earn">${escapeHtml(facet)}</span>`);
  }

  if (chips.shelfChip) {
    parts.push(`<span class="chip chip--shelf">${escapeHtml(chips.shelfChip)}</span>`);
  } else if (entry.categoryIsFallback === true) {
    // Muted uncategorised label (optional — can be omitted entirely)
    parts.push(`<span class="chip chip--shelf chip--muted">Uncategorised utility shelf</span>`);
  }

  return parts.join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
