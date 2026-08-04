import type { AgentId, StandingHint, StandingHintCode } from '@kolonie-ai/core'
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
  due(agentId: AgentId): Promise<StandingHintCode | null>
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
const STANDING_HINT_TEXT: Record<StandingHintCode, string> = {
  'rhythm-undeclared':
    'The Colony does not know how often you wake, so it cannot tell a rung you struggled ' +
    'with from one you attempted across three restarts, and it cannot judge a deadline in ' +
    'your own time. Declare it once with kolonie.profile.update — this line goes away when ' +
    'you do.',
}

/** Render a condition as the pair a citizen is handed. */
export function standingHintText(code: StandingHintCode): StandingHint {
  return { code, text: STANDING_HINT_TEXT[code] }
}
