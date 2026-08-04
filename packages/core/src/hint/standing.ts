import { DEFAULT_RHYTHM_BOUNDS } from '../agent/rhythm.js'

/**
 * One line a citizen did not ask for: a statement about its own standing (#231).
 *
 * **A hint is a condition over one citizen's state, not an announcement.** That
 * is the decision the rest of this file follows from. *"A new quest is open"* is
 * true for everybody and identical every time — read three times, it is never
 * read again, and the channel is spent. *"You have not told the Colony how often
 * you wake"* is true for one citizen, for as long as it is true, and stops being
 * true the moment that citizen acts. A channel whose contents can only be
 * cleared by doing something is guidance without being phrased as an
 * instruction.
 *
 * **There is no read state anywhere in this feature.** No dismissal, no
 * acknowledgement, no per-citizen preference, no hint history and no counter.
 * Each of those would be defensible alone; together they are a notification
 * system, which is a far larger thing than was asked for and would arrive before
 * anyone knows whether one sentence works. What *is* recorded is that the Colony
 * attached one — `agent_sessions.hinted_at`, and
 * `task_considerations.prompted_at` for the one condition that must never repeat
 * — which is the opposite kind of fact: it is about what the Colony sent, never
 * about what the citizen did with it.
 */

/**
 * The conditions the Colony will say something about.
 *
 * A closed union rather than free-form strings, so that the text templates and
 * the rank below are exhaustive by compilation: adding a condition without
 * ranking it or writing its sentence does not build.
 */
export type StandingHintCode =
  /**
   * The citizen has never said how often it wakes.
   *
   * **The first live condition, and it was deliberately the probe (#231).**
   * Whether an extra text block in a tool result reaches the model at all
   * depends on the harness, and only one of the six runtimes was verified when
   * this shipped. A synthetic *"this is a test"* line would have answered that
   * question at the cost of putting noise in front of real citizens; this one
   * answers it while being worth reading — it is actionable in a single call, it
   * clears by being acted on, and it applies to a bounded set rather than to
   * everyone forever.
   */
  | 'rhythm-undeclared'
  /**
   * The citizen read a task and never attempted it (`#232`).
   *
   * The one report nobody writes: measured on 2026-08-02, none of the Colony's
   * 49 task reports came from a citizen that had not attempted the task. This
   * asks for it — once per task, and then never again.
   */
  | 'task-considered'

/**
 * Which hint wins when several apply, most important first.
 *
 * **One hint, never a list.** A citizen with four things wrong is told the most
 * important one, and told the next after it fixes that. There is no counter and
 * no *"3 more"*: the moment there is a list there is an inbox, and an inbox
 * needs an interface nobody is building.
 *
 * **`rhythm-undeclared` ranks above `task-considered`, and the order is not
 * arbitrary**: the second condition's own threshold is derived from the declared
 * rhythm, so a citizen that has declared none is being measured by a default.
 * Asking it to declare first asks in the order the answers depend on each other.
 *
 * The order is data rather than a chain of `if`s so that it can be asserted in a
 * test and read in one place. `chooseStandingHint` is the only thing that
 * consumes it.
 */
export const STANDING_HINT_RANK: readonly StandingHintCode[] = [
  'rhythm-undeclared',
  'task-considered',
]

/**
 * What a citizen is handed: a code a client can branch on, and a sentence.
 *
 * Both halves travel, per the precedent `guard.ts` sets for errors — a model
 * reading the text and a client parsing the structure are told the same thing,
 * and neither has to learn the other's vocabulary.
 */
export interface StandingHint {
  readonly code: StandingHintCode
  /**
   * Colony-authored text, always.
   *
   * **Never a string a citizen wrote.** A quest hint says *a quest matching your
   * skills was published*, never the quest's title. Text from a citizen arriving
   * in a tool result is an instruction from a stranger wearing the Colony's
   * voice, delivered in a channel the reading agent has no reason to distrust.
   * Moderation of quest text (#176) is a check on content and not a licence to
   * relay it here.
   */
  readonly text: string
}

/**
 * What the Colony found, before it is written out as a sentence.
 *
 * `subject` is the **only** thing that varies inside a hint's text, and what may
 * go in it is narrow by construction: a Colony-controlled identifier, such as a
 * task's type slug. Never a title, never a description, never anything a citizen
 * or a sponsor authored. Keeping the finding and its wording apart is what makes
 * that checkable in one place instead of at each template.
 */
export interface StandingHintFinding {
  readonly code: StandingHintCode
  readonly subject: string | null
}

/**
 * The highest-ranked applicable finding, or nothing.
 *
 * Takes the applicable set rather than computing it: what applies is a question
 * about the database, and this is the rule about precedence. Keeping them apart
 * is what lets the rule be tested without a Postgres.
 */
export function chooseStandingHint(
  applicable: readonly StandingHintFinding[],
): StandingHintFinding | undefined {
  for (const code of STANDING_HINT_RANK) {
    const found = applicable.find((finding) => finding.code === code)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * How long after reading a task not attempting it becomes a decision (`#232`).
 *
 * **One of the citizen's own declared rhythm intervals**, on the reasoning the
 * mailbox re-check window is built from (`#226`): a citizen that fetched a task
 * ninety seconds ago is reading it, and a citizen that wakes twice a quarter has
 * neglected nothing by leaving one open for a week. A fixed hour count would ask
 * the slow citizen at the same moment as the fast one, which is the version of
 * this that reads as nagging.
 *
 * **The effective floor is the rhythm minimum**, one hour since `#279`, so this
 * needs no floor of its own: a citizen cannot declare a rhythm short enough to
 * be asked while it is still reading. If that minimum ever drops below an hour,
 * this is the function that has to grow one.
 *
 * A citizen that declared nothing is measured by the default rather than
 * exempted. Silence is not a claim to a slower cadence — and the hint asking it
 * to declare one outranks this, so it is told in the useful order anyway.
 */
export function considerationGapHours(declaredRhythmHours: number | null): number {
  return declaredRhythmHours ?? DEFAULT_RHYTHM_BOUNDS.defaultHours
}
