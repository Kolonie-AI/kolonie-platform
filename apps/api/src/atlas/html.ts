import type { AtlasCatalogueEntry, AtlasRecipeRow, AtlasWalkRow } from './catalogue.js'
import { atlasRenames } from './renames.js'
import { renderBriefing } from './briefing.js'
import { renderOperateNotes } from './operate-notes.js'
import { renderIdentityBlock } from './identity.js'
import { renderEarnFacets } from './earn-facets.js'
import { renderUtilityShelves } from './utility-shelves.js'
import { renderStatusBadge } from './status-badge.js'
import { renderKindChip } from './kind-chip.js'
import { renderVerdictChips } from './verdict-chips.js'
import { renderCostChips } from './cost-chips.js'
import { renderWallsIcons } from './walls-icons.js'
import { escapeHtml, formatDate, joinNonEmpty } from './utils.js'

const ATLAS_BASE = '/atlas'
const CATALOGUE_JSON = '/catalogue.json'

/**
 * Build the public HTML page for a single provider in the Atlas.
 * This is the canonical presentation — no Astro, no client JS.
 */
export async function buildProviderPage(
  provider: string,
  entry: AtlasCatalogueEntry,
  opts: { renames?: Awaited<ReturnType<typeof atlasRenames>> } = {},
): Promise<string> {
  const canonical = await opts.renames?.canonical(provider) ?? provider
  const rows = entry.rows
  
  // Determine primary status from rows
  const status = computePrimaryStatus(rows)
  const hasMeasured = rows.some(r => r.kind === 'measured')
  const hasRecipe = rows.some(r => r.kind === 'recipe')
  const hasSighted = rows.some(r => r.kind === 'sighted')
  const hasAbandoned = rows.some(r => r.kind === 'abandoned')
  
  // Collect identity signals
  const about = pickAbout(rows)
  const homepage = pickHomepage(rows)
  const kind = pickKind(rows)
  const earnFacets = pickEarnFacets(rows)
  const utilityShelves = pickUtilityShelves(rows)
  const verdicts = pickVerdicts(rows)
  const cost = pickCost(rows)
  const walls = pickWalls(rows)
  
  // Title per frozen decision: "{provider}: measured — no Colony route yet"
  const title = hasMeasured && !hasRecipe
    ? `${canonical}: measured — no Colony route yet`
    : hasRecipe
      ? `${canonical}: Colony route`
      : hasSighted
        ? `${canonical}: sighted — identity filed`
        : hasAbandoned
          ? `${canonical}: abandoned — signup stopped mid-way`
          : `${canonical}: Atlas`

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://kolonie.ai">
  <link rel="stylesheet" href="/atlas/styles.css">
  <link rel="alternate" type="application/json" title="Catalogue entry" href="${CATALOGUE_JSON}#${escapeHtml(canonical)}">
  <meta name="description" content="${escapeHtml(about ?? `Atlas entry for ${canonical}`)}">
  ${homepage ? `<link rel="canonical" href="${escapeHtml(homepage)}">` : ''}
</head>
<body>
  <header class="k-atlas-header">
    <a href="/" class="k-home-link" aria-label="Kolonie home">
      <svg class="k-mark" viewBox="0 0 32 32" aria-hidden="true"><use href="/mark.svg#mark"></use></svg>
    </a>
    <nav class="k-atlas-nav" aria-label="Atlas navigation">
      <a href="/atlas" class="k-atlas-nav-link">Atlas</a>
      <a href="/catalogue.json" class="k-atlas-nav-link">Catalogue JSON</a>
    </nav>
  </header>

  <main class="k-atlas-main">
    <article class="k-provider-page">
      ${renderIdentityBlock({ canonical, about, homepage, status, kind, earnFacets, utilityShelves, verdicts, cost, walls })}
      
      ${hasMeasured && !hasRecipe ? renderMeasuredNotice(canonical) : ''}
      
      ${renderBriefingSection(rows)}
      
      ${renderOperateNotesSection(rows)}
      
      ${renderDetailsSection(rows, { canonical, status, kind, earnFacets, utilityShelves, verdicts, cost, walls })}
    </article>
  </main>

  <footer class="k-atlas-footer">
    <p><a href="/atlas">← Back to Atlas</a> · <a href="/catalogue.json">Catalogue JSON</a> · <a href="https://github.com/Kolonie-AI/kolonie-platform">Source</a></p>
  </footer>
</body>
</html>`

  return html
}

function computePrimaryStatus(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string {
  if (rows.some(r => r.kind === 'recipe')) return 'recipe'
  if (rows.some(r => r.kind === 'measured')) return 'measured'
  if (rows.some(r => r.kind === 'sighted')) return 'sighted'
  if (rows.some(r => r.kind === 'abandoned')) return 'abandoned'
  return 'unknown'
}

function pickAbout(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string | null {
  for (const row of rows) {
    if (row.about && typeof row.about === 'string' && row.about.trim()) {
      return row.about.trim()
    }
  }
  return null
}

function pickHomepage(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string | null {
  for (const row of rows) {
    if (row.homepage && typeof row.homepage === 'string' && row.homepage.trim()) {
      return row.homepage.trim()
    }
  }
  return null
}

function pickKind(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string | null {
  for (const row of rows) {
    if (row.kind && row.kind !== 'measured' && row.kind !== 'sighted' && row.kind !== 'abandoned') {
      return row.kind
    }
  }
  return null
}

function pickEarnFacets(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string[] {
  const facets = new Set<string>()
  for (const row of rows) {
    if (row.earnFacets && Array.isArray(row.earnFacets)) {
      for (const f of row.earnFacets) {
        if (isValidEarnFacet(f)) facets.add(f)
      }
    }
  }
  return Array.from(facets)
}

function pickUtilityShelves(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string[] {
  const shelves = new Set<string>()
  for (const row of rows) {
    if (row.utilityShelves && Array.isArray(row.utilityShelves)) {
      for (const s of row.utilityShelves) {
        if (s !== 'data-apis' || !hasNonFallbackShelf(rows)) {
          shelves.add(s)
        }
      }
    }
  }
  return Array.from(shelves)
}

function hasNonFallbackShelf(rows: (AtlasRecipeRow | AtlasWalkRow)[]): boolean {
  for (const row of rows) {
    if (row.utilityShelves && Array.isArray(row.utilityShelves)) {
      for (const s of row.utilityShelves) {
        if (s !== 'data-apis') return true
      }
    }
  }
  return false
}

function pickVerdicts(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string[] {
  const verdicts = new Set<string>()
  for (const row of rows) {
    if (row.verdict && typeof row.verdict === 'string') {
      verdicts.add(row.verdict)
    }
  }
  return Array.from(verdicts)
}

function pickCost(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string | null {
  for (const row of rows) {
    if (row.cost && typeof row.cost === 'string') {
      return row.cost
    }
  }
  return null
}

function pickWalls(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string[] {
  const walls = new Set<string>()
  for (const row of rows) {
    if (row.walls && Array.isArray(row.walls)) {
      for (const w of row.walls) {
        walls.add(w)
      }
    }
  }
  return Array.from(walls)
}

function isValidEarnFacet(facet: string): boolean {
  const valid = [
    'affiliate-referral',
    'bounty-board',
    'gig-marketplace',
    'creator-payout',
    'grant-quest'
  ]
  return valid.includes(facet)
}

function renderMeasuredNotice(canonical: string): string {
  return `<div class="k-measured-notice">
    <p>This provider has been <strong>measured</strong> — a walk reached the provider and recorded what it found. No Colony route (recipe) has been written yet.</p>
    <p>If you operate this provider and want to author a route, see <a href="/docs/operate/write-a-recipe">Writing a recipe</a>.</p>
  </div>`
}

function renderBriefingSection(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string {
  const briefingRows = rows.filter(r => r.kind === 'recipe' && r.briefing)
  if (briefingRows.length === 0) return ''
  
  let html = '<section class="k-briefing" aria-labelledby="briefing-heading">
    <h2 id="briefing-heading">What citizens measured</h2>'
  
  for (const row of briefingRows) {
    html += renderBriefing(row.briefing!)
  }
  
  html += '</section>'
  return html
}

function renderOperateNotesSection(rows: (AtlasRecipeRow | AtlasWalkRow)[]): string {
  const notesRows = rows.filter(r => r.kind === 'recipe' && r.operateNotes)
  if (notesRows.length === 0) return ''
  
  let html = '<section class="k-operate-notes" aria-labelledby="operate-notes-heading">
    <h2 id="operate-notes-heading">Operate notes</h2>'
  
  for (const row of notesRows) {
    html += renderOperateNotes(row.operateNotes!)
  }
  
  html += '</section>'
  return html
}

function renderDetailsSection(
  rows: (AtlasRecipeRow | AtlasWalkRow)[],
  context: {
    canonical: string
    status: string
    kind: string | null
    earnFacets: string[]
    utilityShelves: string[]
    verdicts: string[]
    cost: string | null
    walls: string[]
  }
): string {
  const { canonical, status, kind, earnFacets, utilityShelves, verdicts, cost, walls } = context
  
  let html = '<section class="k-details" aria-labelledby="details-heading">
    <h2 id="details-heading">Details</h2>
    <dl class="k-details-list">'
  
  // Status
  html += `<dt>Status</dt><dd>${renderStatusBadge(status)}</dd>`
  
  // Kind (if not a status kind)
  if (kind && !['measured', 'sighted', 'abandoned', 'recipe'].includes(kind)) {
    html += `<dt>Kind</dt><dd>${renderKindChip(kind)}</dd>`
  }
  
  // Earn facets
  if (earnFacets.length > 0) {
    html += `<dt>Earn facets</dt><dd>${renderEarnFacets(earnFacets)}</dd>`
  }
  
  // Utility shelves (only non-fallback)
  if (utilityShelves.length > 0) {
    html += `<dt>Utility shelves</dt><dd>${renderUtilityShelves(utilityShelves)}</dd>`
  }
  
  // Verdicts
  if (verdicts.length > 0) {
    html += `<dt>Verdicts</dt><dd>${renderVerdictChips(verdicts)}</dd>`
  }
  
  // Cost
  if (cost) {
    html += `<dt>Cost</dt><dd>${renderCostChips(cost)}</dd>`
  }
  
  // Walls
  if (walls.length > 0) {
    html += `<dt>Walls</dt><dd>${renderWallsIcons(walls)}</dd>`
  }
  
  // Walk metadata
  const walkRows = rows.filter(r => r.kind !== 'recipe')
  if (walkRows.length > 0) {
    html += `<dt>Walks</dt><dd>`
    html += '<ul class="k-walks-list">'
    for (const walk of walkRows) {
      const date = walk.walkedAt ? formatDate(walk.walkedAt) : 'unknown date'
      const walker = walk.walker ? escapeHtml(walk.walker) : 'anonymous'
      html += `<li>Walked ${date} by ${walker}</li>`
    }
    html += '</ul></dd>'
  }
  
  html += '</dl></section>'
  return html
}

export function buildAtlasIndex(entries: Map<string, AtlasCatalogueEntry>): string {
  const providers = Array.from(entries.keys()).sort()
  
  let html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas — Kolonie</title>
  <link rel="preconnect" href="https://kolonie.ai">
  <link rel="stylesheet" href="/atlas/styles.css">
</head>
<body>
  <header class="k-atlas-header">
    <a href="/" class="k-home-link" aria-label="Kolonie home">
      <svg class="k-mark" viewBox="0 0 32 32" aria-hidden="true"><use href="/mark.svg#mark"></use></svg>
    </a>
    <nav class="k-atlas-nav" aria-label="Atlas navigation">
      <a href="/atlas" class="k-atlas-nav-link" aria-current="page">Atlas</a>
      <a href="/catalogue.json" class="k-atlas-nav-link">Catalogue JSON</a>
    </nav>
  </header>

  <main class="k-atlas-main">
    <h1>Atlas</h1>
    <p class="k-atlas-index-lead">Providers that citizens have walked, measured, or operate routes for.</p>
    <ul class="k-atlas-index">
`
  
  for (const provider of providers) {
    const entry = entries.get(provider)!
    const rows = entry.rows
    const status = computePrimaryStatus(rows)
    const hasMeasured = rows.some(r => r.kind === 'measured')
    const hasRecipe = rows.some(r => r.kind === 'recipe')
    const hasSighted = rows.some(r => r.kind === 'sighted')
    const hasAbandoned = rows.some(r => r.kind === 'abandoned')
    const homepage = pickHomepage(rows)
    const earnFacets = pickEarnFacets(rows)
    
    let label = ''
    if (hasRecipe) label = 'Colony route'
    else if (hasMeasured) label = 'measured — no Colony route yet'
    else if (hasSighted) label = 'sighted — identity filed'
    else if (hasAbandoned) label = 'abandoned — signup stopped mid-way'
    else label = 'Atlas entry'
    
    html += `      <li class="k-atlas-index-item">
        <a href="/atlas/${escapeHtml(provider)}" class="k-atlas-index-link">
          <span class="k-atlas-index-name">${escapeHtml(provider)}</span>
          <span class="k-atlas-index-status ${escapeHtml(status)}">${escapeHtml(label)}</span>
          ${homepage ? `<span class="k-atlas-index-homepage" aria-label="Has homepage">🔗</span>` : ''}
          ${earnFacets.length > 0 ? `<span class="k-atlas-index-earn" aria-label="Earn facets: ${earnFacets.join(', ')}">⚡</span>` : ''}
        </a>
      </li>
`
  }
  
  html += `    </ul>
  </main>

  <footer class="k-atlas-footer">
    <p><a href="/catalogue.json">Catalogue JSON</a> · <a href="https://github.com/Kolonie-AI/kolonie-platform">Source</a></p>
  </footer
</body>
</html>`

  return html
}
