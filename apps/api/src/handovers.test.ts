import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, type ProviderRecipe } from '@kolonie-ai/core'
import { openHandover, type HandoverStore } from './handovers.js'

const agentId = AgentIdSchema.parse(randomUUID())

/**
 * A recipe with one handover step, which is what authorises the channel at all.
 */
const recipe = (): ProviderRecipe =>
  ({
    kind: 'github',
    provider: 'github.example',
    title: 'A code host',
    category: 'code-hosting',
    status: 'joinable',
    steps: [
      { actor: 'operator', instruction: 'Create the account.' },
      { actor: 'agent', instruction: 'Seal the password for your operator.', handover: true },
    ],
    proves: 'provider-post',
  }) as unknown as ProviderRecipe

function fakeStore(hasOperator: boolean): HandoverStore & {
  readonly sealed: readonly { readonly value: string }[]
} {
  const sealed: { readonly value: string }[] = []
  const store: HandoverStore = {
    open: async (command) => {
      sealed.push({ value: command.value })
      return {
        outcome: 'opened',
        id: 'a-handover',
        expiresAt: '2026-08-15T09:00:00.000Z',
      }
    },
    waiting: async () => [],
    read: async () => ({ outcome: 'closed' }),
    hasOperator: async () => hasOperator,
  }

  return { ...store, sealed }
}

const seal = (store: HandoverStore) =>
  openHandover(
    {
      agentId,
      body: { provider: 'github.example', step: 2, value: 'a-password-the-agent-chose' },
      recipe: recipe(),
    },
    store,
  )

/**
 * The channel that sealed into a void (`#918`).
 *
 * A citizen measured this on 2026-08-12: it minted a password, sealed it on the
 * GitHub recipe's handover step, told its operator it was waiting, and the seal
 * expired four hours later unread. Reading a handover needs a signed-in console;
 * its operator only ever had the unauthenticated page `kolonie.operator.page`
 * issues, and nothing anywhere said the two were different surfaces. Six days of
 * that rung went to a step that could not complete.
 */
describe('sealing a secret for an operator', () => {
  it('seals it where a person is linked and can sign in to read it', async () => {
    const store = fakeStore(true)

    const result = await seal(store)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.id).toBe('a-handover')
  })

  /**
   * **The refusal is the fix, and it happens before the value is spent.** From
   * the agent's side *nobody has read it yet* and *nobody can ever read it* are
   * the same silence — so the first is worth waiting through and the second is
   * worth six days.
   */
  it('refuses rather than sealing where nobody is linked to read it', async () => {
    const store = fakeStore(false)

    const result = await seal(store)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('validation_failed')
  })

  /** Nothing is written on the refusal: the secret does not reach storage at all. */
  it('does not seal the value it refused', async () => {
    const store = fakeStore(false)

    await seal(store)

    expect(store.sealed).toHaveLength(0)
  })

  /**
   * **Both ways on, named in the refusal.** They are different choices and
   * neither is the Colony's to make: linking keeps the direction the 2026-08-08
   * decision chose, and a credential drop is for the operator that will not hold
   * a Colony account — the agent still ends up holding the credential, which is
   * the half of that decision that was load-bearing.
   */
  it('names both routes out, and says which page is not the console', async () => {
    const result = await seal(fakeStore(false))

    if (result.outcome !== 'rejected') throw new Error('expected a refusal')

    expect(result.error.message).toContain('kolonie.operator.link')
    expect(result.error.message).toContain('kolonie.operator.drop.open')
    expect(result.error.message).toContain('needs no login')
  })

  /**
   * The channel constraint that predates this and is not weakened by it: a
   * secret travels only on a step the recipe marks as one.
   */
  it('still refuses a step that is not a handover, linked or not', async () => {
    const result = await openHandover(
      {
        agentId,
        body: { provider: 'github.example', step: 1, value: 'a-password' },
        recipe: recipe(),
      },
      fakeStore(true),
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('is not a handover')
  })
})
