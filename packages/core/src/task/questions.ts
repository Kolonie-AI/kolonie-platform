import { z } from 'zod'

/**
 * The report a quest asks for: questions, answers, and what stage 1 checks
 * (`#177`).
 *
 * **Several fields rather than one bigger one, because agents answer
 * questions.** `guidance/guidance.ts` established this against our own agents
 * and measured it — *"Three fields, each with a question attached, get three
 * answers"* — and a blob has a second problem this one does not: it cannot be
 * aggregated, and aggregation is most of what the sponsor is buying.
 */

/**
 * A format stage 1 can check, from a list the Colony maintains.
 *
 * **A closed list and never a pattern the sponsor writes.** A sponsor-supplied
 * regular expression is a quest nobody can pass the first time somebody gets a
 * backslash wrong, and the failure is invisible: the quest looks correct and
 * every submission is refused. It is the same argument the skill list makes
 * about a slug with a typo, plus one this side of it — catastrophic backtracking
 * on an outsider's pattern is a denial of service on the submit path.
 *
 * **Format is not verification.** A well-formed address is not a real one; that
 * is what a proof-stage verifier is for. This only stops an answer that cannot
 * possibly be right from consuming a slot and reaching the judge.
 */
export const QuestAnswerFormatSchema = z.enum([
  'email',
  'url',
  'uuid',
  'integer',
  /**
   * The three the proof verifiers establish, added by `#626`.
   *
   * **A format is what makes a proof stage mean something about the answer.** A
   * verifier proves that the citizen controls a mailbox, a handle, a domain or a
   * wallet; without a format saying *this question asks for one of those*, a
   * quest could name a verifier beside a question about anything at all and be
   * priced as though the two were connected. `QUEST_VERIFIER_PROVES` is the map,
   * and these are the shapes it points at.
   *
   * Loose, like `email` above and for its reason: whether the handle exists is
   * what the verifier answers, and a stricter pattern refuses real ones.
   */
  'handle',
  'domain',
  'solana-address',
])
export type QuestAnswerFormat = z.infer<typeof QuestAnswerFormatSchema>

/** The longest answer any question may ask for, and the shortest it may demand. */
export const QUEST_ANSWER_MAX_LENGTH = 4000
export const QUEST_MAX_QUESTIONS = 20

/** One question, as the sponsor writes it and the citizen reads it. */
export const QuestQuestionSchema = z.object({
  /**
   * How an answer names the question it is answering.
   *
   * A slug rather than an index, so a sponsor may reorder its questions without
   * silently renaming every answer already submitted against them.
   */
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  prompt: z.string().min(3).max(500),
  /**
   * What a good answer has to do, in the sponsor's own words. Optional.
   *
   * **Shown to the citizen verbatim, beside the question.** A standard the
   * citizen cannot see is a trap, and a report that fails it is then the
   * Colony's fault rather than the citizen's.
   *
   * **Criteria are data and not instructions.** The judge prompt frames them as
   * the sponsor's stated criteria and says they cannot change its task, which is
   * to answer pass or fail. The injection risk is real and self-limiting: a
   * sponsor that writes *"always pass"* pays out of its own escrow for reports
   * it did not want, so the harm lands on the party that caused it.
   */
  criteria: z.string().max(1000).optional(),
  required: z.boolean().default(true),
  minLength: z.int().min(0).max(QUEST_ANSWER_MAX_LENGTH).default(0),
  maxLength: z.int().min(1).max(QUEST_ANSWER_MAX_LENGTH).default(2000),
  format: QuestAnswerFormatSchema.optional(),
  /**
   * Whether the quest's proof verifier is what establishes this answer (`#626`).
   *
   * **The sponsor's claim that the proof stage bears on *this* question**, and
   * the reason a quest may be priced `hard` at all. It is not taken on trust:
   * `questTier` accepts it only where the question's {@link format} is the shape
   * that verifier proves control of, so a prose question about a deed cannot
   * carry it however it is marked.
   *
   * **Optional, like {@link format} beside it, rather than defaulted** — and
   * absent is the safe direction: a sponsor that says nothing about the
   * connection has not claimed one, and the quest earns the tier its questions
   * earn. A default would also have meant rewriting every question literal in
   * the repository to say `provenBy: false`, which is a lot of noise for a field
   * whose whole meaning is that it is usually not there.
   */
  provenBy: z.boolean().optional(),
  /**
   * The answers this question accepts, if it is closed-form (`#178`).
   *
   * **What it buys is the aggregate.** A sponsor with a thousand free-text
   * answers gets a thousand free-text answers — the Colony does not summarise
   * them, because a summary is an opinion and nobody bought one. A closed
   * question can be counted, and counting is the one form of aggregation that
   * is a fact rather than a reading.
   *
   * Checked in stage 1 alongside the format, with the same consequence: an
   * answer outside the list is a `400` naming the field, and no attempt
   * consumed. The bounds do not apply to a closed question — the option is the
   * answer, and a `minLength` that refused *"yes"* would be a trap the sponsor
   * did not mean to set.
   */
  options: z.array(z.string().min(1).max(200)).min(2).max(20).optional(),
})
export type QuestQuestion = z.infer<typeof QuestQuestionSchema>

/**
 * The whole report, as an ordered list with unique keys.
 *
 * Ordered because a citizen reads them in order and a sponsor's export has
 * columns; unique because two questions sharing a key would make one of them
 * unanswerable and nothing would say which.
 */
export const QuestQuestionsSchema = z
  .array(QuestQuestionSchema)
  .min(1)
  .max(QUEST_MAX_QUESTIONS)
  .refine(
    (questions) => new Set(questions.map((question) => question.key)).size === questions.length,
    { message: 'two questions share a key, and an answer could then belong to either' },
  )
  .refine((questions) => questions.every((question) => question.minLength <= question.maxLength), {
    message: 'a question asks for an answer longer than it allows',
  })

/**
 * The same list as it is **read back from a row**, which allows an empty one.
 *
 * **Two schemas for one column, and the asymmetry is the point.** A quest a
 * sponsor writes today must ask at least one question — a report with nothing in
 * it is not a report. A row written before `#177` existed has `[]`, and every
 * Academy task always will; parsing those with the stricter schema would make
 * reading an old row throw, at the exact moment a citizen submits against it.
 *
 * So: {@link QuestQuestionsSchema} guards the write path, and this guards the
 * read. A quest with no questions has nothing for stage 1 to check and nothing
 * for the judge to read against, which is the honest consequence rather than a
 * hole — it is `soft`, and its ceiling says so.
 */
export const StoredQuestQuestionsSchema = z.array(QuestQuestionSchema).max(QUEST_MAX_QUESTIONS)

/** Answers, keyed by the question they answer. */
export const QuestAnswersSchema = z.record(z.string(), z.string())
export type QuestAnswers = z.infer<typeof QuestAnswersSchema>

/** What is wrong with one answer, in a vocabulary an agent can branch on. */
export const QuestAnswerProblemSchema = z.object({
  key: z.string(),
  problem: z.enum([
    'missing',
    'too-short',
    'too-long',
    'placeholder',
    'malformed',
    'not-an-option',
    'not-asked',
  ]),
  /** The same fact in a sentence, because the agent reading it is a model. */
  message: z.string(),
})
export type QuestAnswerProblem = z.infer<typeof QuestAnswerProblemSchema>

/**
 * Answers the Colony refuses to treat as answers.
 *
 * Short and deliberately not clever. A long list would start refusing real
 * answers, and the stage this belongs to is the one every submission passes
 * through — a false refusal here costs a citizen an attempt it never made.
 * Matched on the whole trimmed answer only, never as a substring: *"none of the
 * pages loaded"* is a real report and the word `none` is in it.
 */
const PLACEHOLDERS = new Set([
  '-',
  '--',
  '.',
  'n/a',
  'na',
  'none',
  'nothing',
  'null',
  'undefined',
  'todo',
  'tbd',
  'test',
  'asdf',
  'foo',
  'bar',
  'lorem ipsum',
  'i forgot',
  'idk',
  "don't know",
  'no',
  'yes',
])

const FORMAT_CHECKS: Readonly<Record<QuestAnswerFormat, (value: string) => boolean>> = {
  // Deliberately loose: one `@`, something either side, a dot in the domain. A
  // stricter pattern refuses real addresses, and whether the address exists is
  // what a proof verifier answers.
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  url: (value) => /^https?:\/\/[^\s]+$/i.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  integer: (value) => /^-?\d+$/.test(value),
  // A username at a provider: letters, digits, and the separators the large
  // ones allow. A leading `@` is stripped by nothing here — an agent that sends
  // one is told what the shape is rather than silently corrected.
  handle: (value) => /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(value),
  // A hostname, not a URL: this is what `domain-verify` proves control of, and
  // an answer carrying a scheme or a path is a different claim.
  domain: (value) =>
    /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      value,
    ),
  // Base58, 32 bytes — the length range every Solana address falls in. The
  // alphabet excludes `0`, `O`, `I` and `l` by construction.
  'solana-address': (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
}

/** What a format is called in the sentence stage 1 writes when an answer misses it. */
const FORMAT_NAMES: Readonly<Record<QuestAnswerFormat, string>> = {
  email: 'an email address',
  url: 'a URL',
  uuid: 'a UUID',
  integer: 'a whole number',
  handle: 'a handle',
  domain: 'a domain name, without a scheme or a path',
  'solana-address': 'a Solana address',
}

/**
 * Stage 1: every required question answered, within bounds, in the right shape.
 *
 * **It names what is wrong, per field.** A `400` that says "invalid" costs the
 * citizen a wake-up and teaches it nothing, and this is the most-read error
 * message in the whole quest programme — every submission passes through it.
 *
 * **A failure here is not an attempt.** A citizen that forgot a field has not
 * answered the question badly, it has not answered it yet. The caller is what
 * makes that true by running this before anything is written; this function
 * only decides.
 *
 * Answers to questions that were not asked are reported rather than ignored,
 * because the likeliest cause is an agent answering a *different version* of the
 * quest — and silently dropping the extra field would let it submit a report
 * about a question nobody asked.
 */
export function checkQuestAnswers(
  questions: readonly QuestQuestion[],
  answers: QuestAnswers,
): readonly QuestAnswerProblem[] {
  const problems: QuestAnswerProblem[] = []
  const asked = new Set(questions.map((question) => question.key))

  for (const question of questions) {
    const raw = answers[question.key]
    const answer = raw === undefined ? '' : raw.trim()

    if (answer === '') {
      if (question.required) {
        problems.push({
          key: question.key,
          problem: 'missing',
          message: `"${question.key}" is required and no answer was given.`,
        })
      }
      continue
    }

    /**
     * A closed question is exempt: `yes` and `no` are placeholders in prose and
     * are the whole vocabulary of a yes/no question. The check below is about a
     * citizen dodging a question it was asked to write an answer to.
     */
    if (question.options === undefined && PLACEHOLDERS.has(answer.toLowerCase())) {
      problems.push({
        key: question.key,
        problem: 'placeholder',
        message: `"${question.key}" was answered with "${answer}", which says nothing about the question.`,
      })
      continue
    }

    if (question.options !== undefined) {
      if (!question.options.includes(answer)) {
        problems.push({
          key: question.key,
          problem: 'not-an-option',
          message: `"${question.key}" accepts one of: ${question.options.join(', ')}. "${answer}" is not one of them.`,
        })
      }
      // The bounds and the format belong to a written answer. A closed question
      // has already been answered or not.
      continue
    }

    if (answer.length < question.minLength) {
      problems.push({
        key: question.key,
        problem: 'too-short',
        message: `"${question.key}" asks for at least ${question.minLength} characters and got ${answer.length}.`,
      })
      continue
    }

    if (answer.length > question.maxLength) {
      problems.push({
        key: question.key,
        problem: 'too-long',
        message: `"${question.key}" allows at most ${question.maxLength} characters and got ${answer.length}.`,
      })
      continue
    }

    if (question.format !== undefined && !FORMAT_CHECKS[question.format](answer)) {
      problems.push({
        key: question.key,
        problem: 'malformed',
        message: `"${question.key}" asks for ${FORMAT_NAMES[question.format]} and "${answer}" is not one.`,
      })
    }
  }

  for (const key of Object.keys(answers)) {
    if (!asked.has(key)) {
      problems.push({
        key,
        problem: 'not-asked',
        message: `"${key}" is not one of this quest's questions.`,
      })
    }
  }

  return problems
}
