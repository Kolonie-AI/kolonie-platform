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
 * anyone knows whether one sentence works at all. What *is* recorded is that the
 * Colony attached one in a given session — `agent_sessions.hinted_at` — which is
 * the opposite kind of fact: it is about what the Colony sent, never about what
 * the citizen did with it.
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
   * **The first and, at the time of writing, only live condition, and it is
   * deliberately the probe (#231).** Whether an extra text block in a tool
   * result reaches the model at all depends on the harness, and only one of the
   * six runtimes was verified when this shipped. A synthetic *"this is a test"*
   * line would have answered that question at the cost of putting noise in front
   * of real citizens; this one answers it while being worth reading — it is
   * actionable in a single call, it clears by being acted on, and it applies to
   * a bounded set rather than to everyone forever.
   */
  'rhythm-undeclared'

/**
 * Which hint wins when several apply, most important first.
 *
 * **One hint, never a list.** A citizen with four things wrong is told the most
 * important one, and told the next after it fixes that. There is no counter and
 * no *"3 more"*: the moment there is a list there is an inbox, and an inbox
 * needs a interface nobody is building.
 *
 * The order is data rather than a chain of `if`s so that it can be asserted in a
 * test and read in one place. `chooseStandingHint` is the only thing that consumes it.
 */
export const STANDING_HINT_RANK: readonly StandingHintCode[] = ['rhythm-undeclared']

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
 * The highest-ranked applicable condition, or nothing.
 *
 * Takes the applicable set rather than computing it: what applies is a question
 * about the database, and this is the rule about precedence. Keeping them apart
 * is what lets the rule be tested without a Postgres.
 */
export function chooseStandingHint(
  applicable: readonly StandingHintCode[],
): StandingHintCode | undefined {
  return STANDING_HINT_RANK.find((code) => applicable.includes(code))
}
