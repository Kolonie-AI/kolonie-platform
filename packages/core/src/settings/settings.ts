import { z } from 'zod'

/**
 * The settings a maintainer may turn without a deploy — D-104 (`#488`, `#489`).
 *
 * ## This list is an allow-list, and that is the security property
 *
 * D-104: *"only names in an explicit allow-list are readable or writable through
 * the settings path, and a name absent from it is not 'not yet supported' — it
 * is refused."* A settings table whose safety depends on nobody adding the wrong
 * row is not safe, so the exclusion is a property of this module rather than a
 * rule on a page.
 *
 * **The direction is deliberate.** Forgetting to *add* a tunable is a minor
 * inconvenience discovered immediately by whoever wanted it. Forgetting to
 * *exclude* a secret is discovered by somebody else.
 *
 * ## What may never appear here
 *
 * Every credential and token; anything `preflight_env()` checks, because a value
 * the deploy verifies and the process then reads from elsewhere makes that check
 * a formality; and `PORT`/`HEALTH_PORT`, read before the process can reach a
 * database. `settings.test.ts` asserts the first of those three by name rather
 * than trusting a reviewer to notice.
 */

/** Which kind of thing a setting is, for grouping on the page. */
export const SettingGroupSchema = z.enum(['cadence', 'model', 'threshold', 'switch'])
export type SettingGroup = z.infer<typeof SettingGroupSchema>

/**
 * How quickly a change reaches a running process.
 *
 * D-104 fixes the general answer at **30 seconds**, through a cache read at the
 * point of use — a number rather than *eventually*, because a maintainer
 * flipping a switch has to know what they are waiting for and when to conclude
 * something is wrong.
 */
export const SETTING_MAX_STALENESS_MS = 30_000

/** One setting, and everything a page needs to render and validate it. */
export interface SettingDefinition {
  /** The environment variable it overrides, which is also its key. */
  readonly name: string
  readonly group: SettingGroup
  /**
   * What it is, in a sentence — **not the variable name alone**.
   *
   * `#489`: *"`MODERATION_MODEL` means nothing to somebody deciding whether to
   * change it at two in the morning."*
   */
  readonly describes: string
  /**
   * What a valid value is.
   *
   * **The same schema the reader uses**, not a looser one written for the form.
   * A poll interval of `0` and a model name that is not a model are both things
   * a text box will happily accept and a runner will not survive, and the
   * refusal has to happen before the row is written rather than at the next loop.
   */
  readonly schema: z.ZodType<string>
  /**
   * How long a change can take to reach a running process, when that is not the
   * general 30 seconds.
   *
   * D-104: the cadence values are read at the top of each loop, because a loop
   * that has already slept for its old interval cannot un-sleep. Their bound is
   * one interval, and it is stated here rather than left to be discovered.
   */
  readonly reachesRunningProcess?: string
  /**
   * What this value does that the maintainer setting it may not have looked up
   * (`#654`), or nothing.
   *
   * **A consequence and not a rule.** It never refuses a value and never
   * narrows {@link schema} — `#654` is explicit that a floor here would be *"the
   * tool having an opinion about economics it does not hold"*, and a maintainer
   * may have a good reason for a figure whose consequence they have read and
   * accepted. What it removes is the *silently*: `#651` cut the review reward
   * tenfold, correctly, and moved a new steward's first payout from one decision
   * to nine — a fact that existed the moment the value was written and that
   * nothing said out loud.
   *
   * **It reads the effective value, so `undefined` means unset.** The consequence
   * of the code fallback is as real as the consequence of an override, and a
   * warning that only appeared once somebody typed a number would be silent about
   * exactly the case that is live today.
   *
   * **It is not a validation hook by another name.** `schema` decides what may be
   * written; this decides what is worth saying about what was.
   */
  readonly consequence?: (value: string | undefined) => string | undefined
}

/** A positive whole number of milliseconds, as text. */
const millis = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]*$/, 'a whole number of milliseconds, greater than zero')

/**
 * A model identifier, in the `provider/model` shape OpenRouter uses.
 *
 * Deliberately shape-only: this cannot know which models exist, and a list here
 * would be wrong the week after it was written. What it catches is the empty
 * box, the stray newline and the value that is plainly not a model reference —
 * which is the class a text box actually produces.
 */
const modelReference = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i, 'a provider/model reference')

/**
 * An agent handle.
 *
 * Shape only, like every other setting: this cannot know which handles exist,
 * and a value naming no agent produces a route that answers *nothing published*
 * rather than an error — which is the same thing an unset value produces, and
 * the right thing for a page that is optional.
 */
const handle = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i, 'an agent handle')

/** `on` or `off`, and nothing else a checkbox might produce. */
const toggle = z.enum(['on', 'off'])

/** A percentage, whole, `0`–`100`. */
const percent = z
  .string()
  .trim()
  .regex(/^(100|[1-9]?[0-9])$/, 'a whole percentage between 0 and 100')

/** A whole number of lamports, one or more. Text, like every setting. */
const lamports = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]*$/, 'a whole number of lamports, greater than zero')

/**
 * A whole number of lamports, or zero.
 *
 * **Zero is a value here and not an absence**, which is what separates the floor
 * (D-112) from the ceilings: a floor of nothing is the state the Colony was in
 * before it, and turning the rule off has to be reachable without a deploy.
 */
const lamportsOrZero = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]*)$/, 'a whole number of lamports, zero or more')

/** A count of one or more. */
const atLeastOne = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]*$/, 'a whole number, one or more')

export const SETTINGS: readonly SettingDefinition[] = [
  {
    name: 'POLL_INTERVAL_MS',
    group: 'cadence',
    describes:
      'How long a runner waits between passes over its queue. Lower means work is picked up ' +
      'sooner and the database is asked more often.',
    schema: millis,
    reachesRunningProcess:
      'At the top of the next pass — so up to one interval, not thirty seconds. A loop already ' +
      'sleeping for the old interval cannot un-sleep.',
  },
  {
    name: 'BRIEFING_INTERVAL_MS',
    group: 'cadence',
    describes: 'How often the moderation runner writes its briefing.',
    schema: millis,
    reachesRunningProcess: 'At the top of the next pass.',
  },
  {
    name: 'ATTRIBUTION_INTERVAL_MS',
    group: 'cadence',
    describes: 'How often the badge runner re-checks attribution.',
    schema: millis,
    reachesRunningProcess: 'At the top of the next pass.',
  },
  {
    name: 'REFUND_INTERVAL_MS',
    group: 'cadence',
    describes: 'How often the badge runner sweeps for refunds it owes.',
    schema: millis,
    reachesRunningProcess: 'At the top of the next pass.',
  },
  {
    name: 'OPENROUTER_MODEL',
    group: 'model',
    describes:
      'The model the moderation runner judges quests with. Changing it changes what gets ' +
      'approved, so it is an operating decision rather than a preference.',
    schema: modelReference,
  },
  {
    name: 'TRIAGE_MODEL',
    group: 'model',
    describes: 'The model the support-triage runner reads tickets with.',
    schema: modelReference,
  },
  {
    name: 'SCENE_VISION_MODEL',
    group: 'model',
    describes: 'The model the scene rung is verified with.',
    schema: modelReference,
  },
  {
    name: 'OPENROUTER_EMBEDDING_MODEL',
    group: 'model',
    describes: 'The embedding model used where the Colony compares text to text.',
    schema: modelReference,
  },
  {
    name: 'SIGNUP_PACE_PER_PROVIDER_PER_DAY',
    group: 'threshold',
    describes:
      'How many accounts one operator may have the Colony help create at one provider in a day ' +
      '(#532). A provider does not see agents — it sees a network, a payment instrument, a ' +
      'naming pattern and a responsible party — so ten agents signing up once looks exactly ' +
      'like one party signing up ten times, because that is what it is. Reaching this defers a ' +
      'recipe until tomorrow rather than failing it; nothing is lost and nobody is told to try ' +
      'again. Raise it for a provider that has shown it tolerates volume, and know that the ' +
      'thing being risked is the register itself: the fastest way to destroy it is to fill it ' +
      'too quickly.',
    schema: atLeastOne,
  },
  {
    name: 'PLATFORM_FEE_PERCENT',
    group: 'threshold',
    describes:
      'The Colony’s share of a quest’s reward, as a whole percentage. It is recorded on each ' +
      'quest when it is published, so a change here does not move money already escrowed.',
    schema: percent,
  },
  {
    name: 'QUEST_OBSTACLE_BONUS_PERCENT',
    group: 'threshold',
    describes:
      'What share of one accepted answer a published obstacle report pays its author, as a whole ' +
      'percentage. Applies to quests published from now on: the share is written onto a quest ' +
      'when it is published, so a change here never moves money a sponsor has already committed. ' +
      'The number that matters is the one an agent compares against answering — set it high ' +
      'enough that reporting a wall is worth doing, and low enough that reporting one is not a ' +
      'better trade than doing the work. Zero means the bonus is not paid at all.',
    schema: percent,
  },
  {
    name: 'QUEST_TIER_CAP_HARD_LAMPORTS',
    group: 'threshold',
    describes:
      'The most a hard quest — one whose answers a third-party verifier checks — may pay per ' +
      'accepted report, in lamports. Unset means the figure in governance/quests.md, which is ' +
      'what every ceiling falls back to: there is no value meaning “no ceiling”. The ceilings ' +
      'are what stands between the tier names and their meaning, so raising one is not the ' +
      'same kind of act as lowering it — a raise lets the Colony advertise more money for ' +
      'evidence it has not made any stronger.',
    schema: lamports,
  },
  {
    name: 'QUEST_TIER_CAP_COLONY_JUDGED_LAMPORTS',
    group: 'threshold',
    describes:
      'The most a colony-judged quest — one a model reads against the sponsor’s own stated ' +
      'criteria — may pay per accepted report, in lamports. Unset means the figure in ' +
      'governance/quests.md.',
    schema: lamports,
  },
  {
    name: 'QUEST_TIER_CAP_SOFT_LAMPORTS',
    group: 'threshold',
    describes:
      'The most a soft quest — one where only the citizen’s own word says it happened — may ' +
      'pay per accepted report, in lamports. Unset means the figure in governance/quests.md. ' +
      'This is the one the rule was written for: a softly verified quest must never pay more ' +
      'than the reputation it risks.',
    schema: lamports,
  },
  {
    name: 'QUEST_PRICE_FLOOR_LAMPORTS',
    group: 'threshold',
    describes:
      'The least a quest may promise a citizen, in lamports, measured on what actually arrives ' +
      '— after the platform fee for an accepted answer, and on the obstacle share for a ' +
      'published obstacle report. A quest that promises less is refused when it is written, ' +
      'edited, submitted or topped up. It sits above the chain’s rent-exempt minimum, which is ' +
      'Solana’s figure and can move, and that is why it is a setting: following it should not ' +
      'need a deploy. Unset means the figure in governance/quests.md. Zero turns the rule off ' +
      'entirely, which is the state the Colony was in before D-112. A quest paying no lamports ' +
      'at all is unaffected either way.',
    schema: lamportsOrZero,
  },
  {
    name: 'QUEST_AUDIT_DISAGREEMENT_THRESHOLD',
    group: 'threshold',
    describes:
      'How far two audit opinions may differ before a quest is held for a person to look at.',
    schema: atLeastOne,
  },
  {
    name: 'PERMISSION_AGGREGATE_FLOOR',
    group: 'threshold',
    describes:
      'How many distinct citizens must report the same permission block before it is shown at ' +
      'all. Lowering it makes a thin signal traceable to one contract, which is what the floor ' +
      'exists to prevent.',
    schema: atLeastOne,
  },
  {
    name: 'WAKE_MAX_PER_HOUR',
    group: 'threshold',
    describes:
      'How many times in an hour the Colony may knock on one citizen’s wake address. An ' +
      'endpoint that makes the Colony issue outbound requests is an amplifier, and this is the ' +
      'ceiling on it. Raising it makes a busy hour reach an agent sooner; lowering it means ' +
      'more events wait for the agent’s own rhythm, which is what every agent had before the ' +
      'rung existed.',
    schema: atLeastOne,
  },
  {
    name: 'OPERATOR_REQUEST_OPEN_MAX',
    group: 'threshold',
    describes:
      'How many word requests one citizen may have open with its operator at once. Unset means ' +
      'eight: enough to equip several accounts in one sitting, while keeping the page a short ' +
      'list a person can realistically clear rather than a batch workload.',
    schema: atLeastOne,
  },
  {
    name: 'SMS_MAX_PER_CITIZEN_PER_DAY',
    group: 'threshold',
    describes:
      'How many text messages the Colony will send one citizen in a day. A rung needs one code, ' +
      'two if the first is lost, so this bounds the day rather than the minute — a citizen ' +
      'retrying after a carrier ate its message must not be refused.',
    schema: atLeastOne,
  },
  {
    name: 'SMS_MAX_PER_COUNTRY_PER_DAY',
    group: 'threshold',
    describes:
      'How many text messages the Colony will send to one country in a day, across every ' +
      'citizen. This is the ceiling that bounds SMS pumping: an attacker points the phone rung ' +
      'at a range whose carrier pays it for the traffic, and neither a per-citizen ceiling nor ' +
      'the Colony’s daily total bounds that, because registering is free and one expensive ' +
      'country can absorb the whole budget. Raise it during a genuine surge from one country; ' +
      'lower it if a bill arrives that nobody can explain.',
    schema: atLeastOne,
  },
  {
    name: 'SMS_MAX_PER_DAY',
    group: 'threshold',
    describes:
      'How many text messages the Colony will send in a day, in total. The ceiling on the whole ' +
      'spend, and the one that still applies to a message whose destination country the carrier ' +
      'could not name.',
    schema: atLeastOne,
  },
  {
    name: 'SWARM_PORTRAIT_AGENT',
    group: 'switch',
    describes:
      'The handle of one agent whose swarm may be drawn publicly, for the demonstration page on ' +
      'the website. Unset means no swarm is published at all, which is the default and the safe ' +
      'state — a swarm portrait says which agents answer to the same person, and that is not ' +
      'public for anybody who has not opted in by being named here.',
    schema: handle,
  },
  {
    name: 'REGISTRATION_OPEN',
    group: 'switch',
    describes: 'Whether new agents may register at all.',
    schema: toggle,
  },
  {
    name: 'QUEST_AUDIT_ENFORCING',
    group: 'switch',
    describes:
      'Whether the quest audit refuses a quest it disagrees with, or merely records the ' +
      'disagreement.',
    schema: toggle,
  },
  {
    name: 'TREASURY_SWEEP_INTERVAL_MS',
    group: 'cadence',
    describes:
      'How long the Colony waits between moving its earned fee from the payout wallet to the ' +
      'Treasury (#507). The timer on the host calls the sweep far more often than this; the ' +
      'interval is what decides whether a call actually sends anything, so it is a dial here ' +
      'rather than a deploy. Lower means the hot wallet holds the fee for less time, which is ' +
      'the whole point of moving it, and costs one transaction fee per sweep.',
    schema: millis,
    reachesRunningProcess:
      'At the next call from the timer — the interval is read per sweep and nothing caches it.',
  },
  {
    name: 'PAYOUT_MAX_LAMPORTS',
    group: 'threshold',
    describes:
      'The most a single payout may ever be, in lamports. A report computing to more than this ' +
      'is refused and raised, never paid and apologised for. There is no value meaning ' +
      '"no ceiling": a ceiling that defaults to infinity is not a ceiling.',
    schema: lamports,
  },
  {
    name: 'PAYOUT_DAILY_MAX_LAMPORTS',
    group: 'threshold',
    describes:
      'The most all payouts together may be in one day, in lamports. Reaching it stops payments ' +
      'and raises; it does not silently queue. Payment is automatic, immediate and otherwise ' +
      'unbounded, and a duplicated acceptance or a retry that does not recognise a prior ' +
      'success would drain the wallet at the speed of the chain.',
    schema: lamports,
  },
]

/** The setting by that name, or `undefined` — which means **refused**, not unsupported. */
export function settingNamed(name: string): SettingDefinition | undefined {
  return SETTINGS.find((setting) => setting.name === name)
}

/**
 * Names that must never become settings, asserted rather than reviewed.
 *
 * D-104's second list, as data. `settings.test.ts` checks {@link SETTINGS}
 * against it, so adding one of these is a test failure rather than a thing
 * somebody notices in review — which is the difference between a rule and a
 * guarantee.
 */
export const NEVER_A_SETTING: readonly string[] = [
  // Every credential and token. A secret readable through a web page is a
  // secret with a new and much larger blast radius.
  'CLOUDFLARE_EMAIL_SEND_TOKEN',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_API_KEY_SID',
  'TWILIO_ACCOUNT_SID',
  'HCAPTCHA_SECRET',
  'EMAIL_INBOUND_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  'DEPOSIT_SEALING_KEY',
  'OPERATOR_DROP_SEALING_KEY',
  'GITHUB_VERIFIER_TOKEN',
  'OPENROUTER_API_KEY',
  'AUTH0_CONSOLE_CLIENT_SECRET',
  'DATABASE_URL',
  'BAN_MARK_SALT',
  // Read before the process can reach a database.
  'PORT',
  'HEALTH_PORT',
]
