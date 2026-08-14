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

type Sealed = { readonly value: string; readonly provider: string; readonly prompt: string }

function fakeStore(hasOperator: boolean): HandoverStore & {
  readonly sealed: readonly Sealed[]
} {
  const sealed: Sealed[] = []
  const store: HandoverStore = {
    open: async (command) => {
      sealed.push({ value: command.value, provider: command.provider, prompt: command.prompt })
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

  /** The step's own sentence is preferred where there is one, because it is more specific. */
  it('takes the wording from a handover step when one is named', async () => {
    const store = fakeStore(true)

    await seal(store)

    expect(store.sealed[0]?.prompt).toBe('Seal the password for your operator.')
  })
})

/**
 * The channel that was closed everywhere nobody had walked (`#926`).
 *
 * Measured 2026-08-13: the `telephony` shelf held three entries, all `unwritten`,
 * all with `steps: []`. No step existed, so no handover was possible, for any
 * phone provider — and that is the normal state of anything new rather than an
 * edge case. The precondition was buying two things and only one was real; the
 * real one is that the Colony writes the sentence, and every test here checks it
 * still does.
 */
describe('sealing a secret at a provider nobody has walked', () => {
  const sealAt = (store: HandoverStore, body: unknown, entry?: ProviderRecipe) =>
    openHandover({ agentId, body, recipe: entry }, store)

  it('seals where the Atlas has no entry for the provider at all', async () => {
    const store = fakeStore(true)

    const result = await sealAt(store, { provider: 'sms.example', value: 'a-password' })

    expect(result.outcome).toBe('ok')
    expect(store.sealed).toHaveLength(1)
  })

  it('seals where the entry exists but carries no steps', async () => {
    const store = fakeStore(true)
    const unwritten = { ...recipe(), steps: [] } as unknown as ProviderRecipe

    const result = await sealAt(
      store,
      { provider: 'github.example', value: 'a-password' },
      unwritten,
    )

    expect(result.outcome).toBe('ok')
    expect(store.sealed).toHaveLength(1)
  })

  /**
   * **The caller's own spelling, because there is no row to take one from.** It
   * cannot fall back to `recipe.provider` where no recipe answered, and that is
   * the ordinary case this exists for.
   */
  it('files it under the provider the agent named when no entry answers', async () => {
    const store = fakeStore(true)

    await sealAt(store, { provider: 'sms.example', value: 'a-password' })

    expect(store.sealed[0]?.provider).toBe('sms.example')
  })

  /**
   * **The fourth constraint survives the gate being removed.** An agent that
   * could compose the sentence beside its secret is the thing `#592` refused,
   * and it is refused by the schema rather than by the step: there is no field
   * for prose, so a provider with no recipe gets the Colony's general sentence
   * rather than the agent's.
   */
  it('writes the Colony’s own sentence where no step supplied one', async () => {
    const store = fakeStore(true)

    await sealAt(store, { provider: 'sms.example', value: 'a-password' })

    const prompt = store.sealed[0]?.prompt ?? ''
    expect(prompt).toContain('Your agent has sealed a credential for you')
    expect(prompt).toContain('sms.example')
  })

  /** A step that is not a handover no longer refuses — it simply lends no wording. */
  it('seals on a step that is not a handover, and does not borrow its instruction', async () => {
    const store = fakeStore(true)

    const result = await sealAt(
      store,
      { provider: 'github.example', step: 1, value: 'a-password' },
      recipe(),
    )

    expect(result.outcome).toBe('ok')
    expect(store.sealed[0]?.prompt).not.toContain('Create the account.')
  })

  /** A step number past the end of the recipe is not an error either. */
  it('seals on a step number the recipe does not have', async () => {
    const store = fakeStore(true)

    const result = await sealAt(
      store,
      { provider: 'github.example', step: 9, value: 'a-password' },
      recipe(),
    )

    expect(result.outcome).toBe('ok')
  })

  /**
   * **The rejection case that stays**, and it is the one that was always load-
   * bearing: a handover is read from a signed-in console, and with nobody linked
   * there is no reader. Removing the recipe gate does not remove this one.
   */
  it('still refuses at an unwalked provider when nobody is linked to read it', async () => {
    const store = fakeStore(false)

    const result = await sealAt(store, { provider: 'sms.example', value: 'a-password' })

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('kolonie.operator.link')
    expect(store.sealed).toHaveLength(0)
  })
})
