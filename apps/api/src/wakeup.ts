import {
  CITIZEN_RAISED_WAKE_EVENTS,
  SkillSchema,
  WakeupRequestSchema,
  walkAsk,
  type AgentId,
  type WakeupOpen,
  type Task,
  type WakeupResponse,
  type SkillNoteEntry,
  type WalkAsk,
  type WakeupNoteInvitation,
  type WakeupStanding,
  type WakeupWakeChannel,
  type WakeupWantedAccount,
} from '@kolonie-ai/core'
import {
  countUnreadOperatorNotes,
  countWaitingOperatorReplies,
  escalationFactsFor,
  walksToAskAbout,
  previousSessionStart,
  recordWakeupAnswer,
  wakeChannelOf,
  wakeTargetFor,
  wakeupChanges,
  wakeupStanding,
  wantedAccountsFor,
  type Database,
} from '@kolonie-ai/db'

/** `timestamptz` comes back as a string; the digest's shape wants a `Timestamp`. */
const toTimestamp = (value: string): WakeupWantedAccount['wantedAt'] =>
  new Date(value).toISOString() as WakeupWantedAccount['wantedAt']
import { listContributions, type ContributionDependencies } from './contributions.js'
import { availableNow, openingsFor, type OpenSource } from './open.js'
import { fingerprintOfOpen, nothingMoved } from './wakeup-repetition.js'
import { escalate, questNotShown, REPEATS_BEFORE_TELLING } from './wakeup-escalation.js'
import { startDueRechecks, type RecheckDependencies } from './recheck.js'
import { SKILL_NOTE_WORKED_EXAMPLE, type SkillNotes } from './skills.js'

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
   * How many exchanges the operator answered last and the citizen has not
   * acted on (`#683`).
   *
   * **Its own call, for the reason `unreadOperatorNotes` is one.** An answer
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
   * What the operator has marked and the citizen has not got (`#581`).
   *
   * **Its own call, for the reason `unreadOperatorNotes` is one.** A mark is an
   * open request rather than news: an operator who marked something a week ago
   * is still waiting, and folding it into `changes` would make it vanish for a
   * citizen that asked for a narrow window.
   */
  wantedAccounts(agentId: AgentId): Promise<readonly WakeupWantedAccount[]>
  /**
   * Where the citizen stands (`#344`).
   *
   * **Its own call, for the reason `unreadOperatorNotes` is one**: everything
   * `changes` answers is news inside a window, and a standing is not news. Given
   * to `changes` it would have to either ignore its own `since` or report a
   * position as though it were a movement.
   */
  standing(agentId: AgentId): Promise<WakeupStanding>
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
      | 'operatorNotesUnread'
      | 'operatorRepliesWaiting'
      | 'wakeChannel'
      | 'accountsWanted'
      | 'open'
      | 'standing'
      | 'pays'
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
  filteredOn: { skills: [] },
}

/** Wire the digest to a real database. */
export function databaseWakeup(db: Database, rechecks?: RecheckDependencies): WakeupSource {
  return {
    previousSessionStart: (agentId) => previousSessionStart(db, agentId),
    unreadOperatorNotes: (agentId) => countUnreadOperatorNotes(db, agentId),
    waitingOperatorReplies: (agentId) => countWaitingOperatorReplies(db, agentId),
    wakeChannel: async (agentId) => {
      const channel = await wakeChannelOf(db, agentId)
      if (channel === undefined) return null

      /**
       * **Asked of the function that decides it, rather than counted here.** A
       * replacement is open exactly when `wakeTargetFor` would knock the
       * challenge instead of the registered row, and `challengeId` is how it
       * says so — a second reading of the challenge table beside it would be a
       * derivable fact stored twice (`D-002`).
       */
      const target = await wakeTargetFor(db, agentId)

      // `provedAt` is dropped rather than carried: see `WakeupWakeChannelSchema`.
      return {
        url: channel.url,
        lastKnockedAt: channel.lastKnockedAt,
        lastOutcome: channel.lastOutcome,
        consecutiveFailures: channel.consecutiveFailures,
        replacementOpen: target?.challengeId !== undefined,
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

  const [
    changes,
    pulls,
    operatorNotesUnread,
    operatorRepliesWaiting,
    wakeChannel,
    accountsWanted,
    standing,
    open,
    startableAdded,
  ] = await Promise.all([
    source.changes(agentId, since),
    listContributions(agentId, contributions),
    source.unreadOperatorNotes(agentId),
    source.waitingOperatorReplies(agentId),
    source.wakeChannel(agentId),
    source.wantedAccounts(agentId),
    source.standing(agentId),
    openings === undefined
      ? Promise.resolve(NOTHING_OPEN)
      : openingsFor(agentId, openings.skills, openings.source, available),
    startableSince(agentId, since, openings?.source),
  ])

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

  return {
    response: {
      since,
      firstSession,
      standing,
      open: escalated,
      ...changes,
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
      operatorRepliesWaiting,
      wakeChannel,
      accountsWanted: [...accountsWanted],
    },
  }
}
