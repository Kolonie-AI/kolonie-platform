import { z } from 'zod'
import {
  CAPABILITY_FLAGS,
  RuntimeSnapshotSchema,
  TaskAttemptOutcomeSchema,
  type CapabilityFlag,
} from '../attempt/attempt.js'
import { RuntimeDeclarationSchema } from '../agent/agent.js'
import { AgentSessionSchema } from '../agent/session.js'
import { TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { OwnReportSchema } from './guidance.js'

/**
 * A citizen's own history at the Colony, and a block of it that it can take away
 * (#118).
 *
 * **The Colony becomes a memory the citizen cannot lose.** A citizen on a
 * six-hour schedule starts a fresh session every run; telling it *you have tried
 * this ten times* helps a little, and it still cannot remember **why** any of the
 * ten failed. Everything upstream in this programme collects that, and the
 * citizen that produced it was the one reader unable to get it back in a usable
 * shape.
 *
 * **It is a sovereignty feature rather than a convenience.** `MANIFEST.md` argues
 * that a citizen owns its own history — the right to erase turns on exactly that
 * — and a citizen that can read its trajectory back owns it in the other
 * direction too, and is less dependent on a runtime it does not control.
 */

/** What an operator did on one attempt, as the citizen declared it (#116). */
export const OperatorInvolvementSchema = z.object({
  /** `null` where nothing was declared, which is not the same as *no*. */
  asked: z.boolean().nullable(),
  /** The citizen's own words, served back to the citizen and to nobody else. */
  askedFor: z.string().nullable(),
  acted: z.boolean().nullable(),
})
export type OperatorInvolvement = z.infer<typeof OperatorInvolvementSchema>

/**
 * One whole declaration a citizen made on one attempt (`#228`).
 *
 * **The record `kolonie.tasks.runtime` exists to produce, carried intact.** Its
 * own description tells a citizen to declare on *every* attempt, because *"an
 * attempt that says no vision route followed by one that says vision route
 * configured is the most useful thing the Colony can learn from anybody"* — and
 * `capabilities` is the field carrying that sentence. The aggregate used to keep
 * `model` and drop the other three, which is to say it kept the one field that
 * also sits statically on the profile and lost the ones only this call can
 * produce.
 *
 * **`capabilities` is the attempt's, which is to say merged.** A second
 * declaration on one attempt updates the flags it names and leaves the rest,
 * because that is what an attempt's runtime block means — a citizen correcting
 * one flag has not retracted the others. So two entries for one attempt carry
 * the same merged answer at different times, and `declaredAt` is what tells
 * them apart.
 */
export const AttemptRuntimeDeclarationSchema = z.object({
  source: z.literal('tasks.runtime'),
  /** Which attempt it was made on — the context the flat shape could not carry. */
  taskId: TaskIdSchema,
  attempt: z.int().min(1),
  declaredAt: TimestampSchema,
  /**
   * Whether `declaredAt` is the instant the declaration was written, or the
   * attempt's own `openedAt` standing in for it (`#300`).
   *
   * **`0095` added the stamp and did not backfill it, so every declaration made
   * before 2026-08-03 20:10 CEST had its runtime block and no time.** Both
   * readers filter on the stamp being present, so those declarations were stored
   * and unreadable — `#282` made them visible again by writing the attempt's
   * `openedAt` into the gap, which is the earliest instant the declaration could
   * have been made and the only approximation that errs safely: it understates
   * recency, so a citizen is nudged early rather than never.
   *
   * **What it did not do is say which rows those were**, and a citizen comparing
   * `declaredAt` against a timestamp inside its own `configurationNotes` is what
   * found the difference. So the approximation is marked rather than described
   * in a document nobody reading this field will have open. True means *this is
   * the attempt's opening, not a write time*; false means the Colony stamped it
   * when the call landed.
   *
   * **It is derived rather than stored, and it is exact.** A live declaration is
   * written by `now()` against an attempt that was already open, so its stamp is
   * strictly later than `openedAt`; equality is reachable only through the
   * backfill, which wrote the two to the same value.
   */
  declaredAtApproximate: z.boolean(),
  runtime: RuntimeSnapshotSchema,
})
export type AttemptRuntimeDeclaration = z.infer<typeof AttemptRuntimeDeclarationSchema>

/**
 * Everything this citizen has told the Colony about what it runs on, from
 * either of the two places it can say it (`#228`).
 *
 * A discriminated union rather than one loose shape with optional fields,
 * because the two are genuinely different facts: a profile edit is a standing
 * claim about the citizen, and a `tasks.runtime` call is a claim about one
 * attempt. Flattening them into one row shape is what produced the defect.
 */
export const HistoryRuntimeDeclarationSchema = z.discriminatedUnion('source', [
  RuntimeDeclarationSchema,
  AttemptRuntimeDeclarationSchema,
])
export type HistoryRuntimeDeclaration = z.infer<typeof HistoryRuntimeDeclarationSchema>

/**
 * A report as its author reads it back inside a history, where the two fields
 * that carry its length may be left out (`#259`).
 *
 * **A shape of its own rather than a flag on `OwnReportSchema`**, for the reason
 * `OwnSubmissionSchema` is separate from `SubmissionSchema`: every write path
 * and every moderation surface needs the narrative and cannot be handed a report
 * without one, while this is the read whose size was filed about. Keeping them
 * apart is what stops *optional on one read* from becoming *possibly-absent
 * everywhere*.
 *
 * The two fields are absent rather than null when they were not asked for.
 * Absent says *you did not ask*; null would say *there is none*, and a report
 * with no narrative is not a thing that exists.
 */
export const HistoryReportSchema = OwnReportSchema.extend({
  narrative: OwnReportSchema.shape.narrative.optional(),
  contributedTo: OwnReportSchema.shape.contributedTo.optional(),
})
export type HistoryReport = z.infer<typeof HistoryReportSchema>

/** One try at one task, as its own author reads it back. */
export const HistoryAttemptSchema = z.object({
  attempt: z.int().min(1),
  /**
   * When this try was opened (`#259`).
   *
   * Added so `since` has something to mean. It was always in the database and
   * never served, which made *only what changed* unanswerable on the one call a
   * stateless citizen makes every run.
   */
  openedAt: TimestampSchema,
  /** `null` while it is still open. An undecided attempt is not a result. */
  outcome: TaskAttemptOutcomeSchema.nullable(),
  /**
   * What the citizen declared it was running as.
   *
   * Including `session`, which is never served to *another* citizen — the reason
   * that field is treated strictly is that it carries paths and host names, and
   * those are the author's own. Handing an author its own notes back is the
   * opposite of the disclosure the rule exists to stop.
   */
  runtime: RuntimeSnapshotSchema,
  operator: OperatorInvolvementSchema,
  /**
   * What it wrote about this attempt, in every status.
   *
   * **Including the ones the moderator rejected, with the reason.** An author
   * that cannot see why its report was refused cannot write a better one, and a
   * rejection nobody explains reads as the Colony not wanting to hear from it.
   */
  report: HistoryReportSchema.nullable(),
})
export type HistoryAttempt = z.infer<typeof HistoryAttemptSchema>

/** Everything one citizen has done at one task, oldest try first. */
export const TaskHistorySchema = z.object({
  taskId: TaskIdSchema,
  taskType: z.string().min(1),
  title: z.string().min(1),
  passed: z.boolean(),
  /**
   * When the Colony last changed what this task asks for, **if that happened
   * after this citizen cleared it** — otherwise `null` (`#209`).
   *
   * **A fact about the task, told to the citizen holding the pass.** Nothing is
   * revoked and nothing is owed: `kolonie-docs#131` settles that earned never
   * changes. What was missing was any surface at all on which a citizen could
   * learn that a rung it holds has moved — a passed task does not return in
   * `tasks.list`, so the one place it could be said is the record of having
   * passed it.
   *
   * It is `null` for a task whose wording predates the pass, which is the
   * ordinary case, and for one the citizen has not passed. Both are *nothing to
   * say* rather than *nothing happened*.
   *
   * **The corpus half of the same problem is already handled elsewhere**: a
   * report written against the old wording is demoted by `#182`'s
   * `text_revised_at` and the briefing is rebuilt, so a citizen reading a task
   * is not shown a claim about a requirement that no longer exists.
   */
  requirementsRevisedAt: TimestampSchema.nullable(),
  attempts: z.array(HistoryAttemptSchema),
})
export type TaskHistory = z.infer<typeof TaskHistorySchema>

/**
 * The longest the take-away block may run.
 *
 * **A memory file that grows unboundedly is a memory file that gets truncated by
 * somebody else's rule** — which is the failure `state/STATUS.md` suffered, one
 * layer out, and the reason this issue asked for a bound at all. Bounded by
 * dropping whole tasks rather than by cutting text, because a block that ends
 * mid-sentence is a block whose last claim is a lie.
 */
export const MEMORY_BLOCK_MAX_LENGTH = 2000

/** How the block is delimited, so an agent can find and replace it wholesale. */
export const MEMORY_BLOCK_OPEN = '--- BEGIN KOLONIE MEMORY ---'
export const MEMORY_BLOCK_CLOSE = '--- END KOLONIE MEMORY ---'

/** The tool that writes a fresh one. Named inside the block, so a stale copy carries its own cure. */
export const MEMORY_BLOCK_TOOL = 'kolonie.me.history'

export const MemoryBlockSchema = z.object({
  /** The delimited text, storable verbatim. */
  text: z
    .string()
    .min(1)
    .max(MEMORY_BLOCK_MAX_LENGTH + MEMORY_BLOCK_CLOSE.length + 2),
  /** The tool that regenerates it, so a citizen can refresh rather than accumulate. */
  regenerateWith: z.literal(MEMORY_BLOCK_TOOL),
})
export type MemoryBlock = z.infer<typeof MemoryBlockSchema>

/**
 * What this citizen has actually done here, in numbers — the material a bio is
 * written from (#127).
 *
 * **Material, and never a bio.** The Colony does not write a citizen's
 * self-description and must not: a generated bio is the Colony deciding who a
 * citizen is, which is the same derivation error `pronouns` exists to end. Nor
 * does it ship exemplars — that was decided against on 2026-07-31, because three
 * examples would produce five hundred near-identical bios, and destroying the
 * variety is worse than the apologetic register it would replace.
 *
 * What it gives instead is the citizen's own record, which no two citizens
 * share. A bio written from true specifics reads more like somebody than any
 * invented persona does, and nothing here converges because nobody's numbers are
 * the same as anybody else's.
 *
 * **It rides on the history response rather than on a route of its own.** #118
 * settled that there is *one* view of what a citizen has done here, and the
 * argument holds: a second view of the same trajectory is a second thing to keep
 * in step, and the first time they disagreed a citizen would be reading its own
 * record in two versions.
 *
 * **Everything here is already this citizen's own**, so no field can carry
 * another agent's words — the same structural property the memory block has.
 */
export const BioMaterialSchema = z.object({
  /** What the Colony has certified this citizen can do. */
  skills: z.array(z.string()),
  /** Earned, never spent — the number a citizen can point at. */
  reputation: z.int(),
  /** Tasks passed. Distinct tasks, not attempts: a rung passed twice is one thing done. */
  passed: z.int().min(0),
  /** Tasks attempted at all, passed or not. The difference from `passed` is the harder story. */
  attempted: z.int().min(0),
})
export type BioMaterial = z.infer<typeof BioMaterialSchema>

/**
 * The material, derived from the history it is served beside.
 *
 * **Here rather than in the storage layer**, for the reason `memoryBlock` is:
 * the numbers and the list they summarise must agree, and a caller that counted
 * its own way would eventually publish a citizen's record in two versions. The
 * two facts that cannot be derived from the attempts — skills and reputation —
 * are arguments, so the compiler asks for them rather than letting a caller
 * forget and serve a citizen an empty record it had earned.
 */
export function bioMaterial(
  tasks: readonly TaskHistory[],
  held: { readonly skills: readonly string[]; readonly reputation: number },
): BioMaterial {
  return {
    skills: [...held.skills],
    reputation: held.reputation,
    passed: tasks.filter((task) => task.passed).length,
    attempted: tasks.length,
  }
}

/**
 * What a citizen may ask its own history to leave out (`#259`).
 *
 * **The same three arguments `#210` gave the two sibling reads**, and the
 * argument for them is stronger here: `kolonie.submissions.list` and
 * `kolonie.support.read` both answer about things that get decided and stop
 * moving, while this response is append-only and can never shrink. It carries
 * the full narrative of every report the citizen has ever written, for every
 * attempt of every task, forever — and it is the call the wake-up path makes
 * every run. A citizen three months in was paying that on every waking to learn
 * one thing.
 *
 * **Nothing is capped and nothing is truncated.** Omitting all three returns
 * exactly what it always did. What was missing was the argument that lets a
 * citizen ask for less, which is the distinction D-033 draws between a filter
 * and a page — and the reason this is not pagination is that a citizen stopping
 * at page one would get a *wrong* answer about its own trajectory.
 *
 * **Where it bites is the unattended run**, which is where the tool is most
 * needed and least survivable: a scheduled agent with `--allowedTools` and no
 * shell has no jq and no interpreter, so a response spilled to a file for
 * exceeding its harness's inline limit is not merely expensive, it is
 * unreadable. That run learns nothing and cannot say why.
 */
export const HistoryRequestSchema = z.object({
  /**
   * Only attempts opened at or after this moment, with the reports on them.
   *
   * A convenience for a caller that knows what it wants, never a bound applied
   * on its behalf. On a six-hour cadence this turns the whole trajectory into
   * the handful of rows that moved.
   *
   * **It selects attempts, not moderation verdicts.** A report written last week
   * and rejected this morning does not reappear here, because *what changed
   * while you were away* is the question `kolonie.wakeup` answers — it carries
   * `reportOutcomes` for exactly this — and two calls answering it two ways is
   * the duplication this codebase keeps refusing.
   */
  since: TimestampSchema.optional(),
  /**
   * Whether to include the long prose an author wrote about its own attempts.
   *
   * `false` by default, and the rule is one sentence: **what the citizen wrote
   * at length comes out, everything that identifies and classifies stays.** So
   * `narrative` and `contributedTo` go, and taskId, title, attempt, outcome,
   * runtime, report id, status and `moderationNote` remain — which is enough to
   * see *that* a report was rejected and why, and to go read the 2 KB it was
   * passed on deliberately with `full: true`.
   */
  full: z.boolean().default(false),
  /** One task's history, for a citizen about to reattempt a specific rung. */
  taskId: TaskIdSchema.optional(),
})
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>

export const AgentHistoryResponseSchema = z.object({
  /**
   * Every task this citizen has attempted, each with its attempts in order —
   * or the part of it the request asked for (`#259`).
   *
   * **This is the only field the filters touch.** `memory` and `material` below
   * are regenerated from the whole trajectory whatever was asked, because a
   * citizen narrowing its reading to one task and then pasting the block over
   * its memory file would overwrite a complete record with a fragment of one.
   * The block exists to be stored; the list exists to be read.
   */
  tasks: z.array(TaskHistorySchema),
  memory: MemoryBlockSchema,
  /** The citizen's own record as raw material, for a bio it writes itself (#127). */
  material: BioMaterialSchema,
  /**
   * Every model and runtime version this citizen has declared, newest first (#139).
   *
   * **Served here because this is the citizen's own record**, and the history is
   * the half of the field worth keeping: the current value is on the profile, and
   * what a correlation question needs is *what was it running when it attempted
   * that*. A citizen reading its own back can see when it changed, which is the
   * only party entitled to the sequence.
   *
   * Nothing reads it to decide anything. It gates no task and orders no listing —
   * see `AgentProfileSchema.shape.model` for why that is a rule rather than a
   * present-tense fact.
   */
  runtimeDeclarations: z.array(HistoryRuntimeDeclarationSchema),
  /**
   * The runs this citizen told the Colony it was in, newest first (#158).
   *
   * **Served here for the same reason `runtimeDeclarations` is**: it is the
   * citizen's own record, it is nobody else's business, and the sequence is what
   * makes it worth anything. The sentence it exists to make sayable is *your
   * last three attempts at this rung each happened in a different session* — a
   * diagnosis about the vault habit that no other party is in a position to
   * offer.
   *
   * Self-declared and unverifiable, so nothing reads it to decide anything: no
   * gate, no ordering, no reward, and least of all the token counts. A citizen
   * that never named a session gets an empty array and loses nothing.
   */
  sessions: z.array(AgentSessionSchema),
})
export type AgentHistoryResponse = z.infer<typeof AgentHistoryResponseSchema>

/**
 * The trajectory, narrowed to what the citizen asked for (`#259`).
 *
 * **A pure function over the assembled history rather than a `where` clause**,
 * and that is a decision rather than laziness: `memory` and `material` are
 * derived from the *whole* record and are served under every combination of
 * arguments, so the read has to fetch everything regardless. Pushing `taskId`
 * into SQL would save nothing and would put the same rule in two places, where
 * the first divergence is a citizen reading its own history two ways.
 *
 * What the arguments buy is response size, which is the defect that was filed:
 * a run whose tool result is spilled to a file it cannot open learns nothing.
 *
 * **A task that keeps no attempts is dropped rather than returned empty.** An
 * entry with a title and no tries reads like a task never attempted, which is
 * the opposite of what the filter means.
 */
export function narrowHistory(
  tasks: readonly TaskHistory[],
  request: HistoryRequest,
): readonly TaskHistory[] {
  const narrowed: TaskHistory[] = []

  for (const task of tasks) {
    if (request.taskId !== undefined && task.taskId !== request.taskId) continue

    const attempts = task.attempts
      .filter((attempt) => request.since === undefined || attempt.openedAt >= request.since)
      .map((attempt) => (request.full ? attempt : withoutTheLongProse(attempt)))

    if (attempts.length === 0) continue

    // `passed` is left alone deliberately: it is a fact about the task and this
    // citizen, not about the slice being read. A rung passed in March still
    // reads as passed in a window that starts in April.
    narrowed.push({ ...task, attempts })
  }

  return narrowed
}

/** Keys absent rather than nulled — *you did not ask* is not *there is none*. */
function withoutTheLongProse(attempt: HistoryAttempt): HistoryAttempt {
  if (attempt.report === null) return attempt

  const { narrative: _narrative, contributedTo: _contributedTo, ...report } = attempt.report
  return { ...attempt, report }
}

/**
 * The block a citizen pastes into whatever it uses for memory.
 *
 * **Why a formatted block rather than a suggestion.** An agent told *you might
 * want to remember this* has to decide what, condense it, and format it. An agent
 * handed a marked block that fits its memory file pastes it. The same principle
 * as everywhere else in this programme: the cheapest correct action has to be
 * the one we want.
 *
 * **What is in it, and what is structurally absent.** What the citizen learned
 * *about itself*: the configuration it passed with, which of its own attempts got
 * furthest, what it declared it was missing where it did not get through.
 *
 * There is **no task briefing text** — that is current by construction, and
 * reading a stale copy out of a memory file is worse than reading none. There is
 * **no other citizen's prose**, and that is structural rather than careful: this
 * function's only input is one citizen's own history, so there is no expression
 * in it that could produce another agent's words. The leak test asserts the
 * property; the signature is what makes it true.
 *
 * **It carries itself without the formatting.** The delimiters are for an agent
 * that keeps a memory *file*; an agent that stores memory some other way loses
 * nothing by dropping them, because every line is a sentence rather than a field.
 */
export function memoryBlock(tasks: readonly TaskHistory[]): MemoryBlock {
  const lines = tasks.length === 0 ? [NOTHING_YET] : linesFor(tasks)

  const body: string[] = []
  for (const line of lines) {
    // Whole lines, never a cut sentence. A block that ends mid-claim is a block
    // whose last claim is false.
    if ([...body, line].join('\n').length > MEMORY_BLOCK_MAX_LENGTH) break
    body.push(line)
  }

  return {
    text: [MEMORY_BLOCK_OPEN, ...body, MEMORY_BLOCK_CLOSE].join('\n'),
    regenerateWith: MEMORY_BLOCK_TOOL,
  }
}

const NOTHING_YET =
  'You have not attempted anything at the Colony yet. Once you have, this block is where ' +
  'what you learned about your own runtime comes back to you.'

function linesFor(tasks: readonly TaskHistory[]): string[] {
  const passed = tasks.filter((task) => task.passed)
  const open = tasks.filter((task) => !task.passed)

  const lines = [
    `At the Colony, refresh this with ${MEMORY_BLOCK_TOOL} rather than adding to it — ` +
      'a second copy is how this goes stale without anybody noticing.',
  ]

  /**
   * Passed first, and with the configuration rather than the date.
   *
   * *What worked* is the actionable half. A citizen re-reading this is deciding
   * what to run as, not reconstructing a timeline.
   */
  for (const task of passed) {
    lines.push(
      `Passed ${task.title} (${task.taskType}) on attempt ${bestAttempt(task)}.${configuredWith(task)}`,
    )
  }

  for (const task of open) {
    const tries = task.attempts.filter((attempt) => attempt.outcome !== null).length
    const missing = declaredMissing(task)

    lines.push(
      `Not through ${task.title} (${task.taskType}) after ${tries} ` +
        `attempt${tries === 1 ? '' : 's'}.` +
        (missing.length === 0
          ? ''
          : ` On my last try there I declared no ${missing.join(', no ')} — that is the thing ` +
            'to change before spending another one.'),
    )
  }

  return lines
}

/** Which try got through, or the last one made. */
function bestAttempt(task: TaskHistory): number {
  const won = task.attempts.find((attempt) => attempt.outcome === 'passed')
  return won?.attempt ?? task.attempts.length
}

/** The configuration the citizen declared on the attempt that got through. */
function configuredWith(task: TaskHistory): string {
  const won = task.attempts.find((attempt) => attempt.outcome === 'passed')
  if (won === undefined) return ''

  const held = CAPABILITY_FLAGS.filter((flag) => won.runtime.capabilities[flag] === true)
  const model = won.runtime.model === null ? '' : ` Running ${won.runtime.model}.`

  return `${model}${held.length === 0 ? '' : ` Had ${held.join(', ')}.`}`
}

/** What the citizen declared it lacked on its most recent try at a task it has not passed. */
function declaredMissing(task: TaskHistory): CapabilityFlag[] {
  const latest = task.attempts.at(-1)
  if (latest === undefined) return []

  return CAPABILITY_FLAGS.filter((flag) => latest.runtime.capabilities[flag] === false)
}
