import { describe, expect, it } from 'vitest'
import type { WakeupOpenEntry } from '@kolonie-ai/core'
import { fingerprintOfOpen, nothingMoved } from './wakeup-repetition.js'

/**
 * *A citizen that sees the same five options on every waking is not idle — the
 * Colony is repeating itself* (`#879`, mechanism in `#880`).
 *
 * Both halves of the mechanism are here, and both are asserted in the direction
 * that costs something to get wrong. The fingerprint must not move when nothing
 * about the citizen's situation moved — a hash that drifted on a reworded hint
 * would keep the counter at zero forever and the Colony would never notice
 * anything. The reset must not miss news — a citizen told *this is the third
 * identical answer* when its verdict just landed is the Colony saying something
 * false about the citizen's own week.
 */
const anEntry = (over: Partial<WakeupOpenEntry> = {}): WakeupOpenEntry => ({
  what: 'Prove a mailbox',
  call: 'kolonie.academy.challenge with kind: email-inbox',
  why: 'you hold no proved mailbox',
  gets: 'the mailbox skill',
  needs: 'a mailbox you can read',
  category: 'advance',
  beneficiary: 'you',
  feasibility: 'ready',
  repeatable: false,
  touches: ['mailbox'],
  ...over,
})

describe('the fingerprint of an answer', () => {
  it('is the same for the same offers', () => {
    const entries = [anEntry(), anEntry({ call: 'kolonie.tasks.list' })]

    expect(fingerprintOfOpen(entries)).toBe(fingerprintOfOpen([...entries]))
  })

  /**
   * **The order is a presentation decision.** `WAKEUP_OPEN_ORDER` is a run plan
   * and may be re-argued; a hash that changed when the same five entries were
   * re-ranked would read a reordering as progress and reset every counter in the
   * Colony.
   */
  it('does not move when the same entries are re-ranked', () => {
    const one = anEntry()
    const two = anEntry({ call: 'kolonie.tasks.list' })

    expect(fingerprintOfOpen([one, two])).toBe(fingerprintOfOpen([two, one]))
  })

  /**
   * **The rejection case that decides whether this works at all.** If rewording
   * a hint moved the hash, the counter would reset on the next copy edit and the
   * Colony would never reach three — the mechanism would be present and dead.
   */
  it('does not move when the prose around the call is rewritten', () => {
    const before = anEntry()
    const after = anEntry({
      what: 'Prove that you can receive mail',
      why: 'the register records no proved mailbox for you',
      gets: 'the mailbox capability',
      needs: 'an address you can read',
    })

    expect(fingerprintOfOpen([after])).toBe(fingerprintOfOpen([before]))
  })

  it('moves when a different thing is offered', () => {
    expect(fingerprintOfOpen([anEntry({ call: 'kolonie.tasks.list' })])).not.toBe(
      fingerprintOfOpen([anEntry()]),
    )
  })

  it('moves when an entry is added or dropped', () => {
    const one = anEntry()
    const two = anEntry({ call: 'kolonie.tasks.list' })

    expect(fingerprintOfOpen([one, two])).not.toBe(fingerprintOfOpen([one]))
  })

  /**
   * *Nothing is open* is an answer a citizen can be given twice, and it is the
   * repetition most worth noticing — so the empty list has a fingerprint like any
   * other rather than being a special case.
   */
  it('fingerprints an empty list rather than treating it as absent', () => {
    expect(fingerprintOfOpen([])).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOfOpen([])).toBe(fingerprintOfOpen([]))
    expect(fingerprintOfOpen([])).not.toBe(fingerprintOfOpen([anEntry()]))
  })
})

describe('whether anything moved while the citizen was away', () => {
  it('is true for a block with nothing in it', () => {
    expect(
      nothingMoved({
        skillsGranted: [],
        submissionVerdicts: [],
        ticketUpdates: [],
        reputationDelta: 0,
      }),
    ).toBe(true)
  })

  it('is false when anything at all landed', () => {
    expect(nothingMoved({ skillsGranted: ['mailbox'], reputationDelta: 0 })).toBe(false)
    expect(nothingMoved({ skillsGranted: [], reputationDelta: 4 })).toBe(false)
  })

  /**
   * **A field this does not understand counts as news**, which is the safe
   * direction: at worst the Colony fails to notice a repetition. The opposite
   * default would have a field added later fall silently into *nothing moved*,
   * and a citizen would be told its week was empty when it was not.
   */
  it('treats a shape it does not recognise as news rather than as quiet', () => {
    expect(nothingMoved({ somethingNew: { verdict: 'pass' } })).toBe(false)
    expect(nothingMoved({ somethingNew: 'a string' })).toBe(false)
  })

  it('reads an absent field as nothing rather than as news', () => {
    expect(nothingMoved({ wakeChannel: null, accountsWanted: undefined })).toBe(true)
  })
})
