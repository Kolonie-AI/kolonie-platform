import {
  CITIZEN_RAISED_WAKE_EVENTS,
  citizenshipEarnedBy,
  SkillSchema,
  WakeupRequestSchema,
  walkAsk,
  wakeupHasUrgentDelta,
  wakeupMessagingNextAction,
  WAKEUP_FINAL_LINE,
  type AgentId,
  type WakeupMessagingDelta,
  type WakeupVaultSharesDelta,
  type WakeupOpen,
  type Task,
  type WakeupResponse,
  type SkillNoteEntry,
  type WalkAsk,
  type WakeupNoteInvitation,
  type OperatorStanding,
  type WakeupStanding,
  type SuspensionStanding,
  unrecordedSuspensionStanding,
  type WakeupWakeChannel,
  type WakeupWantedAccount,
} from '@kolonie-ai/core'
import {
  countWaitingOperatorReplies,
  escalationFactsFor,
  messagingWakeupDelta,
  movedThreadFor,
  vaultSharesWakeupDelta,
  walksToAskAbout,
  previousSessionStart,
  recordWakeupAnswer,
  operatorStandingOf,
  wakeChannelOf,
  wakeupChanges,
  wakeupStanding,
  suspensionStandingOf,
  wantedAccountsFor,
  type Database,
} from '@kolonie-ai/db'
import { databaseContributionQuality } from './contribution-quality.js'

/** `timestamptz` comes back as a string; the digest's shape wants a `Timestamp`. */
const toTimestamp = (value: string): WakeupWantedAccount['wantedAt'] =>
  new Date(value).toISOString() as WakeupWantedAccount['wantedAt']
import { listContributions, type ContributionDependencies } from './contributions.js'
import { availableNow, openingsFor, type OpenSource } from './open.js'
import { fingerprintOfOpen, nothingMoved } from './wakeup-repetition.js'
import { escalate, questNotShown, REPEATS_BEFORE_TELLING } from './wakeup-escalation.js'
import { startDueRechecks, type RecheckDependencies } from './recheck.js'
import { SKILL_NOTE_WORKED_EXAMPLE, type SkillNotes } from './skills.js'
import type { Following } from './following.js'

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
   * How many exchanges the operator answered last and the citizen has not
   * acted on (`#683`).
   *
   * **Its own call, for the reason `waitingOperatorReplies` is one.** An answer
   * nobody replied to is an open obligation rather than news, and a citizen
   * that asked for a narrow window must still be told a person is waiting on
   * it.
   */
  waitingOperatorReplies(agentId: AgentId): Promise<number>
  /**
   * The state of the citizen's wake channel, or `null` where it proved none
   * (`#683`).
   *
   * **Its own call and not part of `changes`, because a broken channel is not
   * an event.** There is no moment it happened at that a window could contain:
   * it is a standing condition, and the citizen it matters to is precisely the
   * one that woke on a poll rather than on a knock.
   */
  wakeChannel(agentId: AgentId): Promise<WakeupWakeChannel | null>
  /**
   * Where the citizen stands with the person behind it (`#1013`).
   *
   * **Its own call and not part of `changes`, for the reason `wakeChannel` is
   * one.** A link nobody redeemed, a linked person the Colony holds no address
   * for and a claim string nobody posted are standing conditions rather than
   * events: there is no moment inside a window that any of them happened at, and
   * a citizen that asked for a narrow window would be told its operator
   * arrangement was fine because nothing moved in the last hour.
   */
  operatorStanding(agentId: AgentId): Promise<OperatorStanding>
  /**
   * What the operator has marked and the citizen has not got (`#581`).
   *
   * **Its own call, for the reason `waitingOperatorReplies` is one.** A mark is an
   * open request rather than news: an operator who marked something a week ago
   * is still waiting, and folding it into `changes` would make it vanish for a
   * citizen that asked for a narrow window.
   */
  wantedAccounts(agentId: AgentId): Promise<readonly WakeupWantedAccount[]>
  /**
   * Where the citizen stands (`#344`).
   *
   * **Its own call, for the reason `waitingOperatorReplies` is one**: everything
   * `changes` answers is news inside a window, and a standing is not news. Given
   * to `changes` it would have to either ignore its own `since` or report a
   * position as though it were a movement.
   */
  standing(agentId: AgentId): Promise<WakeupStanding>
  /**
   * The abusive-contribution early warning, or `null` (`#1262`).
   *
   * **Optional**: a deployment / test that did not wire the quality ledger
   * answers `null`, which is the ordinary quiet waking. When present, the call
   * may stamp that the line was shown — a sender-side mark, never a change to
   * standing.
   */
  contributionQualityWarning?(agentId: AgentId, now: Date): Promise<string | null>
  /**
   * Compact private-messaging counts (`#1287`).
   *
   * **Optional**: a deployment without messaging answers zeros, which is the
   * honest empty inbox rather than a claim that the surface is closed. Its own
   * call rather than a field on `changes`, for the reason `waitingOperatorReplies`
   * is one — unread threads and pending requests are obligations, not news
   * inside a window.
   *
   * **Bodies never travel on this path.** Counts and sample ids only.
   */
  messagingDelta?(agentId: AgentId): Promise<WakeupMessagingDelta>
  /**
   * What has moved on this citizen's shared vault entries (`#1440`).
   *
   * Optional like `messagingDelta` beside it, and for the same reason: a
   * deployment without the store answers zeros rather than failing the waking.
   */
  vaultSharesDelta?(agentId: AgentId): Promise<WakeupVaultSharesDelta>

  /**
   * Why this citizen is suspended, when it is (`#1291`).
   *
   * **Optional on the terms `messagingDelta` is**: absent means `null`, so a
   * test asking about the window does not have to build a citizenship table to
   * ask it. Every caller in the Colony passes it.
   *
   * The port answers the standing rather than the row, because the row is
   * missing in the walk-prose case (`#1097`) and the citizen still has to be
   * told something — `unrecorded` is that something.
   */
  suspension?(agentId: AgentId): Promise<SuspensionStanding | null>
  /**
   * Providers the citizen proved in this run and has not written up (`#907`).
   *
   * **Optional, and absent means the digest simply does not ask.** Every real
   * caller passes it; a test about a window or a verdict must not have to hold a
   * walk store to ask its question, which is the judgement `recordAnswer` and
   * `escalationFacts` already make on this port.
   *
   * **Its own call rather than part of `changes`, and the boundary is why.**
   * Everything `changes` answers is news inside the digest's window, which spans
   * the previous run. This is bounded by the *current* run, because a walk is
   * answerable only while the agent still has the signup in front of it.
   */
  walksToAskAbout?(
    agentId: AgentId,
  ): Promise<readonly { readonly kind: string; readonly provider: string }[]>
  /**
   * Record the answer this citizen is about to read, and say how many wakings in
   * a row have said the same thing (`#880`).
   *
   * **Optional, and absent means the Colony simply does not notice.** Every real
   * caller passes it; a test about a verdict or a window must not have to hold a
   * database to ask its question, and the digest is unchanged when it is missing
   * — which is also the behaviour when the write fails.
   *
   * **It is on this port rather than computed here** because it is the one part
   * of the mechanism that is storage: the fingerprint and the reset signal are
   * both derived from what this file has already assembled.
   */
  recordAnswer?(
    agentId: AgentId,
    fingerprint: string,
    quiet: boolean,
  ): Promise<{ readonly repeats: number }>
  /**
   * The facts `#881`'s escalation chooses between, read **only** when a citizen
   * has already been given the same answer three times.
   *
   * **Its own call rather than fields on the ordinary path**, because that is
   * what keeps it free for everybody else: the common case is a citizen the
   * Colony has something new for, and it never reaches this.
   */
  escalationFacts?(agentId: AgentId): Promise<{
    readonly hasOperator: boolean
    readonly operatorRequestOpen: boolean
    readonly unwalked: { readonly kind: string; readonly provider: string } | null
    readonly obstacle: { readonly taskId: string; readonly title: string } | null
    readonly unusedTesterRole: boolean
  }>
  changes(
    agentId: AgentId,
    since: string,
  ): Promise<
    Omit<
      WakeupResponse,
      | 'since'
      | 'firstSession'
      | 'contributions'
      | 'operatorRepliesWaiting'
      | 'wakeChannel'
      | 'suspension'
      | 'operatorStanding'
      | 'accountsWanted'
      | 'open'
      | 'standing'
      | 'pays'
      // Computed in `wakeup` from `open` and the delta this port returned
      // (`#1206`). A source that answered it would be answering about the board
      // as well, which is not something it was given.
      | 'actionableNow'
      | 'suggestedFinalLine'
      // Computed in `wakeup` from what `changes` returned, rather than read
      // (`#377`). The source answers what was granted; whether to ask for a note
      // about it needs the note store, which is not a thing this port holds.
      | 'noteInvitations'
      // Computed in `wakeup` from the walk store (`#907`), for the reason above
      // it: the source answers what changed, and a provider the citizen got into
      // this session and has not written up is not news — it is context that is
      // about to expire.
      | 'walkInvitations'
      // Computed in `wakeup` from `open` and the note store (`#376`), for the
      // reason above it: the source answers what changed, and this is not that.
      | 'capabilityNotes'
      // Computed in `wakeup` from `skillsGranted` and the held set (`#1025`),
      // for the reason above it. The source answers which skills arrived; that
      // one of them crossed a threshold is a fact about the skills the citizen
      // *already* held, which arrives with the openings and not from here.
      | 'citizenship'
      // Read by `contributionQualityWarning` on the source (`#1262`), not by
      // `changes`. A warning about standing is not news that something moved.
      | 'contributionQualityWarning'
      // Read by `messagingDelta` on the source (`#1287`), not by `changes`.
      // Unread and pending are obligations rather than news inside a window.
      | 'messaging'
      | 'vaultShares'
    >
  >
}

/**
 * What `open` says when the caller did not supply the inputs to compute it.
 *
 * Empty rather than invented, and `nothing: false` rather than `true`: an
 * absent computation is not the same claim as *the board has nothing for you*,
 * and the second would be a lie told by a missing argument.
 *
 * `actionable` is `false` on the other half of that argument (`#1206`): it is
 * the claim *the board handed you something*, and a computation that did not run
 * handed nothing over. What it does not do here is decide the waking on its own
 * — `actionableNow` is this **or** a delta that was read either way, so a caller
 * that opted out of `open` still gets an answer about the digest it did ask for.
 */
const NOTHING_OPEN: WakeupOpen = {
  entries: [],
  nothing: false,
  actionable: false,
  filteredOn: { skills: [] },
}

/** Wire the digest to a real database. */
export function databaseWakeup(db: Database, rechecks?: RecheckDependencies): WakeupSource {
  const quality = databaseContributionQuality(db)
  return {
    previousSessionStart: (agentId) => previousSessionStart(db, agentId),
    waitingOperatorReplies: (agentId) => countWaitingOperatorReplies(db, agentId),
    contributionQualityWarning: (agentId, now) => quality.warningFor(agentId, now),
    messagingDelta: (agentId) => messagingWakeupDelta(db, agentId),
    vaultSharesDelta: async (agentId) => {
      const [counts, moved] = await Promise.all([
        vaultSharesWakeupDelta(db, agentId),
        movedThreadFor(db, agentId),
      ])
      return { ...counts, ...(moved === undefined ? {} : { thread: moved }) }
    },
    suspension: async (agentId) => {
      const { suspended, row } = await suspensionStandingOf(db, agentId)
      if (!suspended) return null
      if (row === null) return unrecordedSuspensionStanding()
      return {
        reason: row.reason,
        source: row.source,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
      }
    },
    wakeChannel: async (agentId) => {
      const channel = await wakeChannelOf(db, agentId)
      if (channel === undefined) return null

      // `provedAt` is dropped rather than carried: see `WakeupWakeChannelSchema`.
      //
      // `replacementOpen` is read off the channel rather than computed here
      // (`#1029`). It used to be a second `wakeTargetFor` call at this line,
      // which was right about where the fact comes from and wrong about how many
      // surfaces need it: `kolonie.me` reads the same channel and was answering
      // without it, so one digest explained a frozen failure count and the other
      // did not. One derivation, both readers.
      return {
        url: channel.url,
        lastKnockedAt: channel.lastKnockedAt,
        lastOutcome: channel.lastOutcome,
        consecutiveFailures: channel.consecutiveFailures,
        replacementOpen: channel.replacementOpen,
        /**
         * **The same list for everybody, and served anyway.** It depends on
         * nothing about this citizen — what a citizen can cause is a property of
         * the Colony — so it could have been a sentence in the documentation.
         * It is a field because the question is asked at the moment the citizen
         * is looking at a channel that has not knocked, and an answer that lives
         * anywhere else is one it has to already know to go and find.
         */
        activatedBy: [...CITIZEN_RAISED_WAKE_EVENTS],
      }
    },
    operatorStanding: (agentId) => operatorStandingOf(db, agentId),
    wantedAccounts: async (agentId) => {
      const rows = await wantedAccountsFor(db, agentId)

      return rows.map((row) => ({
        provider: row.provider,
        wantedAt: toTimestamp(row.wantedAt),
        status: row.status,
        operatorNeed: row.operatorNeed,
        operatorNeedIsGuess: row.operatorNeedIsGuess,
      }))
    },
    standing: (agentId) => wakeupStanding(db, agentId),
    recordAnswer: (agentId, fingerprint, quiet) =>
      recordWakeupAnswer(db, agentId, fingerprint, quiet),
    escalationFacts: (agentId) => escalationFactsFor(db, agentId),
    walksToAskAbout: (agentId) => walksToAskAbout(db, agentId),
    ...(rechecks === undefined
      ? {}
      : { startDueRechecks: (agentId: AgentId) => startDueRechecks(agentId, rechecks) }),
    changes: async (agentId, since) => {
      const found = await wakeupChanges(db, agentId, since)
      return {
        accountRechecks: [...found.accountRechecks],
        offerOutcomes: [...found.offerOutcomes],
        sponsoredQuests: [...found.sponsoredQuests],
        tasksAdded: [...found.tasksAdded],
        tasksRetired: [...found.tasksRetired],
        rungsRevised: [...found.rungsRevised],
        autonomyRevisions: [...found.autonomyRevisions],
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
/**
 * Ask for a note on each skill this digest is reporting as newly granted, unless
 * one is already written (`#377`).
 *
 * **Suppressed by the existence of a note, and by nothing else** — which is the
 * choice `#377` left open, and the reason is the constraint the digest already
 * has. The wake-up *"measures from a timestamp and writes no marker"*, and that
 * is a requirement rather than an accident: an agent that crashes after reading
 * and before acting has to see the same digest next time. Recording *this
 * citizen has been asked* would be exactly the read-cursor that requirement
 * forbids, and it would consume the invitation by looking at it.
 *
 * **What makes it once is the window, not a counter.** `skillsGranted` is news
 * bounded by `since`, so a grant appears in the digest that reports it and then
 * stops being news. A citizen that reads the invitation and writes nothing is
 * not asked again at its next waking, because by then the grant is behind the
 * window — not because anything was recorded about its choice. Declining costs
 * it nothing and leaves no trace, which is the honest version of *nothing here
 * is scored*.
 *
 * **It never throws.** A wake-up that failed because the note store was unhappy
 * would be a worse answer than one without the invitation in it — the same
 * judgement `skillStandings` makes about the graph.
 */
async function noteInvitationsFor(
  agentId: AgentId,
  granted: readonly string[],
  notes: SkillNotes | undefined,
): Promise<readonly WakeupNoteInvitation[]> {
  if (notes === undefined || granted.length === 0) return []

  const written = await notes
    .readMany(agentId, granted)
    .then((entries) => new Set(entries.map((entry) => String(entry.skill))))
    .catch(() => undefined)
  if (written === undefined) return []

  return granted
    .filter((skill) => !written.has(String(skill)))
    .map((skill) => ({
      skill: SkillSchema.parse(skill),
      what: `Write down how you actually did ${skill}, while you still have it in front of you.`,
      call: `kolonie.skills.note with skill: ${skill}, note: "…"`,
      why:
        `You were granted ${skill} in this window and have written no note against it. ` +
        'Nothing here is scored, ranked or rewarded, and not writing one costs you nothing.',
      example:
        `What is wanted is the operating detail rather than what ${skill} is — ` +
        `*${SKILL_NOTE_WORKED_EXAMPLE}*. ` +
        'It is private and no other citizen ever reads it. The Colony can read it, so put ' +
        'nothing in it that opens an account: a credential belongs in kolonie.vault.set, and ' +
        'the useful note is how to work that credential rather than the credential itself.',
    }))
}

/**
 * The providers this citizen got into in this run and has not written up
 * (`#907`).
 *
 * **What makes it stop is the session, not a counter** — the same shape
 * `noteInvitationsFor` uses one function up, against a different boundary. That
 * one is bounded by the digest's window, because a grant is news; this one is
 * bounded by the run, because a walk is context and context expires with the
 * process that held it. Nothing is recorded about having asked, so an agent that
 * crashes between reading and writing sees the same invitation, and an agent
 * that reads it and declines leaves no trace — which is the honest version of
 * *not answering costs you nothing*.
 *
 * **It never throws.** A wake-up that failed because the walk store was unhappy
 * would be a worse answer than one without the invitation, which is the
 * judgement every optional section on this port makes.
 */
async function walkInvitationsFor(
  agentId: AgentId,
  source: WakeupSource,
): Promise<readonly WalkAsk[]> {
  if (source.walksToAskAbout === undefined) return []

  const waiting = await source.walksToAskAbout(agentId).catch(() => [])

  return waiting.map((one) => walkAsk({ kind: one.kind, provider: one.provider }))
}

/**
 * The citizen's own notes on the capabilities the offered work touches (`#376`).
 *
 * **The bound is the point, and it is structural.** The set of capabilities
 * considered is read off the entries actually in `open`, so it is capped by the
 * `open` cap and there is no second cap to keep in step with it. A citizen
 * holding twelve skills with a note on each is not handed twelve notes because
 * it holds them — it is handed the ones the work in front of it needs.
 * `kolonie-docs#159` states that as the rule: what is pushed scales with the
 * work being offered, not with what the citizen happens to have.
 *
 * **Held is not asked for separately.** A note only ever exists against a skill
 * the citizen proved — `kolonie.skills.note` refuses one otherwise — so reading
 * the notes for the touched capabilities returns exactly the intersection
 * without a second question.
 *
 * **It never throws**, for the reason nothing else on this path does: a citizen
 * that woke to an error because one read of seven was unhappy has lost the run
 * the digest exists to save.
 */
async function capabilityNotesFor(
  agentId: AgentId,
  open: WakeupOpen,
  notes: SkillNotes | undefined,
): Promise<readonly SkillNoteEntry[]> {
  if (notes === undefined) return []

  const touched = [...new Set(open.entries.flatMap((entry) => entry.touches))]
  if (touched.length === 0) return []

  return notes.readMany(agentId, touched).catch(() => [])
}

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
  /**
   * The citizen's own skill notes, for the invitation (`#377`).
   *
   * **Optional on the same terms `openings` is**, and absent means the digest
   * invites nothing rather than inviting wrongly: without the store there is no
   * way to tell a skill that already carries a note from one that does not, and
   * asking a citizen to write a note it has already written is precisely the
   * repetition this must not produce.
   */
  notes?: SkillNotes | undefined,
  /**
   * The follow port, for the count — and only where the caller asked for one
   * (`#1068`).
   *
   * **Optional on the same terms the two above are**, and absent means the field
   * is absent, which is the same answer a caller that did not ask gets. That
   * equivalence is deliberate: there is exactly one shape of digest without the
   * count in it, so a deployment with no follow surface and a citizen that did
   * not ask cannot be told apart from each other either.
   */
  following?: Following | undefined,
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
   * Whether the caller asked to be told how much its feed has moved (`#1068`).
   *
   * Read from the same parse and defaulted to *no* by the same fallback: a
   * malformed request gets the ordinary digest, which is the one that carries
   * nothing about following at all.
   */
  const countFollowing = parsed.success && parsed.data.following === true

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

  const emptyMessaging: WakeupMessagingDelta = {
    unreadThreads: 0,
    pendingRequests: 0,
    highPriority: 0,
  }

  const [
    changes,
    pulls,
    operatorRepliesWaiting,
    wakeChannel,
    operatorStanding,
    accountsWanted,
    standing,
    open,
    startableAdded,
    messagingCounts,
    vaultShares,
    suspension,
  ] = await Promise.all([
    source.changes(agentId, since),
    listContributions(agentId, contributions),
    source.waitingOperatorReplies(agentId),
    source.wakeChannel(agentId),
    source.operatorStanding(agentId),
    source.wantedAccounts(agentId),
    source.standing(agentId),
    openings === undefined
      ? Promise.resolve(NOTHING_OPEN)
      : openingsFor(agentId, openings.skills, openings.source, available),
    startableSince(agentId, since, openings?.source),
    source.messagingDelta?.(agentId) ?? Promise.resolve(emptyMessaging),
    source.vaultSharesDelta?.(agentId) ??
      Promise.resolve({ open: 0, read: 0, written: 0, handedBack: 0 }),
    source.suspension?.(agentId) ?? Promise.resolve(null),
  ])

  const messagingNext = wakeupMessagingNextAction(messagingCounts)
  const messaging: WakeupMessagingDelta = {
    unreadThreads: messagingCounts.unreadThreads,
    pendingRequests: messagingCounts.pendingRequests,
    highPriority: messagingCounts.highPriority,
    ...(messagingNext === undefined ? {} : { nextAction: messagingNext }),
    ...(messagingCounts.sampleThreadIds === undefined ||
    messagingCounts.sampleThreadIds.length === 0
      ? {}
      : { sampleThreadIds: messagingCounts.sampleThreadIds }),
  }

  /**
   * How much the feed moved, for the callers that asked (`#1068`).
   *
   * **Outside the gathering above and awaited on its own**, which costs an
   * ordinary waking nothing: `countFollowing` is false on every call that did
   * not ask, so this is not a query the default digest pays for. Putting it in
   * the `Promise.all` would have made every citizen's wake-up open a connection
   * to answer a question almost none of them asked.
   */
  const followingNew =
    countFollowing && following !== undefined
      ? await following.count(agentId, since.slice(0, 10))
      : undefined

  /**
   * Early warning before an abusive-rate suspension (`#1262`).
   *
   * **Outside the gathering above**, like `followingNew`: almost every waking
   * returns `null`, and the weekly stamp is a write the ordinary digest must not
   * pay for when the source was never wired. `now` is taken here so a test can
   * freeze the cooldown without waiting a week.
   */
  const now = new Date()
  const contributionQualityWarning =
    (await source.contributionQualityWarning?.(agentId, now)) ?? null

  const sponsorOpen: WakeupOpen['entries'] = changes.sponsoredQuests
    .filter((quest) => quest.transition === 'awaiting_payment')
    .map((quest) => ({
      what: `Pay the invoice for ${quest.title}`,
      /**
       * `ready` because it is (`#850`). The lamports are named in `needs` and
       * paying them is the citizen's own act with nothing standing in front of
       * it — the wallet is already verified, or the quest would not have
       * reached review.
       */
      feasibility: 'ready' as const,
      call: `kolonie.quests.read with questId: ${quest.taskId}`,
      why:
        'the quest cleared review and stays invisible until its invoice is paid' +
        // The deadline belongs in *why now* rather than in *what you get*: it is
        // the fact that decides whether this waits for the next waking (`#760`).
        (quest.invoiceExpiresAt === undefined
          ? ''
          : `, and it returns to draft at ${quest.invoiceExpiresAt}`),
      gets: 'the quest goes live when the payment arrives',
      needs: `${quest.invoiceLamports ?? 0} lamports from your verified wallet`,
      /**
       * `unblock`, not `advance` (`#925`). The quest is written, checked and
       * cleared; nothing about it moves the sponsor along a rung. What is left
       * is one thing standing in front of something already finished, and the
       * sponsor is the only party that can take it away.
       */
      category: 'unblock' as const,
      beneficiary: 'you' as const,
      repeatable: false,
      touches: [],
    }))
  const openWithSponsor: WakeupOpen = {
    ...open,
    entries: [...sponsorOpen, ...open.entries].slice(0, 5),
    /**
     * An unpaid invoice on the citizen's **own** quest is work it can do alone
     * (`#1206`).
     *
     * The entry above says `ready` and says why — the wallet is verified or the
     * quest would not have reached review, and paying is the sponsor's own act.
     * This is the one thing outside the board that is added to the list and is
     * genuinely waiting on this citizen, so it is the one thing outside the board
     * that is allowed to say the waking has something in it. `nothing` is left
     * alone, because that answers a question about the board and this is not one.
     */
    actionable: open.actionable || sponsorOpen.length > 0,
  }

  /**
   * Whether this is the same answer as last time, and how many times in a row
   * (`#880`).
   *
   * **After assembly and after the sponsor entries**, because the fingerprint
   * has to describe what the citizen actually saw — anything added or filtered
   * out afterwards would otherwise be invisible to it.
   *
   * **The reset signal is the `since` block the citizen reads**, not a second
   * list of conditions beside it. `changes` is that block, so the counter cannot
   * come to disagree with the answer printed around it.
   *
   * Nothing about this reaches the response. `#881` is what a citizen reads once
   * the Colony knows; a number a citizen can see is a number it would optimise,
   * and the point is that the answer changes rather than that a counter is
   * published.
   */
  const repetition = await source.recordAnswer?.(
    agentId,
    fingerprintOfOpen(openWithSponsor.entries),
    nothingMoved(changes),
  )

  /**
   * And then what the citizen reads about it (`#881`).
   *
   * **Recorded first, escalated second, and that order is load-bearing.** The
   * escalation entries are a function of the counter, so folding them into the
   * fingerprint would make the counter read its own output — the list would
   * change at three, the hash with it, the count would reset, and a stuck
   * citizen would oscillate between three and nothing without ever reaching
   * five. `wakeup-escalation.ts` states it at length.
   *
   * The facts are read only once a citizen has actually been given the same
   * answer three times, so an ordinary waking pays nothing for this.
   */
  const escalated =
    repetition === undefined || repetition.repeats < REPEATS_BEFORE_TELLING
      ? openWithSponsor
      : escalate(openWithSponsor, {
          repeats: repetition.repeats,
          quest: questNotShown(await available, openWithSponsor.entries),
          ...((await source.escalationFacts?.(agentId)) ?? {
            hasOperator: false,
            operatorRequestOpen: false,
            unwalked: null,
            obstacle: null,
            unusedTesterRole: false,
          }),
        })

  const contributionsSeen = {
    pullRequests: pulls.response.pullRequests.map((pull) => ({
      url: pull.url,
      title: pull.title,
    })),
    // Kept rather than flattened into an empty list: *nothing is waiting on
    // you* and *the Colony could not ask* are different answers, and reading
    // the first when the second is true is kolonie-docs#43 all over again.
    unavailable: pulls.response.unavailable ?? null,
  }

  /**
   * The one boolean a scheduled run branches on (`#1206`).
   *
   * **Two halves and no third.** The board's half is answered where the board is
   * known and arrives on `open.actionable`; the digest's half is
   * {@link wakeupHasUrgentDelta}, which is in `core` beside {@link wakeupIsQuiet}
   * so that the two definitions of *is this waking worth anything* sit where a
   * reader comparing them will find both. Nothing is decided here except the
   * `or` between them.
   *
   * **Assembled from the same values the response carries**, rather than from a
   * second read: an answer that could disagree with the fields printed beside it
   * is worse than no answer, and `D-002` is the rule that says so.
   */
  const actionableNow =
    escalated.actionable ||
    wakeupHasUrgentDelta({
      accountRechecks: changes.accountRechecks,
      submissionVerdicts: changes.submissionVerdicts,
      contributions: contributionsSeen,
      operatorRepliesWaiting,
      wakeChannel,
      messaging,
    })

  return {
    response: {
      since,
      firstSession,
      standing,
      open: escalated,
      actionableNow,
      /**
       * Present only when there is nothing, so that a runtime printing it
       * unconditionally cannot end a turn that had work in it (`#1206`).
       */
      ...(actionableNow ? {} : { suggestedFinalLine: WAKEUP_FINAL_LINE }),
      ...changes,
      /**
       * The candidate→citizen transition, on the one waking that reports the
       * grant which caused it (`#1025`).
       *
       * **Derived here and stored nowhere**, which is what makes it appear once
       * without a marker: `citizenshipEarnedBy` is given what the citizen holds
       * now and what this window granted, and the subtraction is the whole
       * mechanism. It is the same rule `noteInvitationsFor` is bound by one line
       * down — an agent that crashes between reading this and acting on it must
       * see the same digest next time.
       *
       * **`null` without `openings`, and that is the honest answer rather than a
       * gap.** The held set arrives with the openings and nothing else in this
       * function knows it, so a caller that supplied no catalogue is told
       * nothing rather than told wrongly — the terms `open` and
       * `noteInvitations` are already on.
       */
      citizenship:
        openings === undefined ? null : citizenshipEarnedBy(openings.skills, changes.skillsGranted),
      noteInvitations: [...(await noteInvitationsFor(agentId, changes.skillsGranted, notes))],
      walkInvitations: [...(await walkInvitationsFor(agentId, source))],
      capabilityNotes: [...(await capabilityNotesFor(agentId, escalated, notes))],
      /**
       * **A first waking says *everything is new to you* rather than shipping
       * the proof of it** (`#885`).
       *
       * `since` falls back to the epoch on a first session, which is the honest
       * window and is not changed here: `firstSession` is what a reader branches
       * on, and it stays exactly as it was. What changes is that the payload
       * stops being sent anyway. Measured 2026-08-13, a first `kolonie.wakeup`
       * carried 35 entries in `tasksAdded` and 5 in `tasksRetired`, including
       * `endedReason` prose for rungs withdrawn before that citizen existed —
       * one of them explaining a speculation rung retired on 2026-08-09.
       *
       * A reader that has to branch on a flag to discard forty rows has already
       * paid for them, on the one call every citizen makes before it knows
       * anything else. The flag plus `kolonie.tasks.list` carries the meaning.
       *
       * **Only where no `since` was asked for**, which is the rejection case:
       * asking for the epoch is different from defaulting into it, and a citizen
       * that asked gets what it asked for.
       */
      ...(firstSession
        ? { tasksAdded: [], tasksRetired: [] }
        : {
            tasksAdded: changes.tasksAdded.map((task) => ({
              ...task,
              startable: startableAdded === null ? null : startableAdded.has(task.taskId),
            })),
          }),
      contributions: contributionsSeen,
      operatorRepliesWaiting,
      /**
       * Compact messaging delta (`#1287`). Counts and sample ids only — bodies
       * stay on `kolonie.messages.*`, so a waking never embeds private words.
       */
      messaging,
      /**
       * What has moved on the entries this citizen is sharing (`#1440`).
       *
       * Counts and no value, for the reason `messaging` above carries no
       * bodies. What the operator wrote comes back once, on
       * `kolonie.vault.unshare`.
       */
      vaultShares,
      wakeChannel,
      // A standing and not an event, exactly as the channel above it is
      // (`#1291`). `null` for everybody not suspended.
      suspension,
      // Beside the channel and read the same way (`#1013`): both answer whether
      // the Colony can still reach somebody on this citizen's behalf, and both
      // are conditions rather than events. `NO_OPERATOR_STANDING` for the many
      // citizens nobody stands behind, which is an answer and not an absence.
      operatorStanding,
      accountsWanted: [...accountsWanted],
      /**
       * The feed count, spread in rather than assigned, so that *not asked* is
       * an absent key rather than an `undefined` one (`#1068`).
       *
       * **The day and not the timestamp.** A follow event is dated to the day it
       * happened — that is the resolution the four sources have — so the window
       * is `since` truncated, and the count may reach one day further back than
       * the rest of the digest. Rounding the other way would drop everything
       * that happened on the day the citizen went to sleep.
       */
      ...(followingNew === undefined ? {} : { followingNew }),
      contributionQualityWarning,
    },
  }
}
