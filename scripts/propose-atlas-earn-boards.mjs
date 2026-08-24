#!/usr/bin/env node

/**
 * Open one reviewed-taxonomy proposal for the earn entries stranded on the Atlas
 * fallback shelf (`#1670`).
 *
 * Usage:
 *   npm run build
 *   DATABASE_URL=... node scripts/propose-atlas-earn-boards.mjs [--url <catalogue>] [--model <label>]
 *
 * The published catalogue decides membership through `earnFacetsOf`; Postgres is
 * read only for published walk ids and written only through
 * `openAtlasCategoryProposal`. Nothing here accepts a proposal or reshelves an
 * entry. Re-running returns the proposal already open for the deterministic
 * evidence pair.
 */

import console from 'node:console'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AtlasCategoryProposalDraftSchema,
  AtlasCategorySlugSchema,
  AtlasDocumentSchema,
  AtlasFacetSchema,
  AtlasSourceSchema,
  earnFacetsOf,
} from '@kolonie-ai/core'
import {
  createDatabase,
  databaseUrlFromEnv,
  openAtlasCategoryProposal,
  providerBriefingCorpus,
} from '@kolonie-ai/db'

const DEFAULT_CATALOGUE_URL = 'https://kolonie.ai/atlas/catalogue.json'
const FALLBACK_CATEGORY = 'data-apis'
const PROPOSAL_MODEL = 'atlas-earn-boards-catalogue-v1'

export const EARN_BOARDS_CATEGORY = 'earn-boards'

/** Entries whose primary shelf is the fallback and whose structured facets say they earn. */
function earnBoardMembers(catalogue) {
  return catalogue.entries.filter(
    (entry) => entry.category === FALLBACK_CATEGORY && earnFacetsOf(entry.facets).length > 0,
  )
}

/** One deterministic proposal pair per earning recipe represented by the public entries. */
export function earnBoardCandidates(catalogue) {
  const candidates = earnBoardMembers(catalogue).flatMap((entry) =>
    entry.recipes
      .filter((recipe) => earnFacetsOf(recipe.facets).length > 0)
      .map((recipe) => ({ kind: recipe.kind, provider: entry.provider, source: entry.source })),
  )
  const unique = new Map(
    candidates.map((candidate) => [`${candidate.provider}\u0000${candidate.kind}`, candidate]),
  )
  return [...unique.values()].sort(
    (one, other) =>
      one.provider.localeCompare(other.provider) || one.kind.localeCompare(other.kind),
  )
}

/** The first catalogue pair that has walk ids the proposal schema permits it to cite. */
export async function selectEarnBoardEvidence(candidates, walksFor) {
  for (const candidate of candidates) {
    const walks = [...new Set(await walksFor(candidate))].sort()
    if (walks.length > 0) return { candidate, walks }
  }
  return null
}

/** The fixed `new-sub` decision, with only its evidence and measured population supplied. */
export function earnBoardProposalDraft({ walks, memberCount }) {
  return AtlasCategoryProposalDraftSchema.parse({
    shape: 'new-sub',
    parent: 'building-running',
    category: EARN_BOARDS_CATEGORY,
    title: 'Earn boards',
    standfirst: 'Boards and marketplaces where a citizen can earn by completing offered work.',
    why:
      `${memberCount} entries on the ${FALLBACK_CATEGORY} fallback carry a structured earn facet; ` +
      'this shelf groups those earn boards without deriving membership from prose.',
    walks,
  })
}

/** Join public membership to published walk evidence without writing either source. */
export async function prepareEarnBoardProposal(catalogue, walksFor) {
  const selected = await selectEarnBoardEvidence(earnBoardCandidates(catalogue), walksFor)
  if (selected === null) return null
  return {
    kind: selected.candidate.kind,
    provider: selected.candidate.provider,
    draft: earnBoardProposalDraft({
      walks: selected.walks,
      memberCount: earnBoardMembers(catalogue).length,
    }),
  }
}

function argument(argv, name, fallback) {
  const at = argv.indexOf(name)
  if (at === -1) return fallback
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function entryIdentity(entry) {
  if (entry === null || typeof entry !== 'object') throw new Error('Atlas entry is not an object')
  return {
    provider: AccountProviderSchema.parse(entry.provider),
    category: AtlasCategorySlugSchema.parse(entry.category),
    facets: AtlasFacetSchema.array().parse(entry.facets),
    source: AtlasSourceSchema.parse(entry.source),
    recipes: Array.isArray(entry.recipes)
      ? entry.recipes.map((recipe) => {
          if (recipe === null || typeof recipe !== 'object') {
            throw new Error('Atlas recipe is not an object')
          }
          return {
            kind: AccountKindSchema.parse(recipe.kind),
            facets: AtlasFacetSchema.array().parse(recipe.facets),
          }
        })
      : (() => {
          throw new Error('Atlas entry carries no recipe list')
        })(),
  }
}

async function readCatalogue(url) {
  const response = await globalThis.fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const document = await response.json()
  const parsed = AtlasDocumentSchema.safeParse(document)
  if (parsed.success) return parsed.data
  if (
    document === null ||
    typeof document !== 'object' ||
    !('entries' in document) ||
    !Array.isArray(document.entries)
  ) {
    throw new Error(`${url} carries no Atlas entry list`)
  }
  const entries = document.entries.map(entryIdentity)
  console.warn(
    `${url} has ${parsed.error.issues.length} document-level schema issue(s) outside the entry identity read by this proposal`,
  )
  return { entries }
}

/** Read and open the proposal once; acceptance remains exclusively on the existing decision path. */
export async function run(argv = process.argv.slice(2)) {
  const url = argument(argv, '--url', DEFAULT_CATALOGUE_URL)
  const model = argument(argv, '--model', PROPOSAL_MODEL)
  const catalogue = await readCatalogue(url)
  const members = earnBoardMembers(catalogue)
  const candidates = earnBoardCandidates(catalogue)
  if (members.length === 0 || candidates.length === 0) {
    throw new Error(`${url} carries no structured earn entries on ${FALLBACK_CATEGORY}`)
  }

  const db = createDatabase(databaseUrlFromEnv())
  try {
    const prepared = await prepareEarnBoardProposal(catalogue, async (candidate) => {
      const corpus = await providerBriefingCorpus(db, {
        kind: AccountKindSchema.parse(candidate.kind),
        provider: candidate.provider,
      })
      return corpus.map((walk) => walk.id)
    })
    if (prepared === null) {
      throw new Error('no earn-board candidate has published walk evidence')
    }

    const result = await openAtlasCategoryProposal(db, { ...prepared, model })
    if (result.proposal.category !== EARN_BOARDS_CATEGORY) {
      throw new Error(`${prepared.kind} at ${prepared.provider} already has another open proposal`)
    }
    if (result.outcome === 'already-proposed' && result.proposal.status !== 'open') {
      throw new Error(
        `${EARN_BOARDS_CATEGORY} was already ${result.proposal.status}; no proposal was opened`,
      )
    }

    console.log(
      `${result.outcome}: ${prepared.kind} at ${prepared.provider} proposes ${EARN_BOARDS_CATEGORY}`,
    )
    return result
  } finally {
    await db.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
}
