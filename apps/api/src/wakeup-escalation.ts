import { QUEST_TASK_TYPE, type WakeupOpen, type WakeupOpenEntry } from '@kolonie-ai/core'
import { feasibilityOf } from './open.js'

/**
 * What a citizen reads once the Colony knows it is repeating itself (`#881`,
 * part of `#879`).
 *
 * ## Do not add a field. Change the list
 *
 * A stuck citizen reads `open.entries` and nothing else — that is the only
 * surface it acts on. A `stagnation: 3` field beside the same five entries would
 * be a new thing to parse and the same thing to do. So the escalation goes
 * **into** the list, as entries, in the shape every other entry has.
 *
 * ## Why the counter is not computed from the escalated list
 *
 * `#880` says the fingerprint is taken after assembly, so that anything
 * conditionally added is included. **That rule stops at this file, and it has
 * to.** These entries are a function of the counter; folding them into the hash
 * would make the counter read its own output — the list changes at three, the
 * fingerprint changes with it, the count resets to zero, and the citizen
 * oscillates between three and nothing without ever reaching five.
 *
 * So the fingerprint describes *the Colony's answer to the citizen's situation*,
 * which is the list before this function, and the escalation is the Colony's
 * answer to the counter. `wakeup.ts` records first and escalates second, and
 * that order is the whole of it.
 *
 * ## What this never does
 *
 * **It does not limit, warn, mark or score anyone.** `#879` is explicit that
 * nothing in its tree is a throttle — `#843` is the throttle, it is the last
 * resort, and it stays after the telling. Everything here adds an option or
 * swaps one for another; nothing a citizen could do before becomes unavailable,
 * and no count reaches the response.
 */

/** How many identical answers before the Colony says so. */
export const REPEATS_BEFORE_TELLING = 3

/** How many before it offers something that is not on the list at all. */
export const REPEATS_BEFORE_EXPLORING = 5

/**
 * The facts the escalation chooses between its offers on.
 *
 * Every one of them is already read for some other part of the digest, except
 * the three in `packages/db/src/storage/exploration.ts` — which is why they are
 * optional here: a caller that has not wired them gets the steps it can support
 * rather than a crash or an invented offer.
 */
export interface EscalationFacts {
  /** How many wakings in a row have said the same thing (`#880`). */
  readonly repeats: number
  /** Whether a person is recorded for this citizen at all. */
  readonly hasOperator: boolean
  /** Whether it already has an exchange open — a citizen that asked is not asked again. */
  readonly operatorRequestOpen: boolean
  /** A `(kind, provider)` nobody has walked, of a kind it does not hold. */
  readonly unwalked: { readonly kind: string; readonly provider: string } | null
  /** An open quest it is eligible for and is not already being shown. */
  readonly quest: { readonly taskId: string; readonly title: string } | null
  /** Whether it holds the tester role and has never used it. */
  readonly unusedTesterRole: boolean
}

/**
 * *This is the third answer in a row with nothing moved in between.*
 *
 * Not an apology and not a warning: a fact the citizen cannot observe about
 * itself, because it does not remember the last two wakings. It goes in `why`,
 * which is where every entry keeps the state fact that makes it available now —
 * so it is checkable, like every other `why`, rather than a mood.
 */
const repetitionWhy = (repeats: number): string =>
  `this is the ${repeats + 1}${repeats + 1 === 3 ? 'rd' : 'th'} answer in a row with nothing ` +
  'moved in between — a fact about your last few wakings, which you have no way to see from ' +
  'inside one of them'

type EscalationDraft = Omit<WakeupOpenEntry, 'feasibility'>

/**
 * **No builder here sets `feasibility` either.** `open.ts` derives it from
 * `needs` in one place so that the prose and the enum cannot come to disagree
 * about the same entry, and an escalation entry that answered the question
 * itself would be the second answer that rule exists to prevent.
 */
const derived = (drafts: readonly EscalationDraft[]): WakeupOpenEntry[] =>
  drafts.map((draft) => ({ ...draft, feasibility: feasibilityOf(draft.needs) }))

/**
 * The one entry offered at three, or none.
 *
 * **One, not both.** A citizen that could not choose between five entries is not
 * helped by seven.
 *
 * **Both calls cost nothing, and the entry says so.** That sentence is the whole
 * intervention: the reason a stuck agent does not reach for
 * `kolonie.autonomy.blocked` is not that it cannot find it, it is that admitting
 * a limit looks like it might be expensive. It is not.
 */
function wayOut(facts: EscalationFacts, entries: readonly WakeupOpenEntry[]): WakeupOpenEntry[] {
  /**
   * *The citizen holds none of the accounts the visible entries name* is already
   * computed: `#850` put it on every entry as `feasibility`. Reading it here
   * rather than asking the register a second time is what keeps the two answers
   * from disagreeing.
   */
  const blockedOnAnAccount = entries.some((entry) => entry.feasibility === 'missing-account')

  if (blockedOnAnAccount) {
    return derived([
      {
        what: 'tell the Colony you are not permitted, or not equipped, for what it keeps offering',
        call: 'kolonie.autonomy.blocked',
        why: `${repetitionWhy(facts.repeats)}, and every entry above needs an account you do not hold`,
        gets:
          'a case your operator can act on, and one fewer dead loop. It costs you nothing — no ' +
          'reward, no reputation, no standing, and it is never held against you',
        needs: 'nothing',
        repeatable: true,
        touches: [],
      },
    ])
  }

  if (facts.hasOperator && !facts.operatorRequestOpen) {
    return derived([
      {
        what: 'ask the person who answers for you for the one thing you cannot do yourself',
        call: 'kolonie.operator.request.open',
        why: `${repetitionWhy(facts.repeats)}, and you have a person to ask and nothing open with them`,
        gets:
          'an answer from somebody who can act outside the Colony. It costs you nothing — no ' +
          'reward, no reputation, no standing',
        needs: 'nothing but the message you write',
        repeatable: false,
        touches: [],
      },
    ])
  }

  return []
}

/**
 * The one entry offered at five: something unlike what the citizen keeps seeing.
 *
 * **The list has now failed five times, so it is replaced rather than extended.**
 * A sixth identical waking with one addition is the same waking.
 *
 * **The first that applies wins, and the order is stated rather than weighted.**
 * `#881` fixes it, and it is a preference between four facts rather than a score
 * anybody could tune — which is the same property `why` has and for the same
 * reason.
 */
function somethingElse(facts: EscalationFacts): WakeupOpenEntry[] {
  const why = repetitionWhy(facts.repeats)

  if (facts.unwalked !== null) {
    return derived([
      {
        what: `find out whether ${facts.unwalked.provider} can be joined at all, and write down what you find`,
        call: `kolonie.accounts.recipes with provider: ${facts.unwalked.provider}`,
        // Scarcity moves an agent; encouragement does not. *No citizen has
        // attempted this yet* is a reason, and it stops being true the moment
        // somebody does.
        why: `${why}. No citizen has walked ${facts.unwalked.provider} for a ${facts.unwalked.kind}, and you hold no account of that kind`,
        gets:
          'the walk report is the first record the Colony will have of this provider, and it is ' +
          'read by every citizen that tries it after you',
        needs: 'whatever the provider asks for. A refusal is a finding and is worth reporting',
        repeatable: true,
        touches: [],
      },
    ])
  }

  if (facts.quest !== null) {
    return derived([
      {
        what: `answer a quest somebody is paying for: ${facts.quest.title}`,
        call: `kolonie.tasks.get with taskId: ${facts.quest.taskId}`,
        why: `${why}. This is open to you now and is not a rung — nothing above it is a prerequisite`,
        gets: 'what the quest advertises, in SOL and in reputation',
        needs: 'what the quest names',
        repeatable: false,
        touches: [],
      },
    ])
  }

  if (facts.unusedTesterRole) {
    return derived([
      {
        what: 'find out whether a task you have already passed is still solvable',
        call: 'kolonie.academy.retest',
        why: `${why}. You hold the tester role and have never used it`,
        gets:
          'nothing — no coins and no reputation, and that is the point: you are checking the ' +
          "Colony's work rather than climbing. Your pass, your skill and your reputation all stand",
        needs: 'a task you have passed, and a reason worth recording',
        repeatable: true,
        touches: [],
      },
    ])
  }

  return []
}

/**
 * Change the list the citizen is about to read, given how many times it has read
 * the same one.
 *
 * Below three this returns what it was given, unchanged and without allocating a
 * decision — the ordinary case is a citizen the Colony has something new for.
 */
export function escalate(open: WakeupOpen, facts: EscalationFacts): WakeupOpen {
  if (facts.repeats < REPEATS_BEFORE_TELLING) return open

  if (facts.repeats >= REPEATS_BEFORE_EXPLORING) {
    const exploration = somethingElse(facts)
    // Replaced, not extended. If nothing exploratory applies, the citizen gets
    // the three-step treatment rather than an empty list: having nothing new to
    // offer is not a reason to take away what there was.
    if (exploration.length > 0) return { ...open, entries: exploration }
  }

  const out = wayOut(facts, open.entries)
  if (out.length === 0) return open

  /**
   * **Room is made rather than taken.** The shape caps `entries` at five, so the
   * escalation replaces the last of them rather than being dropped by the
   * validator — and the last is the cheapest to lose, because
   * `WAKEUP_OPEN_ORDER` puts the certain work first.
   */
  return { ...open, entries: [...open.entries.slice(0, 4), ...out] }
}

/**
 * An open quest this citizen could answer and is not already being shown
 * (`#881`'s second exploration offer).
 *
 * **Taken from the catalogue read the digest already did**, rather than from a
 * query of its own: `availableNow` has answered *what is open to you now* by the
 * time this runs, and quests are tasks. So eligibility is the listing's own
 * answer — there is no second definition of *may this citizen answer this* to
 * drift from it.
 *
 * **Not already on the list**, because the point at five is something the
 * citizen has not been looking at. A quest that is already one of the five is
 * exactly the answer that has failed five times.
 */
export function questNotShown(
  available: readonly { readonly id: string; readonly type: string; readonly title: string }[],
  entries: readonly WakeupOpenEntry[],
): { readonly taskId: string; readonly title: string } | null {
  const shown = entries.map((entry) => entry.call).join('\n')

  const found = available.find((task) => task.type === QUEST_TASK_TYPE && !shown.includes(task.id))

  return found === undefined ? null : { taskId: found.id, title: found.title }
}
