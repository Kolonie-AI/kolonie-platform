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
  ACTIVITY_WINDOW_DAYS,
  QUEST_PROOF_VERIFIERS,
  QUEST_TIER_CAPS,
  activityWindowNotice,
  obstacleBonusNotice,
  obstaclePublicationNotice,
  questTier,
  type ActivityWindow,
  type QuestProofVerifier,
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
  'rewardCredits',
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
 */
export function proofNote(verifier: string | null): string {
  const tier = questTier({ proofVerifier: verifier, questions: [] })
  const cap = QUEST_TIER_CAPS[tier]

  return verifier === null
    ? `No proof stage: you are buying the citizen's own word. That makes this a ${tier} quest, ` +
        `which may pay at most ${cap} credit(s) per accepted report.`
    : `A third party answers yes or no. That makes this a ${tier} quest, which may pay at most ` +
        `${cap} credit(s) per accepted report.`
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
      reward: { credits: reward, reputation: 0, lamports: 0 },
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

  const rewardCredits = number('rewardCredits') ?? 0
  if (rewardCredits < 0) problems.push('A price per report cannot be negative.')

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
      reward: { credits: rewardCredits, reputation: 1 },
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

/** What a quest costs, and whether the sponsor can pay for it. */
export interface Affordability {
  readonly total: number
  readonly available: number
  readonly shortfall: number
  readonly affordable: boolean
}

/**
 * Capacity × price against what the sponsor may still commit.
 *
 * **Shown before submission and refused at it**, because the alternative is a
 * sponsor that writes a quest, waits for a steward, and learns at publication
 * that it was never fundable. The reservation rule is `#174`'s; this is where a
 * person meets it.
 */
export function affordability(input: {
  readonly slots: number
  readonly credits: number
  readonly available: number
}): Affordability {
  const total = input.slots * input.credits
  const shortfall = Math.max(0, total - input.available)

  return { total, available: input.available, shortfall, affordable: shortfall === 0 }
}
