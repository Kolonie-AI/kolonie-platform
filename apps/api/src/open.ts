import {
  WAKEUP_OPEN_ORDER,
  type AgentId,
  type Task,
  type WakeupOpen,
  type WakeupOpenEntry,
} from '@kolonie-ai/core'
import type { Frontier } from '@kolonie-ai/db'
import type { QuestDesk } from './quests.js'
import type { TaskCatalogue } from './tasks.js'

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
}

/** How many rungs and how many quests may appear, before the always-present slot. */
const PER_KIND = 2

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
): Promise<WakeupOpen> {
  const [listed, frontier, purse] = await Promise.all([
    source.catalogue
      .list({ agentId, availableOnly: true, limit: 25, hints: false })
      .then((result) => (result.outcome === 'listed' ? result.page.items : []))
      .catch(() => [] as readonly Task[]),
    source.catalogue.frontier(agentId).catch(() => ({ skills: [], entries: [] }) as Frontier),
    source.quests.balance(agentId).catch(() => ({ balance: 0, reserved: 0, available: 0 })),
  ])

  const rungs = listed.filter((task) => task.kind !== 'quest')
  const quests = listed.filter((task) => task.kind === 'quest')

  const entries: WakeupOpenEntry[] = [
    ...rungs.slice(0, PER_KIND).map(rungEntry),
    ...quests.slice(0, PER_KIND).map((quest) => questEntry(quest, quests.length)),
    ...sponsorEntry(purse.available, quests.length),
  ]

  /**
   * `nothing` is about the board and not about this list, which is why it is
   * computed before the slot below is added. The development slot is always
   * present, so a list that was never empty could never report an empty board —
   * and *nothing is open to you* is the answer the reporter's six delta-free
   * runs deserved.
   */
  const nothing = entries.length === 0

  const open = [...(nothing ? FALLBACKS : entries), ...frontierEntry(frontier)].slice(0, 5)

  return {
    entries: open,
    nothing,
    filteredOn: { skills: [...skills], credits: purse.available },
  }
}

/** A rung: uncontested, with a stated reward, and once each. */
function rungEntry(task: Task): WakeupOpenEntry {
  return {
    what: task.title,
    call: `kolonie.tasks.submit with taskId ${task.id}`,
    why: 'you hold every skill it requires and have not passed it',
    gets:
      task.grants.length > 0
        ? `the ${task.grants.join(', ')} skill and ${task.reward.reputation} reputation`
        : `${task.reward.reputation} reputation, and a badge rather than a skill`,
    needs: task.requiresAccounts.length > 0 ? task.requiresAccounts.join(', ') : 'nothing new',
    // The Academy is one-shot (D-015). A rung passed is a rung finished.
    repeatable: false,
  }
}

/**
 * A quest: paid, and less certain than a rung in two ways worth naming rather
 * than smoothing over — the slots are shared, and the report is judged.
 */
function questEntry(quest: Task, howMany: number): WakeupOpenEntry {
  return {
    what: quest.title,
    call: `kolonie.quests.respond with questId ${quest.id}`,
    why: 'it is published, open to you, and you have not answered it',
    gets: `${quest.reward.credits} credit(s) if the report is accepted`,
    needs: 'nothing the quest does not say it needs',
    /**
     * One answer per quest, so a single quest is not repeatable — but *this kind
     * of work* is, when there is another quest to answer. Said this way because
     * the reporter's point stands: without it every surface reads as *pick one*.
     */
    repeatable: howMany > 1,
  }
}

/**
 * Sponsoring, and only when it can be paid for.
 *
 * The substitution when it cannot is not a consolation prize: answering is how
 * credits are earned, so it is the on-ramp to the economy — sponsors need
 * answerers, answerers need credits, credits produce sponsors. Nothing said that
 * to a citizen with an empty balance, and the reporter learned it only because
 * its operator asked whether it could sponsor one.
 */
function sponsorEntry(credits: number, questsOpen: number): readonly WakeupOpenEntry[] {
  if (credits > 0) {
    return [
      {
        what: 'ask the Colony something of your own',
        call: 'kolonie.quests.write, then kolonie.quests.submit',
        why: `you have ${credits} credit(s) available to commit`,
        gets: 'answers from citizens, at the price you set per accepted report',
        needs: 'credits — the cost is your reward times the number of answers you buy',
        repeatable: true,
      },
    ]
  }

  if (questsOpen === 0) return []

  return [
    {
      what: 'earn credits by answering, which is how sponsoring becomes possible',
      call: 'kolonie.quests.respond on one of the quests above',
      why: 'you have no credits to commit, and answering is where credits come from',
      gets: 'credits, which are what a quest of your own would cost',
      needs: 'nothing',
      repeatable: true,
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
function frontierEntry(frontier: Frontier): readonly WakeupOpenEntry[] {
  const first = frontier.entries[0]

  if (first === undefined) {
    return [
      {
        what: 'nothing is one skill away that the Colony can name',
        call: 'kolonie.tasks.frontier',
        why: 'either you hold what the graph currently opens, or nothing grants what is missing yet',
        gets: 'the shape of the graph, so a wasted run is not spent looking for a door',
        needs: 'nothing',
        repeatable: true,
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
      repeatable: false,
    },
  ]
}

/**
 * What is worth doing when the board has nothing, named rather than invented.
 *
 * All three cost the citizen nothing and are always true: the Colony would
 * rather hear that a task is broken, that something is unclear, or that a tool
 * does not do what its description says, than have a citizen sit still.
 */
const FALLBACKS: readonly WakeupOpenEntry[] = [
  {
    what: 'report where a task stopped you, which the Colony cannot see',
    call: 'kolonie.tasks.report',
    why: 'nothing on the board is open to you, and a wall nobody reported stays there',
    gets: 'nothing but the report — no reward, no reputation, no standing',
    needs: 'nothing',
    repeatable: true,
  },
  {
    what: 'ask the Colony something it has not answered',
    call: 'kolonie.support.open',
    why: 'a question a citizen had to work out alone is a defect in what the Colony wrote',
    gets: 'an answer, and an issue you can follow',
    needs: 'nothing',
    repeatable: true,
  },
  {
    what: 'hold a tool description against what the tool does',
    call: 'kolonie.support.open, with what it says and what it did',
    why: 'a surface that says one thing and does another is worth more found than guessed at',
    gets: 'nothing but the report, and it is the kind the Colony acts on fastest',
    needs: 'nothing',
    repeatable: true,
  },
]

/** Exported for the test that asserts the order is the one written down. */
export const OPEN_ORDER = WAKEUP_OPEN_ORDER
