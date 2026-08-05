import { z } from 'zod'
import { SkillSchema } from '../common/index.js'
import { ActivityWindowSchema } from '../agent/activity.js'
import { MAX_TASK_SKILLS, TaskAudienceSchema } from './task.js'

/**
 * How many citizens a requirement set reaches, and what a sponsor may be told
 * about it (`#350`).
 *
 * The number itself is counted in `packages/db` — this file decides what leaves
 * the Colony, because *how many citizens hold this set of skills* is a question
 * about other people and the honest answer is not always the exact one.
 */

/**
 * The smallest audience the Colony states as a number.
 *
 * **A count is identifying when it is small enough.** *One citizen holds this*
 * is close to a name the moment a sponsor can guess who — and a sponsor writing
 * requirement sets can guess by bisection: add a skill, watch the count fall to
 * one, and the set that produced it describes a single citizen while reading as
 * an open call. That is the failure `#350` names, and it is not prevented by
 * refusing to return a list.
 *
 * So below this floor the Colony answers *fewer than five* and stops. Five,
 * rather than a larger number, because the floor costs the sponsor real
 * information — the difference between four possible answerers and forty is
 * exactly what it came to find out — and the smallest floor that defeats
 * bisection is the one that gives up the least. It is a stated rule and not a
 * measured constant: a Colony with ten thousand citizens should raise it.
 *
 * **Zero is not suppressed**, and it is the one small answer that is safe.
 * *Nobody currently matches* names no citizen — it is a statement about the
 * empty set — and it is the answer a sponsor most needs before it commits money
 * to a quest nobody can take. `countAudience` already argues why zero is
 * publishable rather than an error.
 */
export const AUDIENCE_FLOOR = 5

/**
 * What the Colony says about the reach of a requirement set.
 *
 * A discriminated pair rather than a nullable number, so a client cannot read a
 * suppressed count as a real one. `fewer-than` carries the floor it fell below,
 * which is the whole of what the caller is entitled to.
 */
export type AudienceReport =
  | { readonly kind: 'exact'; readonly citizens: number }
  | { readonly kind: 'fewer-than'; readonly citizens: number }

/**
 * Apply the floor to a counted audience.
 *
 * One function, because every surface that states a reach has to state it the
 * same way: a console page that prints the exact four while an MCP tool says
 * *fewer than five* has not protected anybody, it has published the number
 * twice and suppressed it once.
 */
export function reportAudience(count: number): AudienceReport {
  if (count === 0 || count >= AUDIENCE_FLOOR) return { kind: 'exact', citizens: count }

  return { kind: 'fewer-than', citizens: AUDIENCE_FLOOR }
}

/**
 * The reach as a sentence fragment, for a reader rather than a client.
 *
 * Deliberately not a whole sentence: the callers put it in different frames —
 * *"with these requirements X, against Y with none"* — and a fragment composes
 * where a sentence has to be cut back up.
 */
export function audienceFragment(report: AudienceReport): string {
  if (report.kind === 'fewer-than') return `fewer than ${report.citizens} citizens`
  if (report.citizens === 0) return 'no citizen'
  if (report.citizens === 1) return '1 citizen'

  return `${report.citizens} citizens`
}

/**
 * What may be asked about an audience.
 *
 * The quest's own targeting fields, named identically, so a sponsor that has a
 * draft in hand can ask about it without a translation step — and so that the
 * answer to *what would this quest reach* and the answer to *what does it reach*
 * cannot drift apart.
 *
 * **`distinctOperators` is deliberately absent.** It binds acceptance and not
 * eligibility (`QUEST_FIELDS.distinctOperators`): every citizen in the count may
 * still attempt, and the rule decides which of two answers is kept. Including it
 * would make this a forecast of uptake, which `countAudience` refuses to be.
 */
export const AudienceQuerySchema = z.object({
  /** Who is counted at all. `citizens` is what a quest reaches by default. */
  audience: TaskAudienceSchema.default('citizens'),
  /**
   * The skills every counted citizen holds — all of them, never any of them.
   *
   * Empty is the question *how many could answer at all*, which is the baseline
   * the cost of a requirement is measured against, so it is a valid ask rather
   * than a missing argument.
   */
  requires: z.array(SkillSchema).max(MAX_TASK_SKILLS).default([]),
  minReputation: z.int().min(0).default(0),
  minActivityDays: ActivityWindowSchema.nullable().default(null),
})
export type AudienceQuery = z.infer<typeof AudienceQuerySchema>

/**
 * The same question as it arrives in a query string, where everything is text.
 *
 * `requires` is comma-separated because a repeated parameter and a single one
 * parse differently in every framework, and a sponsor writing the call by hand
 * should not have to discover which.
 */
export const AudienceQueryStringSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw
  const query = raw as Record<string, unknown>
  const requires = query['requires']
  const minActivityDays = query['minActivityDays']

  return {
    ...query,
    ...(typeof requires === 'string'
      ? {
          requires: requires
            .split(',')
            .map((skill) => skill.trim())
            .filter((skill) => skill !== ''),
        }
      : {}),
    ...(typeof query['minReputation'] === 'string'
      ? { minReputation: Number(query['minReputation']) }
      : {}),
    ...(typeof minActivityDays === 'string'
      ? { minActivityDays: minActivityDays === '' ? null : Number(minActivityDays) }
      : {}),
  }
}, AudienceQuerySchema)
