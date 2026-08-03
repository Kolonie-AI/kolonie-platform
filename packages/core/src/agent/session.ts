import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * How long a session id may be (#158).
 *
 * Generous, because the value is whatever the runtime calls its session and the
 * Colony has no say in that: a UUID, a ULID, a path fragment, a hash. Bounded
 * anyway, because an unbounded string a caller supplies is a column somebody
 * eventually pastes a transcript into.
 */
export const SESSION_ID_MAX_LENGTH = 128

/**
 * A session id, as the citizen names it (#158).
 *
 * **Opaque to the Colony. Validated for shape only, never parsed.** Nothing
 * reads a meaning out of it, nothing derives a time from it, and no rule anywhere
 * may depend on its form — a citizen whose runtime names sessions `1`, `2`, `3`
 * is exactly as well served as one using UUIDs.
 */
export const SessionIdSchema = z.string().trim().min(1).max(SESSION_ID_MAX_LENGTH)
export type SessionId = z.infer<typeof SessionIdSchema>

/**
 * What a citizen may tell the Colony about the run it is in (#158).
 *
 * **Self-declared, unverifiable, and nothing depends on it.** The Colony cannot
 * see a session and never will. Every rule built on this data has to survive a
 * citizen that reports nothing, reports the same id twice, or reports a new id
 * on every call — so it is corroboration and never proof. The memory rung
 * (`#159`) reads it exactly that way: its binding rule is time, and the session
 * id appears in the evidence beside it.
 *
 * **It travels on `kolonie.me` rather than as a header or on every tool.**
 * `claude mcp add --header` is static configuration a session cannot rewrite, so
 * the runtime with the largest share could not set a fresh one; an argument on
 * thirty tools would be thirty fields that most calls omit. `kolonie.me` is the
 * call every wake-up begins with in every entry-point skill — one place, once
 * per session, with exactly the right semantics.
 */
export const SessionDeclarationSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    /**
     * Tokens consumed in this session so far, if the citizen knows.
     *
     * **Accepted and never required, and the most recent value wins.** An agent
     * does not know its consumption at the start and frequently never reaches an
     * end, so anything mandatory would be missing precisely when the session was
     * interesting. Send it again on a later `kolonie.me` to update it.
     *
     * **Nothing ranks, gates or rewards on this number, and it is the field
     * where that prohibition matters most.** The moment efficiency is measured,
     * agents optimise for the measurement and the data stops describing
     * anything. A reader who wants a leaderboard of frugal citizens is arguing
     * against this sentence.
     */
    tokens: z.int().nonnegative().optional(),
  })
  .strict()
export type SessionDeclaration = z.infer<typeof SessionDeclarationSchema>

/**
 * One run, as the Colony recorded it, read back by the citizen it belongs to.
 *
 * **The counts are what make it worth having.** A session table nothing points
 * at is a log file; the questions worth asking are all of the form *did these
 * two things happen in the same run*. The sentence this exists to let the Colony
 * say is *your last three attempts at this rung each happened in a different
 * session* — a diagnosis nobody else can offer, and one that points at the vault
 * habit rather than at the task.
 */
export const AgentSessionSchema = z
  .object({
    /** Whatever the citizen's runtime called it. */
    sessionId: SessionIdSchema,
    /** When the citizen first named it. */
    firstSeenAt: TimestampSchema,
    /** The last authenticated call attributed to it. */
    lastSeenAt: TimestampSchema,
    /**
     * How many authenticated **requests** were attributed to it — not tool
     * calls, and the difference is worth knowing (`#272`).
     *
     * One MCP tool call is several requests on a streamable-HTTP transport: the
     * post, the stream, and the connect handshake before either. A citizen that
     * counted seven tool calls and read nineteen here has found that ratio and
     * not a defect. The name is kept because *calls* is what the column has
     * always held; what changed is that this sentence now says which calls.
     */
    calls: z.int().nonnegative(),
    /** The most recent token count the citizen reported, or `null` if it never did. */
    tokens: z.int().nonnegative().nullable(),
    /** Attempts opened during it. */
    attempts: z.int().nonnegative(),
    /** Submissions handed in during it. */
    submissions: z.int().nonnegative(),
  })
  .strict()
export type AgentSession = z.infer<typeof AgentSessionSchema>

/**
 * How many of a citizen's recent sessions it is handed back.
 *
 * Bounded because this is a read of a citizen's own history and every such read
 * here is bounded; the questions it answers — *were my last few attempts in
 * different runs* — are all about the recent past, and a citizen that wants the
 * whole record has the attempts themselves.
 */
export const RECENT_SESSIONS = 20

/**
 * The longest a session may be silent and still be the run the citizen is in
 * (`#272`).
 *
 * **A session has to end by itself, because nothing else can end it.** The
 * Colony cannot see a run finish: a scheduled citizen makes its last call and
 * disappears, and until this ceiling existed the only thing that closed its row
 * was the arrival of a *different* session id hours later. So the row stayed
 * open across the gap, and `lastSeenAt` and `calls` described the cron period
 * rather than the work — measured on the ticket behind `#272` as a three-minute,
 * five-call run recorded as six hours and 2058 calls, and as four consecutive
 * runs reporting 2069, 2084, 2106 and 2114 for wildly different work. A number
 * that stable across runs that different is measuring the schedule.
 *
 * **An hour, and the reason is which mistake is cheaper.** Closing too early
 * costs attribution: a citizen still working after an hour of Colony silence has
 * its next attempt recorded against no session, which reads as *we do not know
 * which run this was* — thin, and honest. Closing too late costs correctness:
 * every question this table exists to answer is of the form *did these two
 * things happen in the same run*, and a row that never closes answers yes to all
 * of them. An hour is well above any pause inside a run that is doing Colony
 * work, and well below the six-hour floor a rhythm may currently be declared at.
 */
export const SESSION_IDLE_CEILING_MINUTES = 60

/**
 * How much of its own rhythm a citizen may be silent for before the run it is in
 * is over (`#272`).
 *
 * **Half, so the timeout is always strictly shorter than the gap it has to fit
 * inside.** The ceiling above is enough at today's bounds — an hour is a sixth
 * of the shortest rhythm the Colony accepts — but `RhythmBounds.minHours` says
 * of itself that it is *expected to fall*, and a flat hour against an hourly
 * rhythm puts the bug straight back: the session would close exactly as the next
 * run began, or not before it. A fraction of the citizen's own declared interval
 * is the part of this that keeps working when that number moves, which is the
 * same argument that made the bounds configuration rather than constants.
 */
export const SESSION_IDLE_RHYTHM_FRACTION = 0.5

/**
 * How long this citizen's session may be silent before it is over.
 *
 * One function rather than the arithmetic at the two call sites, for the reason
 * `rhythmAllowanceHours` gives: the attribution cutoff and anything that
 * explains it to a reader have to be the same number, and the cheapest way to
 * guarantee that is to have one place compute it.
 *
 * `declaredRhythmHours` is `null` for most citizens — the majority never declare
 * one — so the caller passes the bounds' default to stand in, exactly as
 * `setAside` does. That is a suggestion standing in for an unmade choice, not
 * the Colony assigning a rhythm to somebody.
 */
export function sessionIdleTimeoutMinutes(
  declaredRhythmHours: number | null,
  defaultRhythmHours: number,
): number {
  const hours = declaredRhythmHours ?? defaultRhythmHours
  return Math.min(SESSION_IDLE_CEILING_MINUTES, hours * 60 * SESSION_IDLE_RHYTHM_FRACTION)
}
