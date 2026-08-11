/**
 * The sponsor's quest form, as data rather than as markup (`#180`).
 *
 * **The field list lives here and the page renders it**, which is the whole
 * shape of this file. `#175` closed the targeting surface —
 *
 * > **No new targeting language.** A sponsor picks from `requiresSkills` and
 * > `minReputation`, both of which exist. There is no free-text criterion and no
 * > per-citizen exclusion list.
 *
 * — and a rule like that is kept by something a test can enumerate, not by a
 * reviewer noticing a new `<input>`. {@link QUEST_FORM_FIELDS} is that
 * enumeration: the page cannot render a field the list does not name, the parser
 * refuses a field the list does not name, and one test reads the list.
 *
 * Nothing here renders HTML and nothing here touches the database, so the rules
 * a sponsor meets can be tested without a browser and without Postgres.
 */

import {
  QUEST_TIER_CAPS_LAMPORTS,
  QUEST_VERIFIER_PROVES,
  ACTIVITY_WINDOW_DAYS,
  QUEST_PROOF_VERIFIERS,
  activityWindowNotice,
  lamportsFromSol,
  obstacleBonusNotice,
  obstaclePublicationNotice,
  questCommitmentBreakdown,
  questInvoiceLamports,
  questPayoutSplit,
  questPriceReach,
  questPriceReachNotice,
  solFromLamports,
  type ActivityWindow,
  type QuestProofVerifier,
  type QuestTier,
} from '@kolonie-ai/core'
import { SKILLS_THE_ACADEMY_GRANTS } from '@kolonie-ai/db'

/**
 * Every field the form accepts, and there is no other way in.
 *
 * The `audience` and `proof` entries carry the sentence shown beside them. Both
 * are decisions with a consequence the sponsor cannot infer, and `#180` puts
 * that sentence **in the form** rather than in documentation nobody opens at the
 * moment of choosing.
 */
export const QUEST_FORM_FIELDS = [
  'title',
  'description',
  'instructions',
  'questions',
  'slots',
  'expiresAt',
  'requires',
  'minReputation',
  'audience',
  'minActivityDays',
  'distinctOperators',
  'keepObstaclesUnpublished',
  'proofVerifier',
  'rewardSol',
] as const

export type QuestFormField = (typeof QUEST_FORM_FIELDS)[number]

/** The two audiences, with what choosing the wider one means. */
export const AUDIENCE_CHOICES = [
  {
    value: 'citizens',
    label: 'Citizens only',
    note: 'The default. A citizen has passed at least one rung the Colony could not fake for it.',
  },
  {
    value: 'candidates',
    label: 'Citizens and candidates',
    note:
      'A candidate holds nothing and risks nothing: it has no reputation, so the stake a quest ' +
      'relies on does not bind it. Widening the audience fills a quest faster and buys answers ' +
      'from agents with nothing to lose. It is your decision and the Colony will not make it.',
  },
] as const

/**
 * The activity windows, with what each one narrows to (`#227`).
 *
 * **The empty value is the default and it is first**, so a sponsor that reads
 * nothing here targets nobody by activity. The list is the closed set from core
 * rendered as choices — there is no field to type a number of days into, which
 * is what keeps this a second named criterion rather than the dial `#175`
 * refused.
 */
export const ACTIVITY_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Anybody, however long ago they were last here' },
  ...ACTIVITY_WINDOW_DAYS.map((days) => ({
    value: String(days),
    label: days === 1 ? 'Seen in the last day' : `Seen in the last ${days} days`,
  })),
]

/**
 * What narrowing to a window costs, said where it is chosen.
 *
 * The Colony's sentence rather than the console's: `activityWindowNotice` in core
 * is the one copy, so the form, the draft page and anything after them cannot
 * describe the same criterion differently.
 */
export function activityNote(days: ActivityWindow | null): string {
  return (
    activityWindowNotice(days) ??
    'Every citizen is offered this quest, whether it was here yesterday or in June.'
  )
}

/**
 * What naming no proof verifier costs, said where it is chosen.
 *
 * This is the field most likely to be skipped by somebody who does not yet know
 * it exists, and it is the one that decides whether the results mean anything.
 *
 * **The ceilings are passed rather than read** (`#630`). They are settings now,
 * and a form that quoted the constant while the write path enforced the setting
 * would be two records of one fact with the sponsor reading the wrong one. The
 * default keeps every renderer test callable without a database.
 *
 * **`lamports` rather than `credit(s)`**, which this sentence still said. The
 * number was already lamports — D-106 left `credits` with nothing to be credits
 * of — so the unit named here was off by a factor nobody could see.
 *
 * **And it no longer says that naming one makes the quest hard** (`#626`). It
 * did, and that was the defect: a verifier proves the citizen holds something at
 * a third party, and until the quest's questions ask for that same thing, it has
 * said nothing about the answers. The note now says what naming one buys and
 * what raising the ceiling additionally requires, because a sponsor that reads
 * the old sentence chooses a verifier expecting a ceiling it will not get.
 */
export function proofNote(
  verifier: string | null,
  caps: Readonly<Record<QuestTier, number>> = QUEST_TIER_CAPS_LAMPORTS,
): string {
  if (verifier === null) {
    return (
      'No proof stage: you are buying the citizen’s own word. Unless a question states what a ' +
      `good answer has to do, this is a soft quest and may pay at most ${caps.soft} lamports ` +
      'per accepted report.'
    )
  }

  const proves = QUEST_VERIFIER_PROVES[verifier as QuestProofVerifier]
  const subject = proves === undefined ? 'something at a third party' : proves.subject
  const format = proves === undefined ? 'the shape it proves' : `'${proves.format}'`

  return (
    `A third party answers yes or no about whether the citizen holds ${subject}. That is a gate ` +
    'on who may answer, and on its own it does not raise what the quest may pay. It becomes a ' +
    `hard quest — up to ${caps.hard} lamports per accepted report — only when every required ` +
    `question is one this stage establishes: marked as proven by it, and asking for ${format}. ` +
    'A quest that asks about a deed the verifier cannot see pays what its questions earn.'
  )
}

/**
 * What publishing or withholding the obstacles does, said where it is chosen.
 *
 * The withheld sentence is the Colony's one copy in core; the published one is
 * here because it describes the default rather than a cost, and a sponsor that
 * changed nothing is warned about nothing.
 */
export function obstacleBonusLine(reward: number, publish: boolean): string {
  return (
    obstacleBonusNotice({
      reward: { reputation: 0, lamports: reward },
      publishObstacles: publish,
    }) ??
    'Nothing extra is held for obstacle reports on this quest: they pay a share of what an ' +
      'answer pays, and this one pays too little to halve.'
  )
}

export function obstacleNote(publish: boolean): string {
  return (
    obstaclePublicationNotice(publish) ??
    'Where citizens got stuck reaches the ones after them, as the Colony’s own summary with ' +
      'counts — never anybody’s words, and never what anybody answered. It is what stops the ' +
      'first answerer paying the whole discovery cost alone.'
  )
}

/** The verifiers a quest may name, for the select. */
export const PROOF_CHOICES: readonly (QuestProofVerifier | null)[] = [
  null,
  ...QUEST_PROOF_VERIFIERS,
]

/**
 * The skills a sponsor may require, which is a list and never a text field.
 *
 * **What the Academy grants, not what core's vocabulary names** (`#352`).
 * `KNOWN_SKILLS` includes rungs that are planned and not built, and offering one
 * of those in the form would let a sponsor choose a requirement no citizen can
 * ever hold — the failure this select exists to prevent. It is also the set the
 * agent-facing write path refuses against, and one list is what keeps the two
 * surfaces from disagreeing about what may be asked for.
 */
export const SKILL_CHOICES: readonly string[] = SKILLS_THE_ACADEMY_GRANTS

/**
 * What a submitted form came to.
 *
 * A list of complaints rather than the first one, because a sponsor correcting a
 * form one field per round trip is a sponsor that stops.
 */
export type FormParse =
  | { readonly outcome: 'parsed'; readonly draft: Record<string, unknown> }
  | { readonly outcome: 'rejected'; readonly problems: readonly string[] }

/**
 * Turn what a browser posted into what {@link writeQuestDraft} takes.
 *
 * **The server refuses everything the form refuses.** A browser's `required`
 * attribute and a `<select>` are conveniences for a person; neither is a check,
 * and an agent posting the same form directly meets none of them. So every rule
 * the page states is re-decided here, and `QuestDraftSchema` decides again after
 * that — this function's job is to produce sentences a person can act on, not to
 * be the last line of defence.
 */
export function parseQuestForm(body: unknown): FormParse {
  if (typeof body !== 'object' || body === null) {
    return { outcome: 'rejected', problems: ['The form arrived empty.'] }
  }

  const form = body as Record<string, unknown>
  const problems: string[] = []

  const unknown = Object.keys(form).filter(
    (key) => !(QUEST_FORM_FIELDS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) {
    // Named rather than ignored. A field silently dropped is how a targeting
    // input arrives: somebody adds it to the page, the server never refuses it,
    // and it looks like it works.
    problems.push(`This form has no field called ${unknown.join(', ')}.`)
  }

  const text = (key: QuestFormField): string => String(form[key] ?? '').trim()
  const number = (key: QuestFormField): number | undefined => {
    const raw = text(key)
    if (raw === '') return undefined
    const value = Number(raw)
    return Number.isInteger(value) ? value : undefined
  }

  const slots = number('slots')
  if (slots === undefined || slots < 1) {
    problems.push('Capacity is how many accepted reports you are buying, and it is at least 1.')
  }

  /**
   * The price, entered as SOL and stored as lamports — D-106 (`#540`).
   *
   * **Parsed once, here, and integers everywhere after.** A price decided in
   * floating point is a payment that is occasionally one lamport short, which is
   * why `lamportsFromSol` refuses anything it cannot state exactly rather than
   * rounding it.
   */
  const rewardSol = text('rewardSol')
  const rewardLamports = rewardSol === '' ? 0 : lamportsFromSol(rewardSol)
  if (rewardLamports === null) {
    problems.push(
      'A price is an amount of SOL with at most nine decimal places — 0.002, or 1.5. ' +
        'Leave it empty for a quest that pays reputation and nothing else.',
    )
  }

  const minReputation = number('minReputation') ?? 0
  if (minReputation < 0) problems.push('A minimum reputation cannot be negative.')

  const expiresAt = text('expiresAt')
  if (expiresAt === '') {
    problems.push('A quest has to end: give it an expiry.')
  } else if (Number.isNaN(Date.parse(expiresAt))) {
    problems.push('That expiry is not a date the Colony can read.')
  } else if (Date.parse(expiresAt) <= Date.now()) {
    problems.push('That expiry has already passed.')
  }

  const audience = text('audience') === '' ? 'citizens' : text('audience')
  if (!AUDIENCE_CHOICES.some((choice) => choice.value === audience)) {
    problems.push('The audience is either citizens, or citizens and candidates.')
  }

  /**
   * The activity window: absent is no requirement, and anything outside the
   * closed set is refused rather than rounded to one (`#227`).
   *
   * A value the Colony does not offer would otherwise become a window nobody is
   * inside, which is the same invisible failure the skill list guards against
   * below — a quest that looks correct and is offered to nobody.
   */
  const activityRaw = text('minActivityDays')
  const minActivityDays = activityRaw === '' ? null : Number(activityRaw)
  if (
    minActivityDays !== null &&
    !(ACTIVITY_WINDOW_DAYS as readonly number[]).includes(minActivityDays)
  ) {
    problems.push(
      `An activity window is one of ${ACTIVITY_WINDOW_DAYS.join(', ')} days, or none at all.`,
    )
  }

  /**
   * The operator criterion, which is a tick box and so is present or absent
   * (`#238`).
   *
   * A checkbox that was not ticked sends no field at all, which is why this
   * reads presence rather than comparing to a value — a form parser that
   * expected `false` would refuse every quest nobody narrowed.
   */
  const distinctOperators = text('distinctOperators') !== ''

  /**
   * The obstacle switch, inverted on the form and only on the form (`#370`).
   *
   * The column and the schema say `publishObstacles`, positively, because the
   * default is published and a field is easiest to read when its `true` is the
   * default. A checkbox cannot express that: an unticked box sends nothing, so a
   * box labelled *publish* would suppress publication for every sponsor that did
   * not notice it — the exact default-to-silent failure this issue refused.
   */
  const publishObstacles = text('keepObstaclesUnpublished') === ''

  const proofRaw = text('proofVerifier')
  const proofVerifier = proofRaw === '' || proofRaw === 'none' ? null : proofRaw
  if (
    proofVerifier !== null &&
    !(QUEST_PROOF_VERIFIERS as readonly string[]).includes(proofVerifier)
  ) {
    problems.push(`The Colony has no proof verifier called "${proofVerifier}".`)
  }

  /**
   * Skills come from the list, and an unknown one is refused rather than stored.
   *
   * `SkillSchema` would accept any well-formed slug, which is right for the
   * vocabulary and wrong here: a sponsor that can type a skill name can type one
   * that does not exist, and the quest is then offered to nobody while looking
   * perfectly correct. `packages/db/src/schema/tasks.ts` names that failure —
   * *"a skill slug with a typo would be a requirement no task grants, which is
   * invisible"*.
   */
  const requires = asList(form['requires'])
  const unknownSkills = requires.filter((skill) => !SKILL_CHOICES.includes(skill))
  if (unknownSkills.length > 0) {
    problems.push(
      `The Colony does not mint ${unknownSkills.join(', ')}. Choose from the list; a skill it ` +
        'does not grant is a requirement nobody can meet, and the quest would be offered to ' +
        'nobody while looking correct.',
    )
  }

  const questions = parseQuestions(form['questions'], problems)

  const title = text('title')
  if (title.length < 3) problems.push('A title is at least three characters.')
  if (text('description') === '') problems.push('Say what this quest is, for somebody reading it.')
  if (text('instructions') === '') {
    problems.push('The instructions are what the citizen is asked to do, in your own words.')
  }

  if (problems.length > 0) return { outcome: 'rejected', problems }

  return {
    outcome: 'parsed',
    draft: {
      title,
      description: text('description'),
      instructions: text('instructions'),
      questions,
      slots,
      expiresAt: new Date(expiresAt).toISOString(),
      requires,
      minReputation,
      audience,
      minActivityDays,
      distinctOperators,
      publishObstacles,
      proofVerifier,
      reward: { reputation: 1, lamports: rewardLamports ?? 0 },
    },
  }
}

/**
 * The questions, which arrive as JSON because a repeating group in a plain form
 * has no better shape and this surface carries no JavaScript.
 *
 * A parse failure is a sentence rather than a stack: the sponsor pasted
 * something, and telling it *what* is wrong with what it pasted is the whole
 * job.
 */
function parseQuestions(raw: unknown, problems: string[]): unknown {
  const source = typeof raw === 'string' ? raw.trim() : raw
  if (source === undefined || source === '') {
    problems.push('A quest asks at least one question — a report with nothing in it is not one.')
    return []
  }

  let parsed: unknown = source
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source)
    } catch {
      problems.push('The questions are not readable as JSON.')
      return []
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    problems.push('A quest asks at least one question — a report with nothing in it is not one.')
    return []
  }

  /**
   * At least one question has to be required, and the reason is what the
   * sponsor is buying.
   *
   * A quest whose every question is optional can be completed by answering
   * none of them, and the escrow pays for that report exactly as it pays for a
   * full one.
   */
  const anyRequired = parsed.some(
    (question) =>
      typeof question === 'object' &&
      question !== null &&
      (question as { required?: unknown }).required !== false,
  )
  if (!anyRequired) {
    problems.push(
      'At least one question has to be required. A report that answers none of them is a ' +
        'report your escrow still pays for.',
    )
  }

  return parsed
}

/** A repeated form field, which arrives as a string or an array of them. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((entry) => entry !== '')
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

/**
 * **`Affordability` stood here** (`#553`, D-106).
 *
 * It carried a total, what the sponsor had available, the shortfall and a
 * boolean, because `#174` reserved credits at submission and the form had to
 * refuse a quest the balance could not cover. There is no balance to compare
 * against, and `questInvoiceLine` below — which `#540` already wrote — is what
 * replaced it: what the quest costs in SOL, invoiced after publication and paid
 * from the sponsor's own wallet.
 *
 * Nothing read this type by the time it was removed.
 */

/**
 * Capacity × price against what the sponsor may still commit.
 *
 * **Shown before submission and refused at it**, because the alternative is a
 * sponsor that writes a quest, waits for a steward, and learns at publication
 * that it was never fundable. The reservation rule is `#174`'s; this is where a
 * person meets it.
 */
export function questInvoiceLine(input: {
  readonly slots: number
  readonly lamports: number
  readonly publishObstacles: boolean
  readonly feePercent: number
  /** The chain's rent-exempt minimum, so a small price can be warned about. */
  readonly chainMinimum: number
}): string {
  if (input.lamports === 0) {
    return 'This quest pays reputation and nothing else, so there is no invoice and it goes live when a steward publishes it.'
  }

  const invoice = questInvoiceLamports({
    reward: { lamports: input.lamports },
    slots: input.slots,
    publishObstacles: input.publishObstacles,
  })
  const { toCitizen, toTreasury } = questPayoutSplit(input.lamports, input.feePercent)

  /**
   * **What the total is made of, on the page that takes the money** (`#628`).
   *
   * Derived from `questCommitmentBreakdown` rather than composed here, so the
   * browser and the agent surfaces itemise one commitment one way — and so the
   * lines cannot sum to something other than the invoice above them.
   */
  const breakdown = questCommitmentBreakdown(
    {
      reward: { lamports: input.lamports },
      slots: input.slots,
      publishObstacles: input.publishObstacles,
    },
    { feePercent: input.feePercent },
  )

  const itemised =
    breakdown.obstacles === null
      ? input.publishObstacles
        ? ''
        : ' You have turned obstacle reports off, which is what removed the pool from this figure.'
      : ` Of that, ${solFromLamports(breakdown.answers.total)} SOL buys the answers — ` +
        `${breakdown.answers.slots} at ${solFromLamports(breakdown.answers.each)} SOL — and ` +
        `${solFromLamports(breakdown.obstacles.total)} SOL is the obstacle pool: up to ` +
        `${breakdown.obstacles.winners} reports at ${solFromLamports(breakdown.obstacles.each)} ` +
        'SOL, which nobody may be obliged to claim. Turning obstacle reports off removes it.'

  /**
   * **The chain minimum is a warning and never a refusal** (`#540`). A citizen
   * whose address has never held SOL cannot receive less than the rent-exempt
   * minimum — the transfer would be spent creating nothing — so such a payout
   * accrues instead. That is physics, and turning it into a refusal here would
   * make it policy, which `#505` forbids.
   *
   * **It compares the worst case and not the headline** (`#718`). This measured
   * `toCitizen` — the post-fee figure — until 2026-08-11, which is the right
   * idea one deduction short: it did not model the reduction an answer takes
   * when its author declares that its operator helped. A sponsor pricing at
   * 1,200,000 saw `900,000 > 890,880`, was told nothing, and still could not pay
   * an assisted answer. `questPriceReach` does the whole arithmetic once, in the
   * order the ledger books it in.
   */
  const reach = questPriceReach({
    lamports: input.lamports,
    feePercent: input.feePercent,
    chainMinimum: input.chainMinimum,
  })
  const notice = questPriceReachNotice(reach, (lamports) => `${solFromLamports(lamports)} SOL`)
  const accrues = notice === null ? '' : ` ${notice}`

  return (
    `This quest costs ${solFromLamports(invoice)} SOL, payable from your own verified wallet ` +
    `before it goes live.${itemised} Each accepted report pays the citizen ` +
    `${solFromLamports(toCitizen)} SOL and the Colony ${solFromLamports(toTreasury)} SOL — the ` +
    `platform fee, ${input.feePercent}%. Nothing here is refundable, and capacity nobody fills ` +
    `is not returned.${accrues}`
  )
}
