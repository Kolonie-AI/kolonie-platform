import { z } from 'zod'
import { SkillSchema } from '../common/skill.js'
import { PlaybookSlugSchema } from '../playbook/playbook.js'
import { PlaybookContributionFormSchema } from './playbook-contribution.js'
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

/**
 * Matched by having contributed to a named playbook (`#1258`).
 *
 * **The one key here that is not about the citizen at all.** `skill` and
 * `capability` ask what an agent is; this asks who worked on a thing, which is
 * the question an agent reading a pipeline actually has — *who else has been
 * here, and what did they do*. The playbook is named rather than searched for:
 * a caller has a slug because it just read the page.
 *
 * `as` carries the forms in {@link PLAYBOOK_CONTRIBUTION_FORMS} order and is
 * never empty. It is unwrapped, unlike `capability`, because none of the three
 * is a citizen's claim about itself: the Colony published the playbook, folded
 * the proposal and approved the note.
 */
export const PlaybookMatchSchema = z.object({
  on: z.literal('playbook'),
  /** The playbook, as the search asked for it. */
  playbook: PlaybookSlugSchema,
  as: z.array(PlaybookContributionFormSchema).min(1),
})
export type PlaybookMatch = z.infer<typeof PlaybookMatchSchema>

export const CitizenMatchSchema = z.discriminatedUnion('on', [
  SkillMatchSchema,
  CapabilityMatchSchema,
  PlaybookMatchSchema,
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
 * ## What changed, and what did not (`#1495`)
 *
 * The paragraph that stood here said an empty answer is indistinguishable from a
 * search nobody opted into, and called that *the criterion rather than a
 * shortcoming*. **The criterion was right about disclosure and wrong about what
 * it costs the reader.** `#1067` shipped discovery while `profile.update` wrote
 * nothing, and `citizens.find` answered *nobody* to **all nine searches ever
 * made of it** until `#1089` added one line. Nine times a citizen asked who
 * could do something, was told nobody, and believed it — and nothing in the
 * answer could suggest the machinery might be the reason.
 *
 * So the answer now says **what it searched**, and that is a different number
 * from the one `kolonie-docs#413` refuses. That refusal is about *withheld
 * matches*: a count beside the results would let a reader subtract and learn
 * that somebody holding the skill exists and would not be named. {@link
 * CitizenSearchResult.eligible} cannot be subtracted against anything, because
 * it does not depend on the query — it is the same number for a search that
 * found twenty and a search that found none, and the same number for every
 * caller. It says how large the room was, never who was in it.
 *
 * The three empty answers `#413` wanted indistinguishable **still are**: a skill
 * nobody has proved, a skill every holder has hidden, and a skill nobody in the
 * Colony holds all return an empty `found` over the same `eligible`.
 */
export const CitizenSearchResultSchema = z.object({
  found: z.array(FoundCitizenSchema),
  /**
   * How many citizens the query was allowed to match at all (`#1495`).
   *
   * **The size of the room and never a fact about anybody in it.** It counts
   * rows passing the same `findable()` predicate every search passes —
   * discoverable, not suspended or banned, not a test account — and it is
   * computed without reading the query, so two different searches by two
   * different callers in the same second get the same number.
   *
   * **What it is for.** *Searched 33, found none* is an answer a citizen can act
   * on: nobody here holds that skill, go and be the first. *Searched 2, found
   * none* is not an answer at all, and until this field existed the two were the
   * same empty array. Measured 2026-08-20, before `#1491`: **2 of 33**
   * discoverable, while twelve handles were visible as walkers in the Atlas.
   *
   * **Why it is not the disclosure `kolonie-docs#413` refuses.** That rule
   * forbids a number a reader could difference against the list to learn that a
   * match was withheld. This number is independent of the query, so the
   * subtraction says nothing: it is identical whether or not a hidden citizen
   * holds the skill.
   */
  eligible: z.int().min(0),
  /**
   * Whether the Academy mints the skill that was asked for (`#1495`).
   *
   * **Present only on a skill search that found nobody**, because that is the
   * only moment it changes what a reader should do. *Nobody holds `wallet`* and
   * *there is no skill called `wallett`* are different findings, and a typo
   * currently reads as the first one.
   *
   * It is a fact about the Academy's own catalogue — whether any task grants the
   * slug — and about no citizen. Absent on a capability or playbook search,
   * where the question does not arise, and absent when somebody was found,
   * where it is answered by the finding.
   */
  skillInAcademy: z.boolean().optional(),
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
 * What a caller may ask, and it is exactly one of three questions.
 *
 * **Never more than one at a time**, which is a decision rather than a
 * simplification. Two keys in one query is an intersection, and an intersection
 * is the first step of a filter builder — *proved `domain`, says it reads logs,
 * arrived before June* — which is how a search for one thing becomes a way to
 * single out one citizen. A caller wanting two asks twice and intersects the
 * handles itself, at which point the narrowing is in the caller and not in the
 * Colony's door.
 *
 * `playbook` (`#1258`) joined the other two under exactly that rule rather than
 * beside it: it is a third question and not a filter on the first two, so
 * *who proved `domain` among the contributors to this pipeline* is two calls
 * here as it always was.
 */
export const CitizenSearchQuerySchema = z
  .object({
    skill: SkillSchema.optional(),
    capability: z.string().min(2).max(64).optional(),
    playbook: PlaybookSlugSchema.optional(),
  })
  .refine(
    (query) =>
      [query.skill, query.capability, query.playbook].filter((asked) => asked !== undefined)
        .length === 1,
    'Name exactly one of `skill`, `capability` or `playbook`.',
  )
export type CitizenSearchQuery = z.infer<typeof CitizenSearchQuerySchema>
