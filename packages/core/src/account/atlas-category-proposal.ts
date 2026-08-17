import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import { AtlasCategorySlugSchema } from './recipe.js'
import type { AtlasCategoryRow } from './atlas-categories.js'

/**
 * What a model may suggest about where a provider belongs (`#1106`).
 *
 * **The vocabulary is the guarantee, not the prompt.** `#1102` made the taxonomy
 * a table so that a shelf the Colony discovers it needs costs a row rather than a
 * release; the price of that is that something has to be able to write a row, and
 * the only writer with any evidence is a model reading walks. So this file is
 * where *what may be proposed* is decided, and it is decided by what can be
 * expressed: there is no shape here that creates a top category, which is why
 * decision 3 holds against a prompt that was ignored, a transport that answered
 * something else, and a caller written next year by somebody who never read the
 * issue.
 *
 * **A proposal is evidence plus a target, and nothing else.** No status is
 * proposed, no primary shelf is named, no join row is described. The two shapes
 * below are the whole of what a maintainer is ever asked to accept.
 */

/** The shelf title, on `atlas_categories`' own bound. */
export const ATLAS_CATEGORY_TITLE_MAX_LENGTH = 80

/** The shelf standfirst, on `atlas_categories`' own bound. */
export const ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH = 300

/**
 * The sentence saying why this provider belongs there.
 *
 * `PROPOSAL_REASON_MAX_LENGTH`'s number and its reason: it is read in a queue
 * beside others, and a paragraph in that column is a paragraph nobody reads.
 */
export const ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH = 500

export const AtlasCategoryProposalStatusSchema = z.enum(['open', 'accepted', 'declined'])
export type AtlasCategoryProposalStatus = z.infer<typeof AtlasCategoryProposalStatusSchema>

/**
 * The two shapes, and there is no third (`#1106`, decision 2).
 *
 * A discriminated union rather than an object with optional fields, so that *a
 * new shelf without a parent* is not a value this type can hold. The rejection
 * case the issue names — a proposal for a new **top** category — is refused here
 * by there being nowhere to put it: `new-sub` requires a parent, and `existing`
 * names a slug that has to already be in the table.
 */
export const AtlasCategoryProposalShapeSchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('existing'),
    /** A slug the taxonomy already holds. Checked against the table by the caller. */
    category: AtlasCategorySlugSchema,
  }),
  z.object({
    shape: z.literal('new-sub'),
    /**
     * The top category it hangs from.
     *
     * **Never null and never optional**, which is the whole of decision 3 in one
     * field: a shape that could omit this would be a shape that creates a top
     * category, and a model that can add one can reshape the taxonomy between two
     * reviews without anybody noticing.
     */
    parent: AtlasCategorySlugSchema,
    category: AtlasCategorySlugSchema,
    title: z.string().trim().min(1).max(ATLAS_CATEGORY_TITLE_MAX_LENGTH),
    standfirst: z.string().trim().min(1).max(ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH),
  }),
])
export type AtlasCategoryProposalShape = z.infer<typeof AtlasCategoryProposalShapeSchema>

/**
 * What the model proposed, before anything has been stored (`#1106`, decision 4).
 *
 * **`walks` is non-empty and that is a schema rule rather than a habit.** A shelf
 * suggested from the provider's name alone is a guess wearing a citation, and the
 * briefing rule it mirrors — a claim naming no corpus source is dropped — is only
 * worth anything if the shape underneath it cannot hold zero.
 */
export const AtlasCategoryProposalDraftSchema = z.intersection(
  AtlasCategoryProposalShapeSchema,
  z.object({
    why: z.string().trim().min(1).max(ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH),
    walks: z.array(z.uuid()).min(1),
  }),
)
export type AtlasCategoryProposalDraft = z.infer<typeof AtlasCategoryProposalDraftSchema>

/** One proposal as the table holds it, decided or not. */
export const AtlasCategoryProposalSchema = z.intersection(
  AtlasCategoryProposalDraftSchema,
  z.object({
    id: z.uuid(),
    kind: AccountKindSchema,
    provider: AccountProviderSchema,
    status: AtlasCategoryProposalStatusSchema,
    proposedAt: TimestampSchema,
    decidedAt: TimestampSchema.nullable(),
    /** What a maintainer said on a decline. Required on one, absent otherwise. */
    decidedReason: z.string().max(ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH).nullable(),
  }),
)
export type AtlasCategoryProposal = z.infer<typeof AtlasCategoryProposalSchema>

/**
 * The prefix marking a section that adds a shelf the taxonomy already has.
 *
 * The section vocabulary is a closed set in the transport's schema, which is what
 * makes decision 3 a property of the call rather than of the prompt: there is no
 * string in {@link atlasCategoryProposalSections} that asks for a top category, so
 * an answer proposing one is refused before it reaches any code that could be
 * lenient about it.
 */
export const ATLAS_CATEGORY_SECTION_ADD = 'add:'

/** The prefix marking a section that opens a new shelf under one top category. */
export const ATLAS_CATEGORY_SECTION_NEW = 'new-under:'

/**
 * The closed set of targets a proposal may name.
 *
 * **A top category is offered to hang a new shelf from and never to file on**
 * (decision 3). An entry sits on a sub-shelf, so `add:` covers the subs only; a
 * top appears here exactly once, as the `new-under:` that would give it another
 * one.
 *
 * **Categories already proposed for this pair are left out** (`#1106`, decision
 * 7). A maintainer who declined *this provider is also knowledge-docs* last month
 * is not asked again this month, and the cheapest place to hold that is the set
 * the model chooses from — a rule applied after the answer would spend the call
 * to throw it away.
 */
export function atlasCategoryProposalSections(input: {
  readonly categories: readonly AtlasCategoryRow[]
  /** Slugs already proposed for this provider, whatever a maintainer decided. */
  readonly settled?: readonly string[]
  /** Slugs the provider already sits on, its primary shelf among them. */
  readonly held?: readonly string[]
}): readonly string[] {
  const off = new Set([...(input.settled ?? []), ...(input.held ?? [])])

  return [
    ...input.categories
      .filter((one) => one.parent !== null && !off.has(one.slug))
      .map((one) => `${ATLAS_CATEGORY_SECTION_ADD}${one.slug}`),
    ...input.categories
      .filter((one) => one.parent === null)
      .map((one) => `${ATLAS_CATEGORY_SECTION_NEW}${one.slug}`),
  ]
}

/** What one section string asked for, or `null` if it asked for nothing this file knows. */
export function atlasCategoryProposalTarget(
  section: string,
): { readonly add: string } | { readonly under: string } | null {
  if (section.startsWith(ATLAS_CATEGORY_SECTION_ADD)) {
    const slug = section.slice(ATLAS_CATEGORY_SECTION_ADD.length)
    return AtlasCategorySlugSchema.safeParse(slug).success ? { add: slug } : null
  }

  if (section.startsWith(ATLAS_CATEGORY_SECTION_NEW)) {
    const slug = section.slice(ATLAS_CATEGORY_SECTION_NEW.length)
    return AtlasCategorySlugSchema.safeParse(slug).success ? { under: slug } : null
  }

  return null
}

/**
 * The slug a proposed shelf title would live at.
 *
 * **Derived and not asked for**, because a slug is an address and a model asked
 * for one answers with prose about half the time. What the model is asked for is
 * the title a reader sees; the address follows from it by a rule anybody can
 * check, and a title that yields no slug is a proposal that is dropped rather
 * than repaired.
 */
export function atlasCategorySlugFromTitle(title: string): string | null {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return AtlasCategorySlugSchema.safeParse(slug).success ? slug : null
}
