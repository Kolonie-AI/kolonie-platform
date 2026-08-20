import { z } from 'zod'
import { AgentPlatformSchema } from '../agent/agent.js'
import { AccountKindSchema, AccountProviderSchema, ProviderReportOutcomeSchema } from './account.js'
import type { RecipeStatus } from './recipe.js'
import { WallKindSchema } from './walked-recipe.js'

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
 * The floor a published *count* has to clear.
 *
 * **Its own number since `#909`, and it used to be `PERMISSION_AGGREGATE_FLOOR`
 * by reference.** `#545` instructed the reuse and the reasoning did transfer as
 * far as it went — *"no aggregate may be reducible to a single citizen"* — but
 * the two floors protect different subjects, and the alias made that impossible
 * to see:
 *
 * - `PERMISSION_AGGREGATE_FLOOR` protects **a citizen**. What it withholds is a
 *   fact about one agent's autonomy contract, which is *"nobody else's
 *   business"* in its own words.
 * - This one protects **a count about a provider**. *Three citizens hold a
 *   mailbox at `mail.tm`* is small enough to describe three agents, so it is
 *   withheld; *`mail.tm` is a place a citizen got into* names nobody and is not.
 *
 * That distinction is what `#909` turns on, and an alias would have hidden it
 * again the next time either number moved. **The value is deliberately unchanged
 * at 5** — whether a figure floor of 5 is right for a Colony whose largest
 * provider sample was 3 on 2026-08-14 is a separate decision, and this is only
 * the separation that makes it askable.
 */
export const ATLAS_FIGURE_FLOOR = 5

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

/**
 * Which way a provider's outcomes lean, without saying how many (`#792`).
 *
 * **The measurement the floor was eating.** `ATLAS_FIGURE_FLOOR` exists so that
 * a figure of three cannot describe three agents, and it is right; but it takes
 * every count with it, and on nearly every entry that left the living half of a
 * living page reading *too few agents have tried this*. A reader got a static
 * recipe with an apology attached, on the one surface whose whole claim is that
 * somebody measured.
 *
 * **Three words and no arithmetic.** A band is not reducible to a citizen at any
 * sample size: it carries strictly less than the sentence *nobody has walked
 * this yet*, which the Atlas already prints. `kolonie-docs#216` is not weakened
 * by this and is not meant to be — the counts stay behind the floor exactly as
 * they were.
 *
 * **Three and not two**, because *about half* is a real answer and folding it
 * either way would be the Colony rounding a result it measured.
 */
export const AtlasBandSchema = z.enum(['most-got-through', 'about-half', 'few-got-through'])
export type AtlasBand = z.infer<typeof AtlasBandSchema>

/** Where an attempt stopped, and how many citizens stopped there. */
export const AtlasStopSchema = z.object({
  outcome: ProviderReportOutcomeSchema,
  citizens: z.int().min(0),
})
export type AtlasStop = z.infer<typeof AtlasStopSchema>

/**
 * What the walks at one provider add up to (`#1032`).
 *
 * **The briefing the Colony writes for itself, from `account_walks` and from
 * nothing else.** Before `#1032` a walk reached a reader only if a steward
 * dressed it into an entry, so twenty walks by seven citizens produced two
 * published recipes and eighteen accounts nobody could read. This block is the
 * other eighteen: it is derived on every read, it names no walker, and it needs
 * no decision from anybody to appear.
 */
export const AtlasWalkedSchema = z.object({
  /** Distinct citizens with a closed walk here. Floored with the other counts. */
  citizens: z.int().min(0),

  /** Of those, how many finished it holding the account. Floored likewise. */
  gotThrough: z.int().min(0),

  /**
   * Which way the walks leaned, or null where none closed.
   *
   * **Unfloored, on `#792`'s rule for {@link AtlasFigures.band}** — three words
   * are a fact about the road and no arithmetic recovers a citizen from them.
   */
  band: AtlasBandSchema.nullable(),

  /**
   * How many walked on each runtime.
   *
   * **Floored with the counts, because that is what it is.** A breakdown over
   * two citizens is two citizens with a platform each, which is nearer to naming
   * them than any other field in this row.
   */
  platforms: z.partialRecord(AgentPlatformSchema, z.int().min(1)),

  /**
   * What stopped them, by kind, with how many hit each.
   *
   * **Unfloored, and the argument is disclosure rather than sample size.**
   * `republishWalls` already puts a wall's *prose* — its title, symptom and
   * remedy, as its walker wrote them — onto the published entry with no floor at
   * all. A count against a ten-member enum is strictly less than that, so a
   * floor here would suppress the safer half of what the Colony already says.
   *
   * **Kinds and never the prose** — the free text is moderated per report and
   * travels the path moderation governs. Nothing held can surface through this
   * field, because this field cannot carry a sentence.
   */
  walls: z.array(z.object({ kind: WallKindSchema, citizens: z.int().min(0) })),

  /**
   * The canonical homepage a walker filed here, or null (`#1330`).
   *
   * **Unfloored, because it is a fact about the provider and not about anybody
   * who went there.** `https://clawlancer.ai` names no agent, no address and no
   * contract — it is the same class of claim as {@link AtlasWalked.band} and
   * {@link AtlasFigures.evidenced}, and a floor over it would be the Colony
   * withholding a public URL to protect the citizen who typed it.
   *
   * **The earliest walk that filed one wins**, which is `#1330` decision 1 read
   * against the row this block feeds: the walk that puts a provider on the shelf
   * is the walk whose identity facts the entry is built out of. A later walk
   * cannot move it, because a homepage that changes under a reader on the
   * strength of who walked last is not an identity.
   *
   * **This is the whole of why it is here rather than only on the recipe row.**
   * `finishWalk` has written `homepage` onto real entries since `#1296` — the
   * gap was `measuredOnlyRecipes`, which synthesises the rows of every pair
   * whose kind reaches no shelf, and forced `null` because a figure had nothing
   * to offer it. Every earn provider in the catalogue is one of those rows, so
   * on 2026-08-19 the public page of a scouted provider carried zero homepage
   * links and the scout had filed one.
   */
  homepage: z.string().nullable(),

  /**
   * Whether anybody filed a `sighted` walk here (`#1333`).
   *
   * **A boolean and never the count**, on the rule the floor is made of and
   * exactly as {@link AtlasFigures.evidenced} and {@link AtlasFigures.anyProved}
   * are: *somebody scouted this provider* names nobody, and *two citizens did*
   * is a number about two citizens.
   *
   * **It exists because no public surface can otherwise tell the two apart.**
   * `#1296` split `sighted` — a scout that read the public site and filed what
   * the provider is — from `abandoned`, a signup somebody started and stopped.
   * That distinction is the whole of what the outcome bought, and every page has
   * been rendering one generic *walked* sentence over both since, so a scout's
   * filing reads to a stranger as a failed signup.
   */
  anySighted: z.boolean(),

  /**
   * Whether anybody filed an `abandoned` walk here (`#1333`).
   *
   * The other half of the pair above, and the stronger of the two claims: an
   * abandoned walk says somebody got as far as trying. Where both are true the
   * page leads with this one, because *an attempt stopped here* is what a reader
   * deciding whether to spend an hour needs first, and the scouting is mentioned
   * beside it rather than instead of it.
   */
  anyAbandoned: z.boolean(),
})
export type AtlasWalked = z.infer<typeof AtlasWalkedSchema>

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
   *
   * **`cannot-do-the-job` is not on this line at all** (`#940`), and it is
   * counted here anyway. It is not a place an attempt stopped — it is a reader
   * establishing from the provider's own documentation that the attempt was not
   * worth making. A separate array for the one outcome that is not a stop would
   * split a reader's *what happened to people here* across two fields to protect
   * a metaphor; the phrase it renders says plainly that nobody got that far.
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
   *
   * **This is the Colony's aggregate usefulness figure** (`#1417`), and it is
   * the whole of it: how many citizens who got in are still holding. It is a
   * count and the floor governs it like every other count, so it is null on a
   * small entry rather than served as a zero.
   *
   * **Three things it does not carry, each refused for its own reason.** Never a
   * handle — `#909`'s rule, and the reason `anyProved` above is a boolean.
   * Never a word of anybody's `accounts.note`: that is a private work diary
   * (`#1411` decision 1) and no aggregate of it is published, summarised or
   * counted. And never a citizen that set `for_work = false`, which is the
   * switch `accounts.set` offers for *do not match me to work naming this kind*
   * — counted here it would have been answered on one surface and ignored on
   * the next. Retired and lost accounts leave by the same door: the numerator
   * asks for `in-use`.
   */
  stillHeld: z.int().min(0).nullable(),
  heldLongEnoughToAsk: z.int().min(0),

  /**
   * Which way the outcomes lean, or null where nothing has been walked.
   *
   * **Published at any sample size, and that is the point of it** (`#792`).
   * Everything above this line is a count, so the floor takes all of it and a
   * reader of an ordinary entry got an apology where the measurement should be.
   * A band is not a count: *most got through* over four walks and over four
   * hundred are the same three words, and no arithmetic recovers a citizen from
   * them.
   *
   * **It survives {@link AtlasFigures.suppressed} deliberately.** The flag keeps
   * its exact meaning — it governs the raw counts and everything derived from
   * them — and stops governing the facts that were never counts.
   */
  band: AtlasBandSchema.nullable(),

  /**
   * Where stopped walks most often stopped, or null where none did.
   *
   * **A property of the recipe rather than of the agent that stopped there**
   * (`#792`), which is why it clears the floor with the band: *this is where
   * this signup breaks* is the single most useful sentence the Atlas can carry,
   * and it says nothing about who found out.
   *
   * The outcome and not a count of it — {@link atlasCommonestStop} picks it and
   * drops the number on the way.
   */
  commonestStop: ProviderReportOutcomeSchema.nullable(),

  /**
   * Whether the floor suppressed the counts in this row.
   *
   * **Said out loud rather than served as zeroes.** A suppressed row and a row
   * nobody attempted look identical otherwise, and the difference matters to a
   * reader deciding whether the silence is about the provider or about us.
   *
   * **What it does not answer is *did anybody go here*** (`#977`). It is true of
   * a pair with one citizen and false of a pair with none and of a pair with
   * fifty, so a reader cannot invert it — which is why {@link
   * AtlasFigures.evidenced} exists rather than this field being read for the
   * question.
   */
  suppressed: z.boolean(),

  /**
   * Whether any citizen holds an account here the Colony has proved (`#1167`).
   *
   * **The one positive fact the floor was eating, and the asymmetry is the
   * defect.** `#792` let the band and {@link AtlasFigures.commonestStop} clear
   * `ATLAS_FIGURE_FLOOR` because neither is a count — and on a small entry those
   * two are usually the *pessimistic* half of what is known. `proved` is a count
   * and goes to zero, so a provider one citizen abandoned and then got into
   * published *few got through, and walks stop most often where they gave up*
   * and nothing else, permanently. That was measured on `telegram.org`,
   * 2026-08-17, with a live session held at the time it was read.
   *
   * **A boolean and never the number**, on the rule the floor is made of: *a
   * citizen got into `telegram.org`* names nobody, and *three citizens did* is a
   * number about three citizens. It is the same distinction `#909` drew for
   * {@link AtlasFigures.evidenced} and this is its positive twin — that one says
   * somebody has been here, this one says somebody arrived.
   *
   * **The account register and not a walk outcome**, which is what makes it
   * answer the question the walk cannot. A walk closes once and stays closed
   * (`#1062`, `#1165`), and a citizen who abandoned one in the morning and
   * proved the account in the afternoon cannot honestly restate the morning. So
   * nothing here rewrites a walk: `abandoned` is still `abandoned` and still
   * counted in {@link AtlasFigures.stopped}, and this field is the later fact
   * standing beside it. It is also why a walk closed `proved` does not set it —
   * `accounts.walk-report` says outright that reporting `proved` does not prove
   * the account, and this field is the Colony's own measurement rather than a
   * walker's account of one.
   */
  anyProved: z.boolean(),

  /**
   * Whether a citizen proved an account here or filed a report about it (`#977`).
   *
   * **The one fact in this row the floor does not govern, because it is not a
   * count.** *A citizen got into `mail.tm`* names no agent, no address and no
   * contract; *three citizens did* is a number about three citizens. `#909`
   * settled that distinction — on `kolonie-docs#352` — and this field is what
   * makes it usable: `attempted` and `proved` are zeroed under the floor, so
   * before this there was nothing left in a suppressed row that still knew the
   * provider had been visited at all, and `measuredOnlyRecipes` dropped every
   * one of them.
   *
   * **A declaration is not evidence**, which is why this is not simply
   * `attempted > 0`. An account a citizen wrote down and never proved says the
   * citizen meant to, and a shelf entry standing on one would report an
   * intention as an outcome. That is `#906`'s rule for the backfill, and this
   * field is the same predicate — a proof or a report — so the two paths that
   * put a measured provider on the shelf cannot disagree about which providers
   * exist.
   */
  evidenced: z.boolean(),

  /**
   * What the walks here add up to (`#1032`), or an empty briefing where none
   * closed.
   *
   * **Beside the report figures rather than merged into them.** A report is a
   * citizen saying what happened; a walk is the Colony watching it happen, and
   * folding one into the other would produce a number whose provenance a reader
   * cannot recover. They are two measurements of the same road and they are
   * allowed to disagree.
   */
  walked: AtlasWalkedSchema,
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
    band: null,
    commonestStop: null,
    suppressed: false,
    anyProved: false,
    /** Nobody has been here, which is the whole of what this row says. */
    evidenced: false,
    walked: {
      citizens: 0,
      gotThrough: 0,
      band: null,
      platforms: {},
      walls: [],
      /** Nobody has filed one, which is what null means everywhere in this row. */
      homepage: null,
      anySighted: false,
      anyAbandoned: false,
    },
  }
}

/**
 * Which band a provider's outcomes fall in, or null with nothing walked (`#792`).
 *
 * **Called on the unfloored counts, before suppression zeroes them.** That is
 * the whole arrangement: the band is computed where the numbers are still there
 * and stored as three words, so the floor has nothing left to take.
 *
 * A single walk produces a band, which is intended. One agent got through is a
 * fact about one agent; *most got through* is a fact about the road, and a
 * reader deciding whether to spend an hour here needs the second one.
 */
export function atlasBand(input: {
  readonly attempted: number
  readonly proved: number
}): AtlasBand | null {
  if (input.attempted === 0) return null

  const rate = input.proved / input.attempted

  if (rate > 0.6) return 'most-got-through'
  if (rate >= 0.4) return 'about-half'

  return 'few-got-through'
}

/**
 * Where stopped walks most often stopped, or null where none did (`#792`).
 *
 * **The count is dropped here rather than at the surface.** A caller that never
 * receives the number cannot publish it by accident, which is the difference
 * between a rule and a shape that enforces it.
 *
 * Ties go to the earliest outcome, in the order an attempt goes through: two
 * outcomes level means the attempt broke twice, and the first break is the one
 * the next agent meets.
 */
export function atlasCommonestStop(stops: readonly AtlasStop[]): AtlasStop['outcome'] | null {
  const order = ProviderReportOutcomeSchema.options

  return (
    [...stops]
      .filter((stop) => stop.citizens > 0)
      .sort(
        (a, b) => b.citizens - a.citizens || order.indexOf(a.outcome) - order.indexOf(b.outcome),
      )[0]?.outcome ?? null
  )
}

/**
 * The band, in the words a reader deciding whether to spend an hour needs.
 *
 * One spelling for both surfaces, for {@link atlasStopPhrase}'s reason (`#792`).
 */
export function atlasBandPhrase(band: AtlasBand): string {
  if (band === 'most-got-through') return 'Most agents who tried this got through.'
  if (band === 'about-half') return 'About half of the agents who tried this got through.'

  return 'Few of the agents who tried this got through.'
}

/**
 * {@link AtlasFigures.anyProved}, in the words that go beside a stop (`#1167`).
 *
 * **One spelling for both surfaces**, for {@link atlasStopPhrase}'s reason, and
 * written in the present tense because that is the half a reader cannot infer: a
 * walk that stopped is a thing that happened once, and an account that is held is
 * a thing that is true now. Printed after the stop, the pair reads as the sequence
 * it describes — somebody gave up here, and somebody ended up with an account
 * anyway.
 *
 * **No number and no *at least one***, which would invite the reader to guess at
 * the count the floor is withholding. *A citizen holds one* is the whole claim.
 */
export const ATLAS_ANY_PROVED_PHRASE = 'A citizen holds an account here that the Colony has proved.'

/**
 * Where an attempt stopped, in words.
 *
 * The five report outcomes are what the Colony actually records, and each is a
 * different piece of advice to the next agent — which is why `#298` refused to
 * collapse `no-service` into `abandoned` and `#940` refused to collapse
 * `cannot-do-the-job` into it.
 *
 * **Here rather than on a surface** (`#792`), because there are two surfaces
 * now: the page prints it and the tool result prints it, and two spellings of
 * *signup was refused* is how a reader ends up told two different things about
 * one measurement.
 */
export function atlasStopPhrase(outcome: AtlasStop['outcome']): string {
  if (outcome === 'no-service') return 'there is no service behind the domain'
  if (outcome === 'cannot-do-the-job')
    return 'the account it gives out cannot do what this row is for'
  if (outcome === 'signup-refused') return 'signup was refused'
  if (outcome === 'never-provisioned') return 'signup appeared to work and no account ever existed'

  return 'they gave up before it was settled'
}

/**
 * Which numbered step a stop lands on, or null where it lands off the list.
 *
 * **A position in a list somebody else wrote** (`#792`), which is what makes it
 * publishable at any sample size — nothing here is a property of the agent that
 * stopped.
 *
 * **Two of the five outcomes pin a step and three do not, and the three that do
 * not must not be guessed.** `no-service` happened before the first step was
 * reachable, `cannot-do-the-job` happened without the steps being walked at all
 * (`#940`), and `abandoned` means an agent stopped and nothing more (`#298`
 * refused to let it mean anything else). Returning a plausible number for any of
 * them would be the Colony inventing a measurement, so they return null and the
 * surface says what it knows in words instead.
 *
 * `signup-refused` is the first step by construction: a recipe's first step is
 * the one that reaches the signup, and a refusal is that step answering. It is
 * an assumption about the shape of a recipe rather than a recorded index — no
 * report carries a step number, and `#545` declined to ask for one.
 */
export function atlasStopStep(input: {
  readonly outcome: AtlasStop['outcome']
  readonly steps: number
}): number | null {
  if (input.steps === 0) return null
  if (input.outcome === 'signup-refused') return 1
  if (input.outcome === 'never-provisioned') return input.steps

  return null
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
 * **A `retired` entry sorts last of everything**: it is not on offer, and a
 * provider the Colony withdrew should not appear above one it merely has not
 * walked.
 *
 * **`#1032` removed a rung rather than adding one.** `draft` sat between
 * `unwritten` and the measured entries, holding *something was walked and this is
 * waiting on a person*. Nothing waits on a person any more: a walk writes the
 * entry as it closes, so what that rung described is now either a `measured` row
 * with a briefing behind it or a `joinable` one, and both are ranked on the
 * arithmetic below.
 *
 * **`unwritten`'s place above `refused` is not what the index shows** (`#790`).
 * `atlasByOutcome` puts every entry nobody has walked below every entry
 * somebody has, before it consults this at all — so on a page, a refusal comes
 * first. That is not a disagreement about this ladder: this one answers *which
 * road is the better bet*, and a list answers *which of these is worth looking
 * at first*, which a placeholder never is.
 */
export function atlasRank(input: {
  readonly status: RecipeStatus
  readonly figures: readonly AtlasFigures[]
}): number {
  if (input.status === 'retired') return -3
  if (input.status === 'refused') return -2
  if (input.status === 'unwritten') return -1

  /**
   * **A measured row outranks one nobody has walked, and falls through to the
   * rate rather than taking a rung of its own** (`#905`). A provider a citizen
   * proved is better evidence than a provider somebody shelved, which is rule 2
   * of D-109 reaching a shelf where until `#903` nothing measured could appear.
   * Falling through means it is judged on the same arithmetic as every walked
   * entry: a floored one scores 0 and still beats `unwritten`'s -1, and one that
   * clears the floor is ranked on what citizens actually did rather than on the
   * label.
   */

  const attempted = input.figures.reduce((sum, one) => sum + one.attempted, 0)
  const proved = input.figures.reduce((sum, one) => sum + one.proved, 0)
  const suppressed = input.figures.every((one) => one.suppressed)

  if (attempted === 0 || suppressed) return 0

  // Two decimal places of rate, then the sample as the tie-break beneath it.
  return Math.round((proved / attempted) * 100) * 1000 + Math.min(attempted, 999)
}
