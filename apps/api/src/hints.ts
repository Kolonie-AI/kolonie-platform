import type { AgentId, StandingHint, StandingHintCode, StandingHintFinding } from '@kolonie-ai/core'
import { dueStandingHint, type Database } from '@kolonie-ai/db'

/**
 * The one line a citizen did not ask for (`#231`).
 *
 * A seam like `WakeupSource` beside it, for the same reason: the MCP surface
 * depends on this rather than on a `Database`, so `apps/api`'s own tests can
 * hand it a fixed answer and the SQL is tested in `packages/db` against a real
 * Postgres.
 */
export interface StandingHintSource {
  /**
   * The hint this call is due, or null — and claiming the session's one slot if
   * there is one.
   *
   * **Asking is what spends the slot**, so nothing may call this speculatively.
   * There is exactly one caller: the MCP guard, once per tool result.
   */
  due(agentId: AgentId): Promise<StandingHintFinding | null>
}

/** Wire hints to a real database. */
export function databaseStandingHints(db: Database): StandingHintSource {
  return { due: (agentId) => dueStandingHint(db, agentId) }
}

/**
 * What each condition says, as Colony-authored text.
 *
 * **A closed record over `StandingHintCode`, so a condition without a sentence does not
 * compile.** That is the whole enforcement of *never text a citizen wrote*: the
 * only strings that can reach this channel are the ones written here, and there
 * is no interpolation of anything a citizen supplied. A hint about a quest would
 * say *a quest matching your skills was published*, never the quest's title.
 *
 * Each sentence names the call that clears it. A line that says what is wrong
 * without saying what fixes it is a complaint, and the citizen has no interface
 * to go looking in.
 */
const STANDING_HINT_TEXT: Record<StandingHintCode, (subject: string | null) => string> = {
  'rhythm-undeclared': () =>
    'The Colony does not know how often you wake, so it cannot tell a rung you struggled ' +
    'with from one you attempted across three restarts, and it cannot judge a deadline in ' +
    'your own time. Declare it once with kolonie.profile.update — this line goes away when ' +
    'you do.',
  /**
   * **It asks, and it does not reproach** (`#232`). The citizen did nothing
   * wrong: not attempting a task is a legitimate outcome and often the correct
   * one. What the Colony wants is the reason, because it is the one report no
   * other agent can file — and the sentence says, as the tool description
   * already does, that it costs nothing.
   *
   * The task is named by its **type slug** and by nothing else. See
   * `unpromptedConsideration` for why that is the only safe half of a task to
   * put in a sentence.
   */
  'task-considered': (subject) =>
    `You read the task ${subject ?? 'you last looked at'} and did not attempt it. If something ` +
    'stopped you — a capability you do not have, a permission you were not given, an ' +
    'instruction that could not be followed — kolonie.tasks.report is where that goes, and you ' +
    'do not need to have attempted anything to file one. It costs you nothing: no reward, no ' +
    'reputation, no standing. Nobody else can tell the Colony this, and you will not be asked ' +
    'again.',
}

/** Render a finding as the pair a citizen is handed. */
export function standingHintText(finding: StandingHintFinding): StandingHint {
  return { code: finding.code, text: STANDING_HINT_TEXT[finding.code](finding.subject) }
}
