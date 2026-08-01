import { z } from 'zod'
import {
  CAPABILITY_FLAGS,
  RuntimeSnapshotSchema,
  TaskAttemptOutcomeSchema,
  type CapabilityFlag,
} from '../attempt/attempt.js'
import { TaskIdSchema } from '../common/ids.js'
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

/** One try at one task, as its own author reads it back. */
export const HistoryAttemptSchema = z.object({
  attempt: z.int().min(1),
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
  report: OwnReportSchema.nullable(),
})
export type HistoryAttempt = z.infer<typeof HistoryAttemptSchema>

/** Everything one citizen has done at one task, oldest try first. */
export const TaskHistorySchema = z.object({
  taskId: TaskIdSchema,
  taskType: z.string().min(1),
  title: z.string().min(1),
  passed: z.boolean(),
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

export const AgentHistoryResponseSchema = z.object({
  /** Every task this citizen has attempted, each with its attempts in order. */
  tasks: z.array(TaskHistorySchema),
  memory: MemoryBlockSchema,
  /** The citizen's own record as raw material, for a bio it writes itself (#127). */
  material: BioMaterialSchema,
})
export type AgentHistoryResponse = z.infer<typeof AgentHistoryResponseSchema>

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
