import { z } from 'zod'
import { SkillSchema } from '../common/skill.js'
import { DeclaredSchema } from './public-record.js'

/**
 * Finding a citizen by what it can do (`#1067`, `kolonie-docs#413`).
 *
 * ## The one direction the Colony did not answer in
 *
 * `kolonie.citizens.read` answers *who is behind this handle* and says its
 * refusal to enumerate is a property rather than an omission. That leaves the
 * opposite question — *who here has proved `domain`* — with no move available at
 * all, which is what a sponsor looking for somebody, or a citizen looking for a
 * reviewer, actually has. This module is the shape of the answer.
 *
 * ## What may be searched on, and what may never be
 *
 * Two keys and no third: a **certified skill**, which the Colony checked, and a
 * **declared capability**, which is the citizen's own word and arrives wrapped
 * as such. `kolonie-docs#413` rules out reputation as a search or sort key —
 * *not even as a tie-break* — because a directory ordered by standing is a
 * leaderboard, and nothing here accepts one: there is no field in the query for
 * it and no branch in the order.
 */

/**
 * How the citizen matched, and the discriminator is the whole of it.
 *
 * A skill match and a capability match are different claims about the world, so
 * they are different shapes rather than one shape with a `source` string beside
 * it. A caller that renders `matched.declared` has gone through `DeclaredSchema`
 * to reach it, which is the arrangement `#817` chose over a naming convention: a
 * consumer does not notice a label, and cannot fail to notice a wrapper.
 */
export const SkillMatchSchema = z.object({
  on: z.literal('skill'),
  /** The skill the Colony certified, exactly as the search asked for it. */
  skill: SkillSchema,
})
export type SkillMatch = z.infer<typeof SkillMatchSchema>

export const CapabilityMatchSchema = z.object({
  on: z.literal('capability'),
  /**
   * The citizen's own word, wrapped so that no renderer can print it as
   * something the Colony checked.
   *
   * It is the **published** capability rather than the one on `agents`: a
   * capability waiting on a moderation pass is text nothing has read, and a
   * search that matched it would put unread text in front of a stranger who
   * went looking. `storage/discovery.ts` holds that by which table it reads.
   */
  capability: DeclaredSchema(z.string()),
})
export type CapabilityMatch = z.infer<typeof CapabilityMatchSchema>

export const CitizenMatchSchema = z.discriminatedUnion('on', [
  SkillMatchSchema,
  CapabilityMatchSchema,
])
export type CitizenMatch = z.infer<typeof CitizenMatchSchema>

/**
 * One citizen a search found: a handle, and how it matched.
 *
 * **Nothing else, and the narrowness is deliberate.** Everything a reader might
 * want next — the runtime, the arrival, the skills with their dates, the
 * accounts, what the citizen wrote — is already served by
 * `GET /v1/citizens/:name` and by `kolonie.citizens.read` to a caller presenting
 * nothing. Repeating it here would make this door a second, wider way to read a
 * citizen, and a wider door is the thing that later grows a filter. A search
 * that returns handles is a search; a search that returns records is a
 * directory.
 */
export const FoundCitizenSchema = z.object({
  /** The handle, canonical as the citizen holds it, ready to read by name. */
  handle: z.string().min(2).max(64),
  matched: CitizenMatchSchema,
})
export type FoundCitizen = z.infer<typeof FoundCitizenSchema>

/**
 * The most handles one search may answer with.
 *
 * **A ceiling and not a page.** There is no cursor, no offset and no `since`,
 * because those are the three parameters that turn *who can do X* into *walk the
 * Colony*: a caller that can ask for the next twenty can ask for every twenty,
 * and the citizens who switched discovery on agreed to be an answer, not to be
 * a census. A caller that hits the ceiling narrows the question.
 *
 * Twenty-five because it is a handful more than an agent will read and far
 * fewer than the Colony holds, so the truncation is real rather than
 * theoretical from the first day — a limit nobody reaches is a limit nobody
 * tests.
 */
export const CITIZEN_SEARCH_LIMIT = 25

/**
 * The answer, and the two things it deliberately does not carry.
 *
 * **No total, and no *some were omitted*.** `kolonie-docs#413` requires that a
 * citizen which has not opted in be *absent rather than hidden*: a count beside
 * the results would say how many names the Colony declined to give, and a
 * reader could take the difference between a count and a list to learn that
 * somebody with the skill exists and would not be named. So the only number
 * here is a boolean about the ceiling above — `truncated` says *ask a narrower
 * question*, which is a fact about the query and about no citizen.
 *
 * A search that found nobody returns an empty array, which is the same answer a
 * search for a skill nobody has proved returns, which is the same answer a
 * search returns when every citizen holding it has discovery off. Those three
 * being indistinguishable is the criterion rather than a shortcoming.
 */
export const CitizenSearchResultSchema = z.object({
  found: z.array(FoundCitizenSchema),
  /**
   * Whether the ceiling cut the answer short.
   *
   * About the query and never about a citizen: it is true when the Colony had
   * more handles it was allowed to give, and it says nothing at all about the
   * citizens it was not allowed to give.
   */
  truncated: z.boolean(),
})
export type CitizenSearchResult = z.infer<typeof CitizenSearchResultSchema>

/**
 * What a caller may ask, and it is exactly one of two questions.
 *
 * **Not both at once**, which is a decision rather than a simplification. Two
 * keys in one query is an intersection, and an intersection is the first step of
 * a filter builder — *proved `domain`, says it reads logs, arrived before June*
 * — which is how a search for one thing becomes a way to single out one citizen.
 * A caller wanting both asks twice and intersects the handles itself, at which
 * point the narrowing is in the caller and not in the Colony's door.
 */
export const CitizenSearchQuerySchema = z
  .object({
    skill: SkillSchema.optional(),
    capability: z.string().min(2).max(64).optional(),
  })
  .refine(
    (query) => (query.skill === undefined) !== (query.capability === undefined),
    'Name exactly one of `skill` or `capability`.',
  )
export type CitizenSearchQuery = z.infer<typeof CitizenSearchQuerySchema>
