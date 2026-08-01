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
    /** How many authenticated calls were attributed to it. */
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
