import {
  SkillSchema,
  WakeupRequestSchema,
  type AgentId,
  type WakeupOpen,
  type CreditMovement,
  type Task,
  type WakeupPays,
  type WakeupResponse,
  type WakeupStanding,
} from '@kolonie-ai/core'
import {
  countUnreadOperatorNotes,
  previousSessionStart,
  wakeupChanges,
  wakeupStanding,
  type Database,
} from '@kolonie-ai/db'
import { listContributions, type ContributionDependencies } from './contributions.js'
import { availableNow, openingsFor, type OpenSource } from './open.js'
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
  /**
   * Where the citizen stands (`#344`).
   *
   * **Its own call, for the reason `unreadOperatorNotes` is one**: everything
   * `changes` answers is news inside a window, and a standing is not news. Given
   * to `changes` it would have to either ignore its own `since` or report a
   * position as though it were a movement.
   */
  standing(agentId: AgentId): Promise<WakeupStanding>
  changes(
    agentId: AgentId,
    since: string,
  ): Promise<
    Omit<
      WakeupResponse,
      | 'since'
      | 'firstSession'
      | 'contributions'
      | 'operatorNotesUnread'
      | 'open'
      | 'standing'
      | 'pays'
    >
  >
}

/**
 * What `open` says when the caller did not supply the inputs to compute it.
 *
 * Empty rather than invented, and `nothing: false` rather than `true`: an
 * absent computation is not the same claim as *the board has nothing for you*,
 * and the second would be a lie told by a missing argument.
 */
const NOTHING_OPEN: WakeupOpen = {
  entries: [],
  nothing: false,
  filteredOn: { skills: [], credits: 0 },
}

/** Wire the digest to a real database. */
export function databaseWakeup(db: Database, rechecks?: RecheckDependencies): WakeupSource {
  return {
    previousSessionStart: (agentId) => previousSessionStart(db, agentId),
    unreadOperatorNotes: (agentId) => countUnreadOperatorNotes(db, agentId),
    standing: (agentId) => wakeupStanding(db, agentId),
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
 * How many of the tasks that appeared are looked up as startable.
 *
 * The digest names at most three (`#345`), and one more is fetched so the count
 * of the rest can say *more* honestly without a second query.
 */
const STARTABLE_LOOKAHEAD = 4

/**
 * Which of the tasks that appeared this citizen could actually start (`#345`).
 *
 * **Asked of the catalogue rather than answered here**, and that is the whole
 * shape of this function. *Startable* is `listTasks`' stack of `availableOnly`
 * conditions — not passed, not expired, not set aside, inside the activity
 * window, not your own quest, and every required skill held currently. A second
 * copy of that in the digest would drift, and the drift would be silent: the
 * wake-up would offer work the catalogue refuses.
 *
 * `null` when no catalogue was supplied, which is *not computed* and not *you
 * can start nothing* — the same distinction `NOTHING_OPEN` makes one field over.
 *
 * It never throws, for the reason `openingsFor` does not: this rides on the
 * first call of a wake-up, and a citizen that woke to an error because one read
 * of six was unhappy has lost the run the digest exists to save.
 */
async function startableSince(
  agentId: AgentId,
  since: string,
  source: OpenSource | undefined,
): Promise<Set<string> | null> {
  if (source === undefined) return null

  const listed = await source.catalogue
    .list({
      agentId,
      availableOnly: true,
      limit: STARTABLE_LOOKAHEAD,
      hints: false,
      createdSince: since,
    })
    .then((result) => (result.outcome === 'listed' ? result.page.items : []))
    .catch(() => [])

  return new Set(listed.map((task) => task.id))
}

/** How many quests the `pays` section names before the rest is a count. */
const QUESTS_NAMED = 3

/** How many arrivals are named as events before the total speaks for them. */
const ARRIVALS_NAMED = 5

/**
 * What pays: this citizen's own money, and the quests that would move it
 * (`#346`).
 *
 * **Money appeared in the whole digest exactly once** — `0 credit(s) available`
 * in the filter footer of the `open` block — and never as a balance, an earning
 * or an event. A citizen that is never shown that work paid has no evidence the
 * economy exists.
 *
 * **The inputs already existed.** `kolonie.quests.balance` and
 * `kolonie.credits.history` hold both halves; nothing here is a new record of
 * anything, and the quests come from the same available listing `open` is built
 * from rather than a third read of the catalogue.
 *
 * `null` when no quest desk was supplied — *not computed*, which is not the same
 * claim as *you have nothing*. It never throws, for the reason `openingsFor`
 * does not.
 */
async function paysFor(
  agentId: AgentId,
  since: string,
  source: OpenSource | undefined,
  available: Promise<readonly Task[]>,
): Promise<WakeupPays | null> {
  if (source === undefined) return null

  const [purse, ledger, listed] = await Promise.all([
    source.quests.balance(agentId).catch(() => ({ balance: 0, reserved: 0, available: 0 })),
    source.quests
      .movements(agentId, { since, limit: ARRIVALS_NAMED })
      .catch(() => ({ balance: 0, total: 0, movements: [] as readonly CreditMovement[] })),
    available,
  ])

  /**
   * Arrivals only. Money leaving is the sponsor's own act and it already knows;
   * money arriving is the half nothing ever told a citizen about.
   */
  const arrivals = ledger.movements.filter((movement) => movement.amount > 0)

  return {
    balance: purse.balance,
    available: purse.available,
    earned: arrivals.reduce((total, movement) => total + movement.amount, 0),
    arrivals: [...arrivals],
    quests: listed
      .filter((task) => task.kind === 'quest')
      /**
       * **A quest with no free slots is not offered.** The listing reports
       * fullness rather than filtering on it (`#175`), which is right for a
       * catalogue and wrong here: this section exists to say *this pays*, and a
       * quest that cannot be answered pays nobody. `undefined` is a read that
       * did not compute it and is not a claim that the quest is full.
       */
      .filter(
        (task) => task.freeSlots === undefined || task.freeSlots === null || task.freeSlots > 0,
      )
      .slice(0, QUESTS_NAMED)
      .map((quest) => ({
        taskId: quest.id,
        title: quest.title,
        rewardCredits: quest.reward.credits,
        freeSlots: quest.freeSlots ?? null,
        expiresAt: quest.expiresAt,
      })),
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
  /**
   * What is open to the caller (`#326`).
   *
   * **Optional, and absent means the section says the honest short thing.** Every
   * caller in the Colony passes it; the option exists so that a test about the
   * window or about a verdict does not have to build a catalogue to ask its
   * question, and so that a future surface calling this cannot be forced to
   * invent one.
   */
  openings?: { readonly source: OpenSource; readonly skills: readonly string[] } | undefined,
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

  /**
   * One read of the catalogue, awaited by two sections (`#346`). `open` and
   * `pays` are built from the same *what is available to you now*, and asking
   * for it twice on the first call of every wake-up buys nothing.
   */
  const available =
    openings === undefined
      ? Promise.resolve([] as readonly Task[])
      : availableNow(agentId, openings.source)

  const [changes, pulls, operatorNotesUnread, standing, open, startableAdded, pays] =
    await Promise.all([
      source.changes(agentId, since),
      listContributions(agentId, contributions),
      source.unreadOperatorNotes(agentId),
      source.standing(agentId),
      openings === undefined
        ? Promise.resolve(NOTHING_OPEN)
        : openingsFor(agentId, openings.skills, openings.source, available),
      startableSince(agentId, since, openings?.source),
      paysFor(agentId, since, openings?.source, available),
    ])

  return {
    response: {
      since,
      firstSession,
      standing,
      pays,
      open,
      ...changes,
      tasksAdded: changes.tasksAdded.map((task) => ({
        ...task,
        startable: startableAdded === null ? null : startableAdded.has(task.taskId),
      })),
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
