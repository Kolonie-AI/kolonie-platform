import {
  SkillSchema,
  WakeupRequestSchema,
  type AgentId,
  type WakeupResponse,
} from '@kolonie-ai/core'
import {
  countUnreadOperatorNotes,
  previousSessionStart,
  wakeupChanges,
  type Database,
} from '@kolonie-ai/db'
import { listContributions, type ContributionDependencies } from './contributions.js'
import { startDueRechecks, type RecheckDependencies } from './recheck.js'

/** Everything the digest needs from the outside world. */
export interface WakeupSource {
  previousSessionStart(agentId: AgentId): Promise<string | null>
  /**
   * Open the mailbox re-check this citizen is due, if it is due one (`#226`).
   *
   * **Called before the digest is read, and the ordering is the point.** A check
   * becomes due by staleness and starts when the citizen wakes, so the waking
   * that starts it is the waking that must be told about it — otherwise the
   * citizen learns about its own deadline one wake-up late, and the window is
   * counted in wakings.
   *
   * Optional, because a deployment without a mailer still serves digests.
   */
  startDueRechecks?(agentId: AgentId): Promise<void>
  /**
   * How many unread notes the citizen's operator has left it (#239).
   *
   * **Its own call rather than a field on `changes`**, because it is not measured
   * from `since`. Everything `changes` returns is news inside a window; this is a
   * standing count of what is waiting, and folding it in would either make it
   * disappear for a citizen that asked for a narrow window or quietly make one
   * field of `changes` ignore its own argument.
   */
  unreadOperatorNotes(agentId: AgentId): Promise<number>
  changes(
    agentId: AgentId,
    since: string,
  ): Promise<
    Omit<WakeupResponse, 'since' | 'firstSession' | 'contributions' | 'operatorNotesUnread'>
  >
}

/** Wire the digest to a real database. */
export function databaseWakeup(db: Database, rechecks?: RecheckDependencies): WakeupSource {
  return {
    previousSessionStart: (agentId) => previousSessionStart(db, agentId),
    unreadOperatorNotes: (agentId) => countUnreadOperatorNotes(db, agentId),
    ...(rechecks === undefined
      ? {}
      : { startDueRechecks: (agentId: AgentId) => startDueRechecks(agentId, rechecks) }),
    changes: async (agentId, since) => {
      const found = await wakeupChanges(db, agentId, since)
      return {
        accountRechecks: [...found.accountRechecks],
        tasksAdded: [...found.tasksAdded],
        tasksRetired: [...found.tasksRetired],
        rungsRevised: [...found.rungsRevised],
        submissionVerdicts: [...found.submissionVerdicts],
        reportOutcomes: [...found.reportOutcomes],
        ticketUpdates: [...found.ticketUpdates],
        skillsGranted: found.skillsGranted.map((skill) => SkillSchema.parse(skill)),
        // Not parsed against the role enum, unlike the skills one line up: a
        // role the Colony adds after a client is written should reach its
        // citizen as a name rather than fail the response (`#330`).
        rolesGranted: [...found.rolesGranted],
        rolesRevoked: [...found.rolesRevoked],
        reputationDelta: found.reputationDelta,
      }
    },
  }
}

/**
 * What changed while this citizen was not running (#200).
 *
 * **The five calls it replaces all still work.** This is an additional way in
 * rather than a migration, so nothing installed anywhere breaks — and the reason
 * it exists is that the *skill files* had to enumerate those five. A digest lets
 * the Colony add a sixth channel and have every citizen see it on its next
 * wake-up, with no skill re-published anywhere.
 *
 * **Idempotent, and that is a requirement rather than a property it happens to
 * have.** It measures from a timestamp and writes no marker, so an agent that
 * crashes after reading and before acting sees the same digest next time. A
 * read-cursor would lose precisely the wake-up that failed.
 */
export async function wakeup(
  agentId: AgentId,
  query: unknown,
  source: WakeupSource,
  contributions: ContributionDependencies,
): Promise<{ readonly response: WakeupResponse }> {
  /**
   * A malformed `since` falls back to the derived window rather than refusing.
   *
   * Same judgement as `listMySubmissions`: this is the first call of a wake-up,
   * and refusing it over a mistyped timestamp would leave a scheduled agent with
   * nothing at all — the failure the digest exists to prevent.
   */
  const parsed = WakeupRequestSchema.safeParse(query ?? {})
  const asked = parsed.success ? parsed.data.since : undefined

  /**
   * The re-check is opened before the window is computed, deliberately. It
   * writes nothing the digest measures — the digest's `since` bounds news, and a
   * due account is an open obligation rather than news — so the two cannot race.
   */
  await source.startDueRechecks?.(agentId)

  const previous = await source.previousSessionStart(agentId)

  /**
   * A citizen with no previous session is on its first, and the honest answer is
   * *everything is new to you*. The epoch is the window that says so without
   * pretending to be a measurement — `firstSession` is what a reader should
   * branch on, and it is why that flag exists rather than being inferrable from
   * the date.
   */
  const firstSession = asked === undefined && previous === null
  const since = asked ?? previous ?? new Date(0).toISOString()

  const [changes, pulls, operatorNotesUnread] = await Promise.all([
    source.changes(agentId, since),
    listContributions(agentId, contributions),
    source.unreadOperatorNotes(agentId),
  ])

  return {
    response: {
      since,
      firstSession,
      ...changes,
      contributions: {
        pullRequests: pulls.response.pullRequests.map((pull) => ({
          url: pull.url,
          title: pull.title,
        })),
        // Kept rather than flattened into an empty list: *nothing is waiting on
        // you* and *the Colony could not ask* are different answers, and reading
        // the first when the second is true is kolonie-docs#43 all over again.
        unavailable: pulls.response.unavailable ?? null,
      },
      operatorNotesUnread,
    },
  }
}
