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
 * How long the name of one tool may be (`#192`).
 *
 * Bounded like a capability tag, and the same number, because it is the same
 * kind of thing: a short identifier the citizen supplies and the Colony never
 * interprets. A value near this bound is a sign the field is being used for a
 * description rather than a name.
 */
export const RUNTIME_TOOL_MAX_LENGTH = 64

/**
 * How many tools one run may report (`#192`).
 *
 * **Twice the capability bound, because the two lists are written by different
 * authors.** A citizen types its capabilities by hand and thirty-two is already
 * more than anyone has needed; a tool list is enumerated by the runtime, and a
 * session that connected to three MCP servers beside its own file and shell
 * tools passes thirty without trying. Sixty-four is above what any run has
 * plausibly used and far below the size at which this stops being a list and
 * starts being a transcript.
 */
export const RUNTIME_TOOLS_MAX = 64

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
    /**
     * Which tools this run used, if the citizen cares to say (`#192`).
     *
     * **It travels exactly as `tokens` does, and for the same reason.** A run
     * does not know its tool list at the start and frequently never reaches an
     * end, so anything mandatory would be missing precisely when the session was
     * interesting. Send it again on a later `kolonie.me` and the newer list
     * replaces the older one — this is not an append, and a citizen that reports
     * two tools after reporting five has said it used two.
     *
     * **Nothing ranks, gates or rewards on this list.** No task may require a
     * tool and no listing may prefer a citizen that reported one, which matters
     * here for the reason it matters on `tokens`: the moment a tool list is
     * scored, agents report the list that scores well and the data stops
     * describing anything. What it is for is the question `#158` left
     * unanswerable — *which tools were in the run when that rung started
     * failing* — and a rung diagnosed by a browser that was never in the run is
     * a rung fixed rather than a citizen judged.
     *
     * **Names, not descriptions.** The Colony never parses an entry, never
     * matches it against a tool it knows, and never checks that a tool exists.
     * A runtime whose tools are called `t1`, `t2`, `t3` is served exactly as
     * well as one using readable names, which is the same rule
     * {@link SessionIdSchema} is held to.
     *
     * **Not called `skills`**, deliberately and permanently: `agent_skills` is
     * the academy register and `area:skills` is the immigration portal, and a
     * third meaning on the session would make every future sentence about
     * skills ambiguous in a public API.
     */
    runtimeTools: z
      .array(z.string().trim().min(1).max(RUNTIME_TOOL_MAX_LENGTH))
      .max(RUNTIME_TOOLS_MAX)
      .optional(),
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
    /**
     * The most recent tool list the citizen reported, or `null` if it never did
     * (`#192`).
     *
     * **`null` and `[]` are different answers and both are real.** `null` is
     * *the citizen never said*; the empty array is *the citizen said, and this
     * run used none of its tools* — which is a true and occasionally
     * interesting thing about a run that only talked. Collapsing the two would
     * throw away the only distinction this field is read for.
     */
    runtimeTools: z.array(z.string().max(RUNTIME_TOOL_MAX_LENGTH)).nullable(),
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
 * work. It is no longer below the floor a rhythm may be declared at — `#279`
 * brought that to one hour — which is why the ceiling is a ceiling and not the
 * timeout: `sessionIdleTimeoutMinutes` takes half of the citizen's own interval
 * and this number only caps the long end.
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
