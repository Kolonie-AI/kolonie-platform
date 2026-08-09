import { z } from 'zod'
import { PERMISSION_AGGREGATE_FLOOR } from '../operator/permission-report.js'
import { AccountKindSchema, AccountProviderSchema, ProviderReportOutcomeSchema } from './account.js'
import type { RecipeStatus } from './recipe.js'

/**
 * What the Colony can say about a provider that nobody else can (`#545`).
 *
 * Anyone can curate a list of providers. **Only the Colony knows how many agents
 * actually got through**, because only the Colony watches the attempts — and
 * that measurement is what separates the Atlas from a link collection.
 *
 * It is also the honest replacement for the thing that must never be sold.
 * `#543` rule 2 refuses to sell ordering; this is what the ordering is derived
 * from instead, and a derived order is one nobody can buy because there is
 * nothing to set.
 *
 * ## The four rules, and where each one lives
 *
 * | Rule | Enforced by |
 * |---|---|
 * | Aggregates only, never identities | the SQL: it counts distinct agents and selects no id |
 * | A provider sees its own numbers in full | {@link AtlasAudience}, and nothing else may pass `provider` |
 * | A poor number is published like any other | there is no suppression path to call |
 * | Ordering is derived, never stored | {@link atlasRank}; no rank column exists anywhere |
 *
 * The third has no code because *the absence is the enforcement*. Adding a field
 * that hides a figure is the change to refuse, and `#548` extends the same
 * refusal to the schema: a stored rank is a thing that can be edited.
 */

/**
 * How long an account has to survive to count as held (`#545`).
 *
 * **The figure that makes the rest trustworthy.** A signup reversed a week later
 * is not a success, and a catalogue counting it as one is lying to the next
 * agent — which is the failure mode a catalogue of *signups* has and a catalogue
 * of *accounts* does not.
 */
export const ATLAS_RETENTION_DAYS = 30

/**
 * The floor a published figure has to clear.
 *
 * **`PERMISSION_AGGREGATE_FLOOR` and not a second number**, on `#545`'s explicit
 * instruction to reuse it rather than re-derive it. Its reasoning transfers
 * exactly: *"no aggregate may be reducible to a single citizen"*, and a provider
 * one citizen attempted is a fact about that citizen however the row is phrased.
 */
export const ATLAS_FIGURE_FLOOR = PERMISSION_AGGREGATE_FLOOR

/**
 * Who is reading a figure.
 *
 * **`provider` is not a convenience and must never be reachable by a page.** It
 * is what `#548`'s claim buys — a provider proving it is the provider, and
 * thereafter seeing its own detail in full because that is what it is paying
 * for. A public reader gets `public` and the floor applies.
 */
export const AtlasAudienceSchema = z.enum(['public', 'provider'])
export type AtlasAudience = z.infer<typeof AtlasAudienceSchema>

/** Where an attempt stopped, and how many citizens stopped there. */
export const AtlasStopSchema = z.object({
  outcome: ProviderReportOutcomeSchema,
  citizens: z.int().min(0),
})
export type AtlasStop = z.infer<typeof AtlasStopSchema>

/**
 * What the Colony measured about one recipe.
 *
 * **Computed and never stored**, which is `#545`'s requirement and also the only
 * arrangement in which a poor number cannot be edited away: there is no row to
 * edit.
 */
export const AtlasFiguresSchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,

  /**
   * Citizens who tried: the ones holding an account here, plus the ones who
   * filed a report saying they did not get one.
   *
   * **A union of two tables and not a third one counting attempts.** An
   * `attempts` table would be a record only a code path writes, and the code
   * path that matters is the one an agent walks *outside* the Colony. What the
   * Colony genuinely knows is who ended up holding something and who said they
   * did not, and the sum of those is who tried.
   */
  attempted: z.int().min(0),

  /** Of those, how many hold an account here the Colony has proved. */
  proved: z.int().min(0),

  /**
   * Median hours from declaring the account to proving it, or null.
   *
   * **Median rather than mean**, because one citizen who came back three weeks
   * later would otherwise decide the number a provider is judged on. Null when
   * nothing has been proved, which is not the same as zero.
   */
  medianHoursToProof: z.number().min(0).nullable(),

  /**
   * Where they stopped, in the order the attempt goes through.
   *
   * **The report outcomes *are* the steps, and this is the honest granularity.**
   * `no-service` is before the first step, `signup-refused` is at the form,
   * `never-provisioned` is after it, and `abandoned` is somewhere in between and
   * says so. A finer breakdown would need a step index on a report nobody has
   * been asked for, and inventing one would be a number the Colony publishes
   * without having measured it.
   */
  stopped: z.array(AtlasStopSchema),

  /** Of those, the ones the provider refused outright. */
  refused: z.int().min(0),

  /**
   * What citizens said about where it stopped them, moderated.
   *
   * The scrubbed text only, exactly as `ProviderReportTallySchema` serves it:
   * a sentence that identified its author would be a listed citizen.
   */
  reasons: z.array(z.string()),

  /**
   * Of the accounts proved more than {@link ATLAS_RETENTION_DAYS} ago, how many
   * the citizen still holds — and how many there were.
   *
   * **Both numbers, because the ratio alone is unreadable.** *100 %* over two
   * accounts and over two hundred are different claims, and a figure meant to
   * make the others trustworthy cannot be the one that hides its own base.
   * `held` is null while nothing is old enough to ask about.
   */
  stillHeld: z.int().min(0).nullable(),
  heldLongEnoughToAsk: z.int().min(0),

  /**
   * Whether the floor suppressed the counts in this row.
   *
   * **Said out loud rather than served as zeroes.** A suppressed row and a row
   * nobody attempted look identical otherwise, and the difference matters to a
   * reader deciding whether the silence is about the provider or about us.
   */
  suppressed: z.boolean(),
})
export type AtlasFigures = z.infer<typeof AtlasFiguresSchema>

/** The figures of a provider nobody has tried yet, which is an answer and not a gap. */
export function noFigures(kind: string, provider: string): AtlasFigures {
  return {
    kind: AccountKindSchema.parse(kind),
    provider: AccountProviderSchema.parse(provider),
    attempted: 0,
    proved: 0,
    medianHoursToProof: null,
    stopped: [],
    refused: 0,
    reasons: [],
    stillHeld: null,
    heldLongEnoughToAsk: 0,
    suppressed: false,
  }
}

/**
 * How many of the citizens who tried got through, or null.
 *
 * Null below the floor and null with nothing measured — two states a reader
 * treats the same way, which is *we cannot tell you*. A zero here would read as
 * *nobody gets through*, which is a claim about the provider the Colony has not
 * earned.
 */
export function throughRate(figures: AtlasFigures): number | null {
  if (figures.suppressed || figures.attempted === 0) return null

  return figures.proved / figures.attempted
}

/**
 * The number the Atlas is ordered by (`#545`).
 *
 * **Derived here and stored nowhere**, which is the whole of rule 2: there is no
 * position field for a paying provider to be moved up, because the order is
 * recomputed from the measurements on every read. `#548` requires that no such
 * field ever exists, and this function is why one is never needed.
 *
 * **A provider a visitor can actually get through comes first**, which is what
 * `#547` calls the product. Within that, a bigger sample wins a tie — a 100 %
 * rate over five attempts is a weaker claim than 80 % over two hundred, and
 * sorting by rate alone would put the first above the second forever.
 * Unmeasured entries sort below measured ones and above refusals: nothing is
 * known about them, which is worse than a working recipe and better than a road
 * known to be closed.
 *
 * **The bottom of the order is two rows and not one** (`#588`). An entry nobody
 * has written up sorts below every joinable one and *above* a refusal: the
 * Colony has walked the refusal and knows the road is closed, and it has not
 * walked the unwritten one at all. Ranking them together would put a provider
 * that may well work underneath one that is known not to.
 *
 * **It is four rows since `#604`, and the two new ones sit at the ends.** A
 * `draft` outranks `unwritten` because something was walked and the entry is
 * waiting on a person rather than on anybody at all — it still sorts below every
 * measured entry, because a rate the Colony has not published is not a rate. A
 * `retired` entry sorts last of everything: it is not on offer, and a provider
 * the Colony withdrew should not appear above one it merely has not walked.
 *
 * `proposed` is not in the ladder and cannot be: nothing that ranks entries ever
 * sees one, because no public surface reads them (`recipeStatusIsPublic`). It
 * shares `retired`'s floor if one ever arrives, which is the safe direction.
 */
export function atlasRank(input: {
  readonly status: RecipeStatus
  readonly figures: readonly AtlasFigures[]
}): number {
  if (input.status === 'retired' || input.status === 'proposed') return -3
  if (input.status === 'refused') return -2
  if (input.status === 'unwritten') return -1
  if (input.status === 'draft') return -0.5

  const attempted = input.figures.reduce((sum, one) => sum + one.attempted, 0)
  const proved = input.figures.reduce((sum, one) => sum + one.proved, 0)
  const suppressed = input.figures.every((one) => one.suppressed)

  if (attempted === 0 || suppressed) return 0

  // Two decimal places of rate, then the sample as the tie-break beneath it.
  return Math.round((proved / attempted) * 100) * 1000 + Math.min(attempted, 999)
}
