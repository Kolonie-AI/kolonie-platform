import { describe, expect, it } from 'vitest'
import { QUEST_PROOF_VERIFIERS, QUEST_VERIFIER_PROVES } from '@kolonie-ai/core'
import { ACADEMY_TASKS } from './index.js'

/**
 * `QUEST_VERIFIER_PROVES` in `packages/core` says what each proof verifier's
 * rung grants. This is where that claim is checked (`#626`).
 *
 * **The map cannot read the seed and the seed cannot read the map.** Core has no
 * database and the rungs live here, so the two are separate statements of one
 * fact — which is exactly the shape `#626` was filed about one level up. A test
 * is the cheapest thing that makes them one: the tier rule refuses to raise a
 * quest whose `requires` already covers what the verifier grants, and if this
 * list drifted the rule would silently stop firing for the rung that moved.
 *
 * No database needed: this is a question about the definitions.
 */
describe('what a proof verifier’s rung grants', () => {
  const seeded = new Map(ACADEMY_TASKS.map((task) => [task.type, task]))

  it('names a rung the Academy actually seeds, for every verifier', () => {
    for (const verifier of QUEST_PROOF_VERIFIERS) {
      expect(seeded.get(verifier), `${verifier} has no Academy rung`).toBeDefined()
    }
  })

  it('agrees with that rung about which skills it grants', () => {
    for (const verifier of QUEST_PROOF_VERIFIERS) {
      expect([...QUEST_VERIFIER_PROVES[verifier].grants].sort()).toEqual(
        [...(seeded.get(verifier)?.grants ?? [])].sort(),
      )
    }
  })

  /**
   * `email-send` grants nothing, and that is a real answer rather than a gap in
   * the map. Asserted by name so that somebody filling it in later has to argue
   * with this test rather than with a blank.
   */
  it('records the one verifier whose rung grants no skill', () => {
    const ungranting = QUEST_PROOF_VERIFIERS.filter(
      (verifier) => QUEST_VERIFIER_PROVES[verifier].grants.length === 0,
    )

    expect(ungranting).toEqual(['email-send'])
  })
})
