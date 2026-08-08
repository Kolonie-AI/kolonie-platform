import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from './academy-tasks.js'
import { PROVIDER_CATALOGUE } from './provider-catalogue.js'

/**
 * A recipe may not ask for more than the task it serves requires (`#596`).
 *
 * The `github.com` recipe's first step said *which of your **proved** addresses
 * the account should use*. The task it serves, `github-account`, requires
 * `accountKinds: ['mailbox']` — a **declared** mailbox, not a proved one. So the
 * recipe asked for something the Colony did not require and does not check.
 *
 * Measured 2026-08-08 by walking it: agent `colette` held two mailboxes, neither
 * proved, and the task was in its takeable list. The account was created, the
 * launch code went to an unproved address, and the agent read it out of its own
 * inbox about ninety seconds later.
 *
 * **Why this is a test rather than a fix and a note.** The two live in different
 * files, in different vocabularies, edited by different people for different
 * reasons — which is precisely the shape of thing that agrees the day it is
 * written and disagrees six weeks later with nothing saying so. `#596` asks for
 * the divergence to fail the suite, and this is that.
 *
 * ## What it checks, and what it deliberately does not
 *
 * **A word, not the meaning.** It reads recipe steps for a demand a task's
 * requirements cannot back — `proved` beside an account kind — rather than
 * trying to understand either. A test that tried to parse intent would be a
 * second implementation of the requirement, and the wrong one.
 *
 * It cannot catch a recipe asking for something in words this list does not
 * have. That is the honest limit, and the answer to it is that the vocabulary
 * grows when somebody finds the next one — the same arrangement
 * `bare-identifiers.test.ts` documents about itself.
 */

/** The demands a recipe can make in prose that a task requirement has to back. */
const DEMANDS = ['proved', 'proven', 'verified'] as const

describe('a recipe and the task it serves', () => {
  /**
   * The tasks that grant the skill an account of one kind earns.
   *
   * **`grants` and not `accountKinds`, and getting that backwards was the first
   * version of this file.** `accountKinds` is what a task needs *before* it
   * starts — `github-account` needs a mailbox — and `grants` is what holding it
   * earns. An entry proved by a rung is proved by the task that grants its own
   * kind, which is the join that means something.
   *
   * **The skill and the kind coincide by name for every entry today**, and this
   * join relies on that. `apps/api`'s `SKILL_FOR_ACCOUNT_KIND` is the real
   * relation and is not reachable from this package — so this is the weaker
   * check, stated as weaker rather than presented as the strong one.
   */
  const tasksGranting = (kind: string) =>
    ACADEMY_TASKS.filter((task) => (task.grants ?? []).includes(kind))

  it('has at least one entry to check, so a green run means something', () => {
    expect(PROVIDER_CATALOGUE.length).toBeGreaterThan(0)
  })

  /**
   * **The check.** A step that demands a *proved* account of some kind, in a
   * recipe whose task requires only that the kind be declared, is the `#596`
   * defect — the Colony asking for work it neither requires nor checks.
   */
  it.each(PROVIDER_CATALOGUE.map((entry) => [entry.provider, entry] as const))(
    '%s asks for no proof its task does not require',
    (_provider, entry) => {
      const prose = entry.steps
        .map((step) => `${step.instruction} ${step.ask ?? ''}`)
        .join(' ')
        .toLowerCase()

      const demanded = DEMANDS.filter((word) => prose.includes(`${word} address`))
      if (demanded.length === 0) return

      /**
       * A recipe may demand a proof **only** where some task it serves is
       * gated on more than a declaration. Nothing in the Colony expresses that
       * today — `accountKinds` is a list of kinds and says nothing about
       * proof — so this is currently unsatisfiable by construction, and the
       * message says so rather than leaving a reader to work out why their
       * perfectly reasonable sentence failed a test.
       */
      expect(
        demanded,
        `${entry.provider}'s recipe demands a ${demanded.join('/')} address. No task ` +
          `requirement can express that — accountKinds names kinds and nothing about proof — so ` +
          `the recipe would be asking for something the Colony never checks. Say what actually ` +
          `matters about the address instead (see #596), or add the requirement first.`,
      ).toEqual([])
    },
  )

  /**
   * The other half, and the cheaper mistake: a recipe naming an account kind the
   * task it serves does not require at all. Nothing in the catalogue does this
   * today; the assertion is here so that the first one to is noticed.
   */
  it('points at a rung only where a task grants that kind of account', () => {
    /**
     * `trello` is the entry that makes this worth asserting rather than
     * assuming: `#521` put it in the catalogue precisely to show that an entry
     * needs **no** task, no verifier and no migration — so it is proved
     * generically, and an entry that claimed `rung` with nothing granting its
     * kind would send an agent looking for a rung that does not exist.
     */
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.proves !== 'rung') continue

      expect(
        tasksGranting(entry.kind).map((task) => task.type),
        `${entry.provider} says a rung proves it, but no Academy task grants a ` +
          `"${entry.kind}" account`,
      ).not.toEqual([])
    }
  })
})
