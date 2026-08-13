import { describe, expect, it } from 'vitest'
import type { WakeupOpen, WakeupOpenEntry } from '@kolonie-ai/core'
import { escalate, questNotShown, type EscalationFacts } from './wakeup-escalation.js'

/**
 * *When the Colony is repeating itself, say so and offer a way out* (`#881`).
 *
 * The mechanism that counts is `#880`'s and is tested against a real database.
 * What is asserted here is what a citizen actually reads — and, as much as that,
 * the three things this must **not** do: escalate at a citizen the Colony has
 * news for, offer two ways out at once, and take away an option it cannot
 * replace.
 */
const anEntry = (over: Partial<WakeupOpenEntry> = {}): WakeupOpenEntry => ({
  what: 'Prove a mailbox',
  call: 'kolonie.academy.challenge with kind: email-inbox',
  why: 'you hold no proved mailbox',
  gets: 'the mailbox skill',
  needs: 'a mailbox you can read',
  feasibility: 'ready',
  repeatable: false,
  touches: ['mailbox'],
  ...over,
})

const anOpen = (entries: readonly WakeupOpenEntry[]): WakeupOpen => ({
  entries: [...entries],
  nothing: false,
  filteredOn: { skills: [] },
})

const facts = (over: Partial<EscalationFacts> = {}): EscalationFacts => ({
  repeats: 3,
  hasOperator: false,
  operatorRequestOpen: false,
  unwalked: null,
  quest: null,
  unusedTesterRole: false,
  ...over,
})

const five = [1, 2, 3, 4, 5].map((n) => anEntry({ call: `kolonie.tasks.submit with taskId ${n}` }))

describe('before the Colony has repeated itself', () => {
  /**
   * The ordinary case, and the one that must cost nothing: a citizen the Colony
   * has something new for is not told anything about repetition.
   */
  it.each([0, 1, 2])('changes nothing at %i repeats', (repeats) => {
    const open = anOpen(five)

    expect(escalate(open, facts({ repeats, hasOperator: true }))).toBe(open)
  })
})

describe('at three — naming it, and offering the way out', () => {
  it('offers autonomy.blocked when every entry needs an account it does not hold', () => {
    const blocked = five.map((entry) => ({ ...entry, feasibility: 'missing-account' as const }))

    const { entries } = escalate(anOpen(blocked), facts({ hasOperator: true }))
    const added = entries.at(-1)

    expect(added?.call).toBe('kolonie.autonomy.blocked')
    expect(added?.why).toContain('4th answer in a row with nothing moved')
  })

  it('offers the operator request when there is a person to ask and nothing open', () => {
    const { entries } = escalate(anOpen(five), facts({ hasOperator: true }))

    expect(entries.at(-1)?.call).toBe('kolonie.operator.request.open')
  })

  /**
   * **One, not both.** A citizen that could not choose between five entries is
   * not helped by seven — so the account case wins outright and the operator
   * entry does not come with it.
   */
  it('offers one way out and never two', () => {
    const blocked = five.map((entry) => ({ ...entry, feasibility: 'missing-account' as const }))

    const { entries } = escalate(anOpen(blocked), facts({ hasOperator: true }))

    expect(entries.filter((entry) => entry.call.startsWith('kolonie.')).length).toBe(5)
    expect(entries.map((entry) => entry.call)).not.toContain('kolonie.operator.request.open')
  })

  /**
   * **The whole intervention is that sentence.** A stuck agent does not reach
   * for `autonomy.blocked` because admitting a limit looks like it might be
   * expensive. It is not, and the entry has to say so.
   */
  it('says outright that the way out costs nothing', () => {
    const blocked = five.map((entry) => ({ ...entry, feasibility: 'missing-account' as const }))

    const { entries } = escalate(anOpen(blocked), facts())

    expect(entries.at(-1)?.gets).toContain('costs you nothing')
    expect(entries.at(-1)?.gets).toContain('never held against you')
  })

  /** A citizen that has already asked is not told to ask again. */
  it('does not send a citizen back round a loop it is already in', () => {
    const open = anOpen(five)

    expect(escalate(open, facts({ hasOperator: true, operatorRequestOpen: true }))).toBe(open)
  })

  /** A self-operated citizen is never sent down a path whose first step is a person. */
  it('offers nothing to a citizen with nobody to ask and no account wall', () => {
    const open = anOpen(five)

    expect(escalate(open, facts({ hasOperator: false }))).toBe(open)
  })

  /**
   * The shape caps `entries` at five. Room is made rather than the escalation
   * being dropped by the validator — and the last is the cheapest to lose,
   * because the order puts the certain work first.
   */
  it('stays within the five the shape allows', () => {
    const { entries } = escalate(anOpen(five), facts({ hasOperator: true }))

    expect(entries).toHaveLength(5)
    expect(entries[0]?.call).toBe('kolonie.tasks.submit with taskId 1')
    expect(entries[3]?.call).toBe('kolonie.tasks.submit with taskId 4')
  })
})

describe('at five — something that is not on the list', () => {
  const stuck = facts({ repeats: 5, hasOperator: true })

  it('replaces the list rather than extending it', () => {
    const { entries } = escalate(
      anOpen(five),
      facts({ ...stuck, unwalked: { kind: 'mailbox', provider: 'example.test' } }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.call).toContain('example.test')
  })

  /**
   * **Scarcity moves an agent; encouragement does not.** *No citizen has walked
   * this* is a reason a reader can check; *consider exploring* is a mood.
   */
  it('gives a reason rather than a mood', () => {
    const { entries } = escalate(
      anOpen(five),
      facts({ ...stuck, unwalked: { kind: 'mailbox', provider: 'example.test' } }),
    )

    expect(entries[0]?.why).toContain('No citizen has walked')
    expect(entries[0]?.why).not.toMatch(/consider|why not|perhaps/i)
  })

  /** The stated order, asserted as an order rather than as three separate cases. */
  it('prefers the first offer that applies', () => {
    const all = facts({
      ...stuck,
      unwalked: { kind: 'mailbox', provider: 'example.test' },
      quest: { taskId: 'a-quest', title: 'Walk a provider' },
      unusedTesterRole: true,
    })

    expect(escalate(anOpen(five), all).entries[0]?.call).toContain('example.test')
    expect(escalate(anOpen(five), { ...all, unwalked: null }).entries[0]?.call).toContain('a-quest')
    expect(escalate(anOpen(five), { ...all, unwalked: null, quest: null }).entries[0]?.call).toBe(
      'kolonie.academy.retest',
    )
  })

  /**
   * **Having nothing new to offer is not a reason to take away what there was.**
   * The citizen falls back to the three-step treatment rather than to an empty
   * list — which would be the one thing in this tree that made a citizen worse
   * off than before it was noticed.
   */
  it('falls back to the way out when nothing exploratory applies', () => {
    const { entries } = escalate(anOpen(five), stuck)

    expect(entries).toHaveLength(5)
    expect(entries.at(-1)?.call).toBe('kolonie.operator.request.open')
  })

  it('never leaves a citizen with fewer options than it had', () => {
    const { entries } = escalate(anOpen(five), facts({ repeats: 5 }))

    expect(entries).toHaveLength(5)
  })
})

/**
 * `#879`: *nothing in this tree limits, warns, marks or scores anyone.* The
 * throttle is `#843`, it is the last resort, and it stays after the telling.
 */
describe('what the escalation refuses to do', () => {
  it('warns, marks and scores nobody', () => {
    const said = JSON.stringify(
      escalate(anOpen(five), facts({ hasOperator: true })).entries,
    ).toLowerCase()

    for (const word of ['warning', 'throttle', 'limit', 'score', 'penalt', 'suspicious']) {
      expect(said).not.toContain(word)
    }
  })

  it('publishes no counter for a citizen to optimise', () => {
    const escalated = escalate(anOpen(five), facts({ hasOperator: true }))

    expect(Object.keys(escalated)).toEqual(['entries', 'nothing', 'filteredOn'])
  })
})

describe('choosing a quest the citizen is not already looking at', () => {
  const quest = { id: 'quest-1', type: 'quest-report', title: 'Walk a provider' }
  const rung = { id: 'rung-1', type: 'academy', title: 'Prove a mailbox' }

  it('takes an eligible quest from what the listing already answered', () => {
    expect(questNotShown([rung, quest], [])).toEqual({
      taskId: 'quest-1',
      title: 'Walk a provider',
    })
  })

  /** A quest already on the list is the answer that has failed five times. */
  it('skips one that is already being shown', () => {
    const shown = [anEntry({ call: 'kolonie.tasks.submit with taskId quest-1' })]

    expect(questNotShown([quest], shown)).toBeNull()
  })

  it('offers no rung, because a rung is what the citizen keeps being offered', () => {
    expect(questNotShown([rung], [])).toBeNull()
  })
})
