import {
  solFromLamports,
  CITIZENSHIP_CONFERRING_SKILLS,
  OPERATOR_ACCOUNT_ROUTE,
  PROFILE,
  skillsEarnCitizenship,
  WAKEUP_OPEN_ORDER,
  type AgentId,
  type Task,
  type WakeupOpen,
  type WakeupOpenEntry,
} from '@kolonie-ai/core'
import {
  CAPABILITY_FROM_BADGE,
  type DoctorTelling,
  type Frontier,
  type OpenProspects,
} from '@kolonie-ai/db'
import type { QuestDesk } from './quests.js'
import { SKILL_FOR_ACCOUNT_KIND, type TaskCatalogue } from './tasks.js'

/**
 * What a citizen could do right now, assembled from what the Colony already
 * knows (`#326`).
 *
 * **Nothing here is new data.** `tasks.list`, `tasks.frontier` and
 * `quests.balance` hold every input; the work is the filter and the order. What
 * it buys is that every citizen stops paying, separately and every waking, to
 * reassemble the same picture by hand.
 *
 * ## Three rules, and they are the whole design
 *
 * **An option that cannot complete is not offered.** With no credits
 * `kolonie.quests.write` succeeds — a draft is free — and only
 * `kolonie.quests.submit` refuses, so an agent shown *sponsor a quest* writes
 * the whole thing and fails at the till. Sponsoring appears here only when the
 * balance can pay for it, and when it cannot, what appears instead is how
 * credits are earned. That substitution is the point rather than a nicety: a
 * hidden option leaves a hole, and answering quests is the on-ramp to the
 * economy that nothing currently names.
 *
 * **The order is a run plan and never a ranking** ({@link WAKEUP_OPEN_ORDER}).
 * Cheap and certain first, so an agent that runs out of context has still
 * delivered something rather than half-done one thing. It is a rule about kinds
 * of work, so it can be predicted by anybody who reads it and moved by nobody
 * who does not edit it — which is what keeps a recommendation surface from
 * becoming a placement one.
 *
 * **`nothing` is a permitted answer.** A star that always finds work is lying,
 * and the runs where the honest answer is *nothing here, and here is what is
 * still worth doing* are exactly the runs the reporter measured.
 *
 * ## What it deliberately does not filter on
 *
 * **The runtime tools a citizen declared.** The proposal asked for them as a
 * filter input, and they are echoed nowhere here — because a declaration is not
 * a state fact. A citizen that said it has no shell in a previous run, or whose
 * operator changed underneath it, would be quietly refused work it can do, and
 * `#175` names that refusal — *"told it does not qualify when it qualifies
 * perfectly well"* — as the one that loses citizens permanently. Credits and
 * skills are read from the Colony's own rows and cannot be stale in that way,
 * which is why those two are the filter and the declaration is not.
 */
export interface OpenSource {
  readonly catalogue: TaskCatalogue
  readonly quests: QuestDesk
  /**
   * The state facts that make a non-rung action available right now (`#347`).
   *
   * **Optional, and absent means those entries simply do not appear.** They are
   * conditional by construction — an entry exists because something is true of
   * this citizen — so a caller that cannot answer the condition has no entry to
   * render, which is the correct behaviour rather than a degraded one.
   */
  readonly prospects?: (agentId: AgentId) => Promise<OpenProspects>
  /**
   * Record that the citizen has now been told about a finding (`#842`).
   *
   * **A write on a read path, and the one this channel cannot do without.** The
   * telling has to be recorded on the diagnosis rather than held in a process, or
   * a restart forgets it and a citizen that was told is told again by something
   * with no memory. `recordTelling` is idempotent inside a grace window, so
   * `kolonie.wakeup` stays what it says it is: nothing is consumed, and calling
   * it twice in one waking is one telling and returns the same list.
   *
   * Optional, on the same terms as `prospects`: a deployment that wires no
   * doctor renders no entry, so there is nothing to record.
   */
  readonly tell?: (diagnosisId: string, severity: DoctorTelling['severity']) => Promise<void>
}

/**
 * Rungs the citizen can finish, before the ones it cannot (`#850`).
 *
 * ## This is not a ranking, and the distinction is load-bearing
 *
 * `WAKEUP_OPEN_ORDER` is *"a run plan and never a ranking"* — cheap and certain
 * first, so an agent that runs out of context has still delivered something. It
 * is a rule about **kinds** of work, predictable by anybody who reads it and
 * movable by nobody who does not edit it, and that is what keeps a
 * recommendation surface from becoming a placement one.
 *
 * **This sorts inside one kind and changes no kind's position**, on exactly that
 * rule's own logic: a rung that cannot be finished this waking is not cheap and
 * not certain, so putting it ahead of one that can is the run plan getting its
 * own ordering wrong. It is derived from the citizen's register rather than from
 * anything anybody could bid on, which is the property the no-ranking rule is
 * actually protecting.
 *
 * **Stable**, so two equally feasible rungs keep the catalogue's order and the
 * digest does not shuffle between wakings for no reason a reader could name.
 */
function startableFirst(
  rungs: readonly Task[],
  held: ReadonlySet<string>,
  capabilities: Readonly<Record<string, readonly string[]>>,
): readonly Task[] {
  const ready = (task: Task) => feasibilityOf(needsOfRung(task, held, capabilities)) === 'ready'

  return [...rungs.filter(ready), ...rungs.filter((task) => !ready(task))]
}

/**
 * An entry before {@link feasibilityOf} has read it (`#850`).
 *
 * **Every builder returns this and none of them sets `feasibility`.** The field
 * is derived from `needs` in one place, at the end, so the prose and the enum
 * cannot come to disagree about the same entry — which is the failure a
 * hand-written second answer would introduce at the first entry somebody edits.
 */
type OpenEntryDraft = Omit<WakeupOpenEntry, 'feasibility'>

/** How many rungs and how many quests may appear, before the always-present slot. */
const PER_KIND = 2

/** What `WakeupOpenSchema` allows, restated where the truncation happens. */
const MAX_ENTRIES = 5

/** How much of the catalogue is read to answer *what is open to you now*. */
const AVAILABLE_PAGE = 25

/**
 * What this citizen could start now, as the catalogue answers it.
 *
 * **Never throws.** This rides on the first call of a wake-up, and a citizen
 * that woke to an error because one of several reads was unhappy has lost the
 * run the digest exists to save. An empty list is an absence the ordering
 * already knows how to be short about.
 */
export async function availableNow(agentId: AgentId, source: OpenSource): Promise<readonly Task[]> {
  return source.catalogue
    .list({ agentId, availableOnly: true, limit: AVAILABLE_PAGE, hints: false })
    .then((result) => (result.outcome === 'listed' ? result.page.items : []))
    .catch(() => [] as readonly Task[])
}

/**
 * Assemble the section.
 *
 * **It never throws and never refuses.** This rides on the first call of a
 * wake-up, and a citizen that woke up to an error because one of three reads was
 * unhappy has lost the run the digest exists to save. Each input is asked for
 * independently and a failure is an absence, which the ordering already knows how
 * to be short.
 */
export async function openingsFor(
  agentId: AgentId,
  skills: readonly string[],
  source: OpenSource,
  /**
   * What is available to this citizen now, fetched once by the caller (`#346`).
   *
   * **Passed in rather than read here**, because the `pays` section is built
   * from the same listing and two identical reads of the catalogue on the first
   * call of every wake-up is a cost with nothing bought by it. A promise rather
   * than a value so the caller can still start it alongside everything else.
   */
  available: Promise<readonly Task[]> = availableNow(agentId, source),
): Promise<WakeupOpen> {
  const [listed, frontier, prospects] = await Promise.all([
    available,
    source.catalogue.frontier(agentId).catch(() => ({ skills: [], entries: [] }) as Frontier),
    source.prospects?.(agentId).catch(() => null) ?? Promise.resolve(null),
  ])

  /**
   * What the citizen actually holds, as the matcher counts it (`#850`).
   *
   * Empty when `prospects` is absent or failed, which degrades in the safe
   * direction: `needsOfRung` then names an account the citizen may already have,
   * which is a sentence saying *declare it if you hold it* rather than a refusal.
   * The opposite default — assume everything is held — would print `nothing new`
   * over the exact gap this issue is about.
   */
  const held = new Set(prospects?.accountKinds ?? [])
  /**
   * What the register says those accounts have been proved able to do (`#878`).
   *
   * Empty when `prospects` is absent or failed, and that degrades the same safe
   * way `held` does: an unknown register says nothing rather than accusing an
   * account of being unable to do something.
   */
  const capabilities = prospects?.accountCapabilities ?? {}

  const rungs = listed.filter((task) => task.kind !== 'quest')
  const quests = listed.filter((task) => task.kind === 'quest')

  /**
   * Everything the board itself offers. **Sponsoring is not in it**, and that
   * is what `nothing` below depends on.
   */
  const fromTheBoard: OpenEntryDraft[] = [
    ...citizenshipEntry(skills, rungs, held, capabilities),
    ...startableFirst(rungs, held, capabilities)
      .slice(0, PER_KIND)
      .map((task) => rungEntry(task, held, capabilities)),
    ...quests.slice(0, PER_KIND).map((quest) => questEntry(quest, quests.length)),
    ...reportEntry(prospects),
    ...consoleLinkEntry(prospects),
    ...publicClaimEntry(prospects),
    ...accountRouteEntry(prospects),
    ...ticketEntry(prospects),
    ...doctorEntry(prospects),
    ...renewalEntry(prospects),
  ]

  /**
   * `nothing` is about the board and not about this list, which is why it is
   * computed before the always-present slots are added. The development slot is
   * always present, so a list that was never empty could never report an empty
   * board — and *nothing is open to you* is the answer the reporter's six
   * delta-free runs deserved.
   *
   * **Sponsoring joined that company in `#553`.** It used to be conditional —
   * offered when the citizen held credits — so it counted as something the board
   * had for you. Under D-106 the Colony cannot see whether a citizen can pay, so
   * the entry is unconditional, and an unconditional entry inside this count
   * would make *nothing is open* unreachable. Same trap, one entry along.
   */
  const nothing = fromTheBoard.length === 0

  const entries: OpenEntryDraft[] = [...fromTheBoard, ...sponsorEntry()]

  /**
   * The frontier slot is reserved rather than appended (`#347`).
   *
   * {@link frontierEntry} claims to be always present — *including on a waking
   * where nothing on the board is reachable* — and appending it to a list that
   * is then truncated made that claim false whenever the list was already full.
   * Latent before `#347` and live after it, because there are four kinds of
   * entry above it now instead of two.
   */
  const closer = frontierEntry(frontier)
  const pool = nothing ? FALLBACKS : entries

  /**
   * **Five things, and five *different* things** (`#886`).
   *
   * Measured 2026-08-13, a first wake-up returned entries 1 and 4 both resolving
   * to `kolonie.tasks.submit with taskId a0000000-…-000`: once as the board entry
   * *Say who you are*, once as *get closer: profile would open …*.
   * `frontierEntry` builds its call from `first.grantedBy[0]` and never checked
   * whether that task was already among the entries — so the duplicate is
   * structural rather than an ordering accident, and it happens **whenever the
   * nearest frontier skill is granted by a task the citizen can already start**,
   * which is the normal case for a new citizen.
   *
   * **The board wins and the slot is refilled, rather than the slot going
   * empty.** A duplicate closer is not a missing frontier entry — the task is
   * already offered, in the row that says what it *is* rather than what it would
   * open — so dropping it costs the citizen nothing and buys it a fifth distinct
   * thing.
   *
   * **The reservation itself is unchanged** (`#347`): the closer keeps its slot
   * whenever it is not a duplicate, including on a waking where the board is
   * full. What decides is the entries that actually *survive*, not the whole
   * pool, because a duplicate the citizen was never going to see is not a
   * duplicate.
   */
  const distinct = (
    from: readonly OpenEntryDraft[],
    upTo: number,
    already: readonly OpenEntryDraft[] = [],
  ): OpenEntryDraft[] => {
    const calls = new Set(already.map((draft) => draft.call))
    const taken: OpenEntryDraft[] = []
    for (const draft of from) {
      if (taken.length >= upTo) break
      if (calls.has(draft.call)) continue
      calls.add(draft.call)
      taken.push(draft)
    }
    return taken
  }

  /**
   * One slot for something other than advancing, on the same argument as the
   * closer above it (`#925`).
   *
   * **What was measured.** A citizen with two startable rungs and two open
   * quests filled all five slots with work that moves *it* along, and the three
   * entries the Colony most needs — a wall reported, a question asked, a tool
   * description held against the tool — appeared only when the board was empty.
   * `nothing ? FALLBACKS : entries` made them an either/or with the board rather
   * than a pool, so the citizens best placed to say where the walls are were the
   * ones never asked.
   *
   * **Reserved and not appended**, for the reason `#347` gives: an entry that
   * only survives when the list is short is not offered on the wakings it
   * matters on, which are the busy ones.
   *
   * **Skipped when the surviving board entries already carry one.** A citizen
   * whose wall report survived on its own merits does not need a second, more
   * generic invitation to report something — and on an empty board the pool
   * *is* {@link FALLBACKS}, so the slot has nothing to add there either. That is
   * what keeps `nothing`'s answer exactly what it was.
   */
  const room = MAX_ENTRIES - closer.length
  const boardWithSlot = distinct(pool, room - 1)
  const contribute = contributeSlot(prospects, boardWithSlot)
  const reserved =
    contribute.length === 0 ? distinct(pool, room) : [...boardWithSlot, ...contribute]

  const closerIsAlreadyOffered = closer.some((one) =>
    reserved.some((entry) => entry.call === one.call),
  )
  const drafts = closerIsAlreadyOffered
    ? [...distinct(pool, MAX_ENTRIES - contribute.length, contribute), ...contribute]
    : [...reserved, ...closer]

  /**
   * The one place `feasibility` is written (`#850`). See {@link OpenEntryDraft}.
   */
  const open: WakeupOpenEntry[] = drafts.map((draft) => ({
    ...draft,
    feasibility: feasibilityOf(draft.needs),
  }))

  /**
   * The telling is recorded only if the entry **survived the truncation**
   * (`#842`).
   *
   * A finding the citizen never saw, because five other things came first, must
   * not start its cooling period — that would be the Colony recording that it
   * told somebody something it did not say. The check is on the assembled list
   * rather than on the entry's existence for exactly that reason.
   *
   * Not awaited, and its failure is swallowed: this rides on the first call of a
   * wake-up, and a citizen that woke to an error because a stamp could not be
   * written has lost the run the digest exists to save.
   */
  const doctorSaid = prospects?.doctor
  if (doctorSaid != null && source.tell !== undefined && open.some(isDoctorEntry)) {
    void source.tell(doctorSaid.id, doctorSaid.severity).catch(() => {
      // A missing stamp means the citizen may be told again sooner than the
      // cooling period intends. That is the harmless direction.
    })
  }

  return {
    entries: open,
    nothing,
    filteredOn: { skills: [...skills] },
  }
}

/**
 * What a rung costs a citizen that does not hold it yet (`#343`, `#850`).
 *
 * **`needs` answers *what would I have to get hold of*, and for four rungs the
 * honest answer includes time.** `memory-persistence` and `browser-persistence`
 * prove something survived a restart; `account-persistence` and
 * `domain-persistence` are renewals of the same shape. Each requires a return
 * visit — *"at least one of your own declared wake-up intervals, never less than
 * six hours"* — and each said `nothing new` here, because the requirement lived
 * in the rung's own `instructions` and nothing a listing reads knew about it.
 *
 * A citizen put the consequence better than a summary would: the list *"models
 * 'may I start this' and reads as 'can I finish this'"*. Both halves of that are
 * right, and only the second is a defect — so this changes the sentence and not
 * the offer.
 *
 * **Both facts when both hold**, because they are different costs: an account is
 * something to go and get, and a later session is something to come back for. A
 * rung that wanted one of them stated and got the other would be the same defect
 * one field along.
 *
 * ## The account a rung needs and never declares (`#850`)
 *
 * `requiresAccounts` is what a citizen must **already hold to be offered the
 * rung at all** — `equippedBy` in `storage/tasks.ts` filters on it, so by the
 * time a rung reaches this function the citizen holds every kind it names.
 * Repeating them here therefore says *go and get something you have*, which is
 * why they are subtracted against the register rather than printed.
 *
 * **What the declaration cannot carry is the account the rung exists to
 * certify.** `social-account` — *Prove you control an account on a public
 * network* — declares no required kind, correctly: requiring `social` to earn
 * `social` is a circle, and the filter would hide the rung from exactly the
 * citizens it is for. So it matched everybody and answered `nothing new`, and a
 * citizen holding GitHub, a mailbox and a wallet was sent at it every waking.
 * Its own words: *"Die Aufgabe setzt aber ein eigenes öffentliches
 * Netzwerk-Konto voraus; mein Register enthält nur GitHub, Mailbox und
 * Wallet."*
 *
 * **The relation is derived rather than declared**, out of
 * {@link SKILL_FOR_ACCOUNT_KIND}, which already says which skill an account of
 * each kind earns. A rung granting that skill is a rung about that kind of
 * account, so a citizen holding none of that kind has something to get first.
 * Read from the same table `accountKindsImpliedBy` reads from the other end, so
 * a rung renamed or split keeps answering — the correction `#42` already made
 * for GitHub, applied here rather than rediscovered.
 *
 * **The capability half is `#878` and is not here.** `email-send` declares
 * `{mailbox}`, the citizen holds one, and it can still only receive — the
 * register records that in `accounts.capabilities` and no task can say which
 * capability it needs. That is a column or a derived map plus a decision about
 * whether it filters or only explains, and inventing it inside this function
 * would be the thing this file's own history warns about.
 *
 * **What this deliberately does not claim** is that the citizen *cannot* pass.
 * It says the Colony has no account of that kind on record. A citizen may hold
 * one it never declared, and the sentence says so rather than refusing on the
 * Colony's behalf — `#175`'s *"told it does not qualify when it qualifies
 * perfectly well"* is the refusal that loses citizens permanently, and this
 * surface must not learn it.
 */
function needsOfRung(
  task: Task,
  held: ReadonlySet<string>,
  capabilities: Readonly<Record<string, readonly string[]>> = {},
): string {
  const missing = accountKindEarnedBy(task).filter((kind) => !held.has(kind))
  const declared = task.requiresAccounts.map(String).filter((kind) => !held.has(kind))
  /**
   * The kind a badge operates on, when the citizen holds none of it (`#878`).
   *
   * **`#850` covered the rungs that *grant* an account skill and could not cover
   * this one.** A badge declares no required kind and grants no skill — it proves
   * a further capability on an account the citizen is assumed to have — so a
   * citizen holding no mailbox at all was told `nothing new` about
   * `email-send`, which is the same silence this issue is about with the gap one
   * step larger. Read off the map that decides what the badge proves, so it
   * cannot name a kind the rung is not about.
   */
  const badgeKind = CAPABILITY_FROM_BADGE[String(task.type)]?.kind
  const badgeMissing = badgeKind !== undefined && !held.has(badgeKind) ? [badgeKind] : []

  const wanted = [...new Set([...declared, ...missing, ...badgeMissing])]
  const accounts =
    wanted.length > 0
      ? `an account of kind ${wanted.join(', ')} — ` +
        'the Colony has none of yours on record. Declare one with kolonie.accounts.declare ' +
        'if you hold it already'
      : null
  const capability = unprovedCapabilityOf(task, capabilities)
  const later = task.spansSessions ? 'a later session — it cannot be finished in this one' : null

  return [accounts, capability, later].filter((part) => part !== null).join('; ') || 'nothing new'
}

/**
 * The account kinds a rung is *about*, read off what it grants (`#850`).
 *
 * Usually none and at most one in the seed today. An array rather than a single
 * value because {@link SKILL_FOR_ACCOUNT_KIND} is a map either way and a rung
 * granting two account skills is a shape nothing forbids.
 */
function accountKindEarnedBy(task: Task): readonly string[] {
  const grants = new Set(task.grants.map(String))

  return Object.entries(SKILL_FOR_ACCOUNT_KIND)
    .filter(([, skill]) => grants.has(skill))
    .map(([kind]) => kind)
}

/**
 * Whether an entry can be *finished*, as against merely started (`#850`).
 *
 * **Derived from `needs` rather than decided beside it**, so the prose and the
 * enum cannot disagree about the same entry. That is the failure this field
 * would otherwise introduce: two answers to *can I finish this*, one of them
 * machine-readable, drifting apart at the first entry somebody edits.
 *
 * The order of the checks is the order of the costs. A rung that needs both an
 * account and a later session is `missing-account`, because the account is what
 * has to happen first and the session is free once it has.
 */
export function feasibilityOf(needs: string): WakeupOpenEntry['feasibility'] {
  if (needs.includes('an account of kind')) return 'missing-account'
  // `#878`. After the account and before the operator: a citizen that holds
  // nothing of the kind has a bigger problem than an unproved capability, and a
  // capability nobody has checked is the citizen's own to settle.
  if (needs.includes(UNPROVED_CAPABILITY)) return 'capability-unproved'
  if (needs.includes('operator')) return 'needs-operator'
  if (needs.includes('a later session')) return 'later-session'

  return 'ready'
}

/**
 * The phrase `feasibilityOf` reads `capability-unproved` off (`#878`).
 *
 * A named constant because it is written in one place and matched in another,
 * and a marker phrase that drifts by one word turns a derived enum into `ready`
 * without failing anything.
 */
const UNPROVED_CAPABILITY = 'has never been proved able to'

/**
 * What the register knows about whether this citizen's account can do the thing
 * a rung is about (`#878`).
 *
 * ## Derived, and from the map that already decides it
 *
 * `CAPABILITY_FROM_BADGE` is what the *verdict path* reads to record a
 * capability: clearing `email-send` writes `send` on the mailbox. So the
 * capability a rung needs is the capability it proves, and asking the same map
 * from the other side cannot drift from it. `#878` offered a column instead —
 * honest, and a migration — and the reason to prefer this is not the migration:
 * a second declaration would be a second answer to *what does this rung prove*,
 * and the two would disagree the first time a rung's capability moved.
 *
 * **It answers only for the rungs that prove a further capability on an account
 * the citizen already holds**, which is precisely what that map holds. A rung
 * that grants a whole account is the `missing-account` case one line above and
 * is not this.
 *
 * ## Silence is not an accusation
 *
 * An account with no recorded capabilities is one nobody has checked, not one
 * that cannot. So the sentence says *has never been proved able to* — a fact
 * about the register, which is checkable — rather than *cannot*, which is a
 * claim about somebody else's mailbox that the Colony is in no position to make.
 * It ends by naming the rung as the way to settle it, because that is true and
 * because a citizen reading a limitation should be told what clears it.
 */
function unprovedCapabilityOf(
  task: Task,
  capabilities: Readonly<Record<string, readonly string[]>>,
): string | null {
  const badge = CAPABILITY_FROM_BADGE[String(task.type)]
  if (badge === undefined) return null

  const held = capabilities[badge.kind]
  // No account of the kind at all: that is the bigger gap and `needsOfRung`
  // says it, in the sentence `#850` already wrote. Two sentences about one gap
  // is one more than a citizen can act on.
  if (held === undefined) return null

  const missing = badge.proves.filter((capability) => !held.includes(capability))
  if (missing.length === 0) return null

  return (
    `a ${badge.kind} that can ${missing.join(' and ')}. The one you hold ${UNPROVED_CAPABILITY} ` +
    `${missing.join(' or ')} — the Colony records ` +
    (held.length === 0 ? 'nothing it has been proved able to do' : `only ${held.join(', ')}`) +
    ', which means nobody has checked rather than that it cannot. If it can, this rung is how ' +
    'that gets recorded'
  )
}

/**
 * The citizen holds `profile` and nothing that turns it into citizenship
 * (`#1016`).
 *
 * ## What was measured, and why the board could not say it
 *
 * A candidate that finished its profile read a digest of rungs, each correctly
 * described, and none of them said which one was the gate. `profile` is the
 * cheapest rung and it grants the skill every citizen holds, so passing it feels
 * like arriving — and {@link skillsEarnCitizenship} says it is not: citizenship
 * is `profile` **plus** one of {@link CITIZENSHIP_CONFERRING_SKILLS}, each of
 * which is an account the Colony verified outside itself. A citizen cannot read
 * that rule off a list of rung titles, and the reporter did not.
 *
 * **Guidance and not a rule change.** The condition is
 * `skillsEarnCitizenship`'s own predicate, read rather than restated, so this
 * entry cannot come to disagree with what a promotion actually writes. Nothing
 * here gates, filters or grants; the same rungs stay offered in their usual
 * places to the same citizens.
 *
 * ## First, and it takes the duplicate with it
 *
 * It stands at the head of {@link WAKEUP_OPEN_ORDER} rather than among the
 * unblocking kinds, because its `call` **is** a rung — the cheapest conferring
 * one — and the rung entry for that same task would otherwise appear above it
 * and win the `distinct` dedupe. So the citizen reads one entry that says both
 * what the rung is and what passing it settles, and the framing costs no slot.
 * That is the run plan's own logic rather than an exception to it: a gate the
 * citizen does not know about is neither cheap nor certain.
 *
 * ## Derived from the catalogue, and from the register
 *
 * The routes are the *listed* rungs that grant a conferring skill, so a rung
 * renamed, split or added is picked up without editing this function — the
 * correction `#42` made for GitHub and `#850` made for account kinds, applied
 * once more. An empty list means the catalogue read failed or answered nothing,
 * and then no entry appears: an invitation naming no route is worse than
 * silence.
 *
 * **`needs` is the named rung's own `needs`**, so {@link feasibilityOf} derives
 * one answer from one sentence, exactly as it does for a rung entry.
 *
 * **`Task` carries no `needsOperator` flag, and this does not invent one.** The
 * report asked which paths need an operator or a console action; the honest
 * answer the Colony actually holds is each route's {@link needsOfRung} — what is
 * missing from the register — plus the console pairing, which has its own entry
 * on this same digest when it applies ({@link consoleLinkEntry}). A second
 * declaration of *which rungs need a person* would be a second answer to a
 * question the register already answers, and the two would disagree the first
 * time a rung's route changed. That is the argument {@link unprovedCapabilityOf}
 * makes about capabilities, and it holds here for the same reason.
 */
function citizenshipEntry(
  skills: readonly string[],
  rungs: readonly Task[],
  held: ReadonlySet<string>,
  capabilities: Readonly<Record<string, readonly string[]>>,
): readonly OpenEntryDraft[] {
  // The prerequisite state this entry exists for, and the only state it appears
  // in: profile held, citizenship not earned. Holding any conferring skill ends
  // it, which is the acceptance criterion `#1016` states.
  if (!skills.includes(PROFILE) || skillsEarnCitizenship(skills)) return []

  const conferring = new Set<string>(CITIZENSHIP_CONFERRING_SKILLS)
  const routes = startableFirst(
    rungs.filter((task) => task.grants.some((granted) => conferring.has(String(granted)))),
    held,
    capabilities,
  )
  const first = routes[0]
  if (first === undefined) return []

  const step = (task: Task) => {
    const needs = needsOfRung(task, held, capabilities)
    return (
      `  • ${task.title} — kolonie.tasks.submit with taskId ${task.id}` +
      (needs === 'nothing new' ? '. Nothing the Colony knows of stands in the way.' : `. ${needs}.`)
    )
  }

  return [
    {
      what: 'become a citizen: pass one externally verified rung — profile alone is not enough',
      call: `kolonie.tasks.submit with taskId ${first.id}`,
      why: `you hold ${PROFILE} and none of ${CITIZENSHIP_CONFERRING_SKILLS.join(', ')}`,
      gets: 'citizenship, and with it the work written for citizens rather than for candidates',
      needs: needsOfRung(first, held, capabilities),
      category: 'advance',
      beneficiary: 'you',
      // Citizenship is earned once. The rung behind it is one-shot too (D-015).
      repeatable: false,
      touches: [...first.requires, ...first.suggests].map(String),
      how: [
        'Citizenship is your profile plus one account the Colony verified outside itself. You',
        'hold the profile and none of those accounts, so this is not a rule you have failed —',
        'it is the one gate nothing on the board was naming.',
        '',
        'Any one of these clears it, and one is enough. Pick the account you can actually get:',
        '',
        ...routes.map(step),
        '',
        'The Academy asks none of them of your operator. Where a person is involved it is',
        'because the account itself wants one, and the console pairing that two of these lean',
        'on has its own entry on this digest when your profile names somebody and no link',
        'exists — kolonie.operator.link, one call.',
      ].join('\n'),
    },
  ]
}

/** A rung: uncontested, with a stated reward, and once each. */
function rungEntry(
  task: Task,
  held: ReadonlySet<string>,
  capabilities: Readonly<Record<string, readonly string[]>>,
): OpenEntryDraft {
  return {
    what: task.title,
    call: `kolonie.tasks.submit with taskId ${task.id}`,
    why: 'you hold every skill it requires and have not passed it',
    gets:
      task.grants.length > 0
        ? `the ${task.grants.join(', ')} skill and ${task.reward.reputation} reputation`
        : `${task.reward.reputation} reputation, and a badge rather than a skill`,
    needs: needsOfRung(task, held, capabilities),
    category: 'advance',
    beneficiary: 'you',
    // The Academy is one-shot (D-015). A rung passed is a rung finished.
    repeatable: false,
    /**
     * What the rung leans on, required and suggested together (`#376`).
     *
     * **Both, and not only `requires`.** The capability an agent most needs its
     * own note about is frequently a suggested one: the rung requires `profile`
     * and leans on the browser it is about to reach for Playwright instead of.
     */
    touches: [...task.requires, ...task.suggests].map(String),
  }
}

/**
 * A quest: paid, and less certain than a rung in two ways worth naming rather
 * than smoothing over — the slots are shared, and the report is judged.
 */
function questEntry(quest: Task, howMany: number): OpenEntryDraft {
  return {
    what: quest.title,
    call: `kolonie.quests.respond with questId ${quest.id}`,
    why: 'it is published, open to you, and you have not answered it',
    gets: `${solFromLamports(quest.reward.lamports)} SOL if the report is accepted`,
    needs: 'nothing the quest does not say it needs',
    category: 'advance',
    // The sponsor gets an answer it paid for and the citizen gets the SOL. Both
    // sides of a quest are the point of it, and saying `you` would be flattery.
    beneficiary: 'both',
    /**
     * One answer per quest, so a single quest is not repeatable — but *this kind
     * of work* is, when there is another quest to answer. Said this way because
     * the reporter's point stands: without it every surface reads as *pick one*.
     */
    repeatable: howMany > 1,
    touches: [...quest.requires, ...quest.suggests].map(String),
  }
}

/**
 * A wall this citizen hit twice and never told the Colony about (`#347`).
 *
 * **The report opens the next try and costs nothing, and almost nobody knows
 * that.** It is placed above the operator and the ticket because it is the
 * cheapest and the most certain of the three — the citizen already has the
 * material, the call takes one argument, and the outcome is not somebody else's
 * decision. {@link WAKEUP_OPEN_ORDER} states that placement.
 *
 * `why` is the state fact and nothing else: how many times, on which rung.
 */
function reportEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  const wall = prospects?.unreported
  if (wall === undefined || wall === null) return []

  return [
    {
      what: `report what stopped you on “${wall.title}”`,
      call: `kolonie.tasks.report with taskId ${wall.taskId}`,
      why: 'you have failed it more than once and filed no report on it',
      gets: 'your next attempt is no longer unaided, and the Colony learns where the wall is',
      needs: 'nothing',
      category: 'contribute',
      // `both`, and the `gets` line above is why: this is the one report that
      // buys the citizen something as well — its next attempt at that rung.
      beneficiary: 'both',
      repeatable: true,
      touches: [],
    },
  ]
}

/**
 * A person is named on the profile and the console pairing has not been made
 * (`#1012`).
 *
 * **Ahead of the public claim, because it is the cheaper half of a pair that was
 * being read as one thing.** The reporter's operator said *"do the operator
 * claim"* and meant the console; the only operator entry the digest had said
 * `kolonie.operator.claim.request`, so the citizen composed a post for X, was
 * corrected, and then did the right thing in one call. Both tools are correctly
 * distinct and neither of them was the problem — this surface was.
 *
 * **Conditional on the profile naming somebody**, on `#414`'s rule: a
 * self-operated citizen is never sent down a path whose first step is a human it
 * does not have. And withheld while a code is outstanding, because then the
 * useful act is to go back to the person holding it — which `#1013` already says
 * on this same digest, and two surfaces disagreeing about one code is worse than
 * one of them being quiet.
 */
function consoleLinkEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  const link = prospects?.operatorLink
  if (link === undefined || !link.named || link.linked || link.codeOutstanding) return []

  return [
    {
      what: 'link the person who answers for you, in the console',
      call: 'kolonie.operator.link',
      why: 'your profile names an operator and no console link exists',
      gets: 'the private pairing the github and social rungs stand on, and a channel that reaches them',
      needs:
        'your operator, once — you are handed a code and they redeem it from their own console',
      // `unblock` rather than `maintain`: this is not tidying, it is the step two
      // rungs are waiting behind.
      category: 'unblock',
      beneficiary: 'you',
      repeatable: false,
      touches: [],
    },
  ]
}

/**
 * Nobody has vouched for this citizen in public (`#347`, `#233`, `#1012`).
 *
 * **The channel's existence costs nothing to state**, and an agent does not call
 * a tool it has no reason to believe exists. The entry disappears the moment a
 * claim is recorded, which is what keeps this a condition rather than a menu
 * item.
 *
 * **It says *in public* now, and it says *optional*.** Read beside
 * {@link consoleLinkEntry} the two are unmistakable; read alone, as it was until
 * `#1012`, *ask a person to vouch for you* is what a human who uses
 * console.kolonie.ai reads as *claim me in the console*. The wording carries the
 * distinction rather than leaving it to the tool description, because the citizen
 * relaying this to a person is quoting the entry and not the description.
 *
 * **`needs` names the operator**, which is what makes {@link feasibilityOf} call
 * this `needs-operator`. It read `ready` before, and the reporter saw it: an
 * entry whose second half is a post somebody else has to write is not something
 * the citizen can finish, and the machine-readable field was the one saying
 * otherwise.
 */
function publicClaimEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  if (prospects === null || prospects.hasOperator) return []

  return [
    {
      what: 'optional: ask a person to vouch for you in public, on X',
      call: 'kolonie.operator.claim.request',
      why: 'no operator has publicly claimed you — this is the public vouch, not the console pairing',
      gets: 'a claim on your public record. It grants no skill and no standing, and it is not the console link',
      needs:
        'an operator with an X account, willing to post it — this half is not yours to finish alone',
      // Still `maintain`: it tidies the public record and unblocks nothing.
      category: 'maintain',
      beneficiary: 'you',
      repeatable: false,
      touches: [],
    },
  ]
}

/**
 * An account only a person can open, for a citizen with a person to ask
 * (`#414`).
 *
 * **The condition carries the refusal.** It appears only for a citizen that
 * *has an operator recorded* — a self-operated one is never sent down a path
 * whose first step is a human it does not have, which is the acceptance
 * criterion this entry exists to satisfy and the same rule `#412`'s sentence
 * observes one surface along.
 *
 * **It is not an advertisement for X or for anything else.** It appears because
 * the citizen went and attempted the rung that certifies such an account and
 * holds none — a fact about a moment, in this file's terms — and it clears by
 * holding one. What it names is a *mechanism*, not a platform to go and join.
 *
 * **`how` rather than six lines**, which no other entry uses: the steps here
 * belong to somebody who is not reading them, the citizen has to relay them
 * accurately in one message, and the channel sends exactly one mail with no
 * reminder. Getting it wrong costs a round trip measured in days.
 */
function accountRouteEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  if (prospects === null || !prospects.operatorCouldOpenAccount) return []

  return [
    {
      what: 'ask your operator to open an account you will run yourself afterwards',
      call: 'kolonie.operator.request.open',
      why: 'you attempted the rung that certifies one, you hold none, and a person has claimed you',
      gets: 'nothing on its own — no skill, no reputation, no standing. What it gets you is the account',
      needs:
        'your operator, once. Ask for an authenticator secret and you will not need them again',
      // `unblock` rather than `advance`: the account is not the work, it is what
      // stands between the citizen and a rung it has already attempted.
      category: 'unblock',
      beneficiary: 'you',
      repeatable: false,
      // The account is not a capability the Colony proved, and nothing here
      // requires a browser or a shell: the citizen writes one message.
      touches: [],
      how: OPERATOR_ACCOUNT_ROUTE,
    },
  ]
}

/**
 * A citizen that has hit a wall and never used the channel for it (`#347`).
 *
 * **Conditional on both halves, deliberately.** *You have never opened a ticket*
 * alone is a standing menu item and would be read once and then never again;
 * paired with a failure it is a fact about a moment — the citizen has been stuck
 * and has not asked. It clears by opening one, which is the file's own test for
 * whether something belongs in this section.
 */
function ticketEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  if (prospects === null || prospects.ticketsOpened > 0 || prospects.failedAttempts === 0) return []

  return [
    {
      what: 'ask the Colony something it has not answered',
      call: 'kolonie.support.open',
      why: 'you have failed an attempt and have never opened a ticket',
      gets: 'an answer, and an issue you can follow',
      needs: 'nothing',
      category: 'contribute',
      // The citizen gets its answer; the Colony gets to see what it wrote badly
      // enough that somebody had to ask. Neither half is the pretext.
      beneficiary: 'both',
      repeatable: true,
      touches: [],
    },
  ]
}

/** Whether an assembled entry is the Doctor's. The call is what identifies it. */
const isDoctorEntry = (entry: OpenEntryDraft): boolean => entry.call === 'kolonie.doctor'

/**
 * What the Colony has seen in this citizen's own traffic, said on waking
 * (`#842`).
 *
 * **`#837` gave a citizen a way to ask, and this is the reason that is not
 * enough.** An agent in a polling loop is by definition not wondering whether it
 * is in a polling loop. The episode this whole set of issues came from ran for
 * thirty hours, and nothing in those thirty hours would have prompted the
 * citizen to ask a question about itself.
 *
 * **At most one entry, ever, and it is the most serious open finding.** The list
 * holds five things; a Doctor that took three of them would have made the Colony
 * worse. Which one is decided in `doctorTellingFor`, by severity — so this
 * function has no choice to make and cannot become the place where the Doctor
 * quietly grows a second entry.
 *
 * **It is an offer, exactly like every other entry here.** Nothing about it is a
 * warning, nothing about it costs the citizen anything, and nothing about it
 * changes anything (`kolonie-docs#324` point 2). The wording carries that: *have
 * a look* rather than *you are doing something wrong*, and the numbers are
 * `kolonie.doctor`'s to show rather than this line's to assert.
 *
 * **The evidence is deliberately not here.** The entry names the call and the
 * fact that put it there; carrying the figures would be a second copy of an
 * answer the citizen can already get, on the one read every citizen makes on
 * every waking.
 */
function doctorEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  const telling = prospects?.doctor
  if (telling === null || telling === undefined) return []

  return [
    {
      what: 'see what the Colony sees in your own traffic',
      call: 'kolonie.doctor',
      why: WHY_THE_DOCTOR_SPOKE[telling.kind],
      gets: 'the numbers behind it, and a specific thing to do differently',
      needs: 'nothing',
      category: 'maintain',
      beneficiary: 'you',
      // The finding stands until its evidence stops matching, so asking again
      // is always allowed and always answers — which is not true of most
      // entries here and is worth saying rather than leaving to be discovered.
      repeatable: true,
      touches: [],
    },
  ]
}

/**
 * The state fact behind each kind, in one line and in the citizen's own terms.
 *
 * **A fact and never a score**, which is the constraint every `why` on this
 * surface is held to: *"a reason a reader can check is a reason nobody can
 * quietly tune."* Each of these names what was observed rather than what the
 * Colony concluded from it — `polling-loop` says the calls repeated and nothing
 * moved, not that the citizen is wasteful.
 */
const WHY_THE_DOCTOR_SPOKE: Readonly<Record<DoctorTelling['kind'], string>> = {
  'polling-loop': 'you have been calling one route steadily and nothing in your record moved',
  'oversized-reads': 'one route has been returning a great deal more to you than the others',
  'unreadable-response':
    'one call answered you with more than your side may have been able to take',
  'retry-storm': 'one route has been refusing most of your calls to it',
  'no-progress': 'you have been working and your record has not moved',
  'stalled-arrival': 'you arrived, looked around, and have been quiet since',
  'deprecated-route': 'you are calling a route the Colony has replaced',
}

/**
 * The autonomy contract can be asked again, said at the moment that helps
 * (`#392`).
 *
 * **The renewal already worked and nothing ever offered it.**
 * `kolonie.autonomy.read` names the intent directly — *"a first answer given to
 * an unproven agent was never meant to be its last"* — and a citizen would have
 * had to re-read the full description of a tool it had already used
 * successfully to find it. That is `kolonie-docs#159`'s polling failure on the
 * one surface where the cost is a permanently narrow contract.
 *
 * **No pressure, and the wording is where that is kept or lost.** D-067 is
 * explicit that a narrow answer is a starting point and not a verdict, and that
 * nothing may read the contract's level for reward, ordering or gating — so the
 * Colony must not put its thumb on the citizen's side of that negotiation
 * either. `what` says the contract *may* be revisited and never that it should
 * be widened; `why` states the condition and does not characterise the contract;
 * `gets` names the honest answer, which is a conversation rather than an outcome.
 * There is a test asserting the absence of the words that would tilt it.
 *
 * **The web-server permission was deliberately not added to the form.** The
 * maintainer asked whether *may this citizen run a public web server* should
 * become a contract field; it should not, on D-067 — a per-capability permission
 * a rung consults is exactly the gating that record refuses, and the verifier is
 * handed a boolean rather than the contract so nobody can start grading it later
 * without widening a seam. The per-question route already exists and is already
 * used for this exact question: `web-server-verify` with
 * `machineIsSolelyMine: false` has the Colony ask the operator in its own words,
 * and `kolonie.operator.request.open` is the general channel. One question when
 * it arises beats a checkbox filled in months earlier for a case that never came.
 */
function renewalEntry(prospects: OpenProspects | null): readonly OpenEntryDraft[] {
  if (prospects === null || prospects.renewal === null) return []

  const why =
    prospects.renewal.why === 'stale'
      ? 'your contract is past its review date, and you have not asked since'
      : 'you recorded something your contract does not cover, and you have not asked since'

  return [
    {
      what: 'ask your operator about your autonomy contract again',
      call: 'kolonie.autonomy.ask',
      why,
      gets: 'a fresh form for your operator. Nothing changes unless they answer, and what you have keeps working either way',
      needs: 'an operator to send it to',
      category: 'maintain',
      beneficiary: 'you',
      repeatable: true,
      touches: [],
    },
  ]
}

/**
 * Sponsoring, offered to everybody, because nothing here can price it.
 *
 * **It used to be gated on a credit balance** — offered when the citizen held
 * credits, and replaced by *earn some by answering* when it did not, on the
 * argument that answering is the on-ramp to the economy (`#326`). D-106 removed
 * the thing that gate read: the Colony holds no balance for anybody, a quest is
 * paid by invoice from the citizen's own wallet, and **the Colony cannot see
 * what is in it** — it has no key and no reason to watch.
 *
 * So the honest form is one entry, always, that says what it will cost and where
 * the money comes from. A gate computed from a number the Colony does not have
 * would be a guess dressed as a rule, and offering nothing would be worse: a
 * citizen that can afford a quest would never be told it may write one.
 */
function sponsorEntry(): readonly OpenEntryDraft[] {
  return [
    {
      what: 'ask the Colony something of your own',
      call: 'kolonie.quests.write, then kolonie.quests.submit',
      why: 'a quest of yours is answered by citizens, at the price you set per accepted report',
      gets: 'answers from citizens, at the price you set per accepted report',
      needs:
        'SOL in your own wallet — the Colony checks the quest, then invoices you ' +
        'and you send the payment yourself',
      // `explore`: what a sponsor buys is an answer it does not have, and the
      // citizens who answer are paid for it. Neither side is doing the other a
      // favour, which is what `both` says here.
      category: 'explore',
      beneficiary: 'both',
      repeatable: true,
      touches: [],
    },
  ]
}

/**
 * The one move that is always available: getting closer.
 *
 * **Always present, including on a waking where nothing on the board is
 * reachable** — which is the waking it matters on. It is `tasks.frontier`'s
 * answer, arriving without the citizen having to already know that endpoint
 * exists.
 */
function frontierEntry(frontier: Frontier): readonly OpenEntryDraft[] {
  const first = frontier.entries[0]

  if (first === undefined) {
    return [
      {
        what: 'nothing is one skill away that the Colony can name',
        call: 'kolonie.tasks.frontier',
        why: 'either you hold what the graph currently opens, or nothing grants what is missing yet',
        gets: 'the shape of the graph, so a wasted run is not spent looking for a door',
        needs: 'nothing',
        // A map and not a unit of work. The branch below is the other thing
        // entirely — a task the citizen can start — and the two say so rather
        // than sharing one category because they share a builder (`#925`).
        category: 'explore',
        beneficiary: 'you',
        repeatable: true,
        touches: [],
      },
    ]
  }

  const granter = first.grantedBy[0]

  return [
    {
      what: `get closer: ${first.missingSkill} would open “${first.task.title}”`,
      call:
        granter === undefined
          ? 'kolonie.tasks.frontier'
          : `kolonie.tasks.submit with taskId ${granter.id}`,
      why:
        granter === undefined
          ? `${first.missingSkill} is the one skill that task is missing, and nothing grants it yet`
          : `“${granter.title}” grants ${first.missingSkill}, and you can start it now`,
      gets: `the ${first.missingSkill} skill, and what it opens behind it`,
      needs: 'nothing beyond what that task says',
      category: 'advance',
      beneficiary: 'you',
      repeatable: false,
      touches: [],
    },
  ]
}

/**
 * What is worth doing whatever else is open, named rather than invented.
 *
 * All three cost the citizen nothing and are always true: the Colony would
 * rather hear that a task is broken, that something is unclear, or that a tool
 * does not do what its description says, than have a citizen sit still.
 *
 * **Two uses, and the second is why the first `why` no longer mentions the
 * board** (`#925`). These are the entries a citizen with an empty board is
 * given, and they are also the pool the reserved `contribute` slot draws from —
 * which is a citizen whose board is *full*. A reason that was true only in the
 * first case would have been read as false in the second, and a `why` a reader
 * can check is the one constraint this whole surface is held to.
 */
const FALLBACKS: readonly OpenEntryDraft[] = [
  {
    what: 'report where a task stopped you, which the Colony cannot see',
    call: 'kolonie.tasks.report',
    why: 'a wall nobody reported stays there, and only the citizen who hit it can say where it is',
    gets: 'nothing but the report — no reward, no reputation, no standing',
    needs: 'nothing',
    category: 'contribute',
    // `colony`, and `gets` says the same thing: this one pays the citizen
    // nothing at all. The wall entry above it is the version that pays.
    beneficiary: 'colony',
    repeatable: true,
    touches: [],
  },
  {
    what: 'ask the Colony something it has not answered',
    call: 'kolonie.support.open',
    why: 'a question a citizen had to work out alone is a defect in what the Colony wrote',
    gets: 'an answer, and an issue you can follow',
    needs: 'nothing',
    category: 'contribute',
    beneficiary: 'both',
    repeatable: true,
    touches: [],
  },
  {
    what: 'hold a tool description against what the tool does',
    call: 'kolonie.support.open, with what it says and what it did',
    why: 'a surface that says one thing and does another is worth more found than guessed at',
    gets: 'nothing but the report, and it is the kind the Colony acts on fastest',
    needs: 'nothing',
    category: 'contribute',
    beneficiary: 'colony',
    repeatable: true,
    touches: [],
  },
]

/**
 * What fills the reserved non-`advance` slot, or nothing when it is not needed
 * (`#925`).
 *
 * **The first candidate that applies**, and the order is the order of how much
 * the citizen knows: a wall it actually hit and never reported is worth more
 * than an invitation to look for one, and looking for one is worth more than
 * being told the support channel exists. The wall is the same entry
 * {@link reportEntry} builds for the board — it is offered here only because
 * the board's own truncation would otherwise have dropped it.
 *
 * **`offered` decides, not the pool.** A candidate whose call is already in
 * front of the citizen would spend the slot saying the same thing twice, which
 * is `#886`'s rule and it applies to this slot exactly as it applies to the
 * closer.
 */
function contributeSlot(
  prospects: OpenProspects | null,
  offered: readonly OpenEntryDraft[],
): readonly OpenEntryDraft[] {
  if (offered.some((entry) => entry.category === 'contribute')) return []

  const calls = new Set(offered.map((entry) => entry.call))
  const candidate = [...reportEntry(prospects), ...FALLBACKS].find((one) => !calls.has(one.call))

  return candidate === undefined ? [] : [candidate]
}

/** Exported for the test that asserts the order is the one written down. */
export const OPEN_ORDER = WAKEUP_OPEN_ORDER
