import { describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import { fakeAccountRegister } from './__fixtures__/accounts.js'
import { setOwnAccountShownOnProfile, type AccountDependencies } from './accounts.js'

/**
 * The door to the second act (`#821`), under
 * `what-a-profile-may-show-of-an-account.md` (`kolonie-docs#337`).
 *
 * **What the page ends up carrying is asserted in `packages/db` and in
 * `routes/profile-pages.test.ts`.** This file asks the narrower question: what a
 * citizen is *told* when it asks for something the record refuses. A refusal
 * that is correct and unreadable is a refusal a citizen retries.
 */
describe('naming one account on a profile', () => {
  const agentId = 'a0000000-0000-4000-8000-000000000001' as AgentId

  const register = () => {
    const fake = fakeAccountRegister()

    return {
      fake,
      deps: { register: fake } as unknown as AccountDependencies,
    }
  }

  const declare = async (
    fake: ReturnType<typeof fakeAccountRegister>,
    kind: string,
    identifier: string,
  ) => {
    const declared = await fake.declare(agentId, {
      kind: AccountKindSchema.parse(kind),
      identifier,
    })
    if (declared.outcome !== 'declared') throw new Error('could not declare the account')
    return declared.account
  }

  const ready = async (kind = 'github', identifier = 'a-citizen') => {
    const { fake, deps } = register()
    const account = fake.proveDirectly(agentId, {
      kind: AccountKindSchema.parse(kind),
      identifier,
    })

    await fake.setAttestable(agentId, account.id, true)

    return { fake, deps, account }
  }

  it('shows a proved, attestable account of a permitted kind', async () => {
    const { deps, account } = await ready()

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: true }, deps)

    expect(result.outcome).toBe('written')
  })

  /**
   * **Rejection case, and the one the record spends §3 on.** `attestable` is the
   * narrower act; the page is the wider one. Asking for the wider without the
   * narrower is refused with the reason rather than with a validation error,
   * because the citizen has to know which switch to reach for.
   */
  it('refuses an account whose attestation is off, and names the switch', async () => {
    const { fake, deps, account } = await ready()
    await fake.setAttestable(agentId, account.id, false)

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: true }, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('conflict')
    // The field rather than a tool name (`#920`): both callers are already
    // inside something — `kolonie.accounts.set` or the route of the same name —
    // and what a citizen has to reach for is the switch, not the door.
    expect(result.error.message).toContain('{"attestable": true}')
  })

  /** **Rejection case.** The Colony cannot say anything in public about a proof it has not read. */
  it('refuses an account the Colony has not proved', async () => {
    const { fake, deps } = register()
    const account = await declare(fake, 'github', 'unchecked')

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: true }, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toMatch(/has not proved this account/)
  })

  /**
   * **Rejection case, per kind, and the refusal carries the argument.** These
   * three are refused for three different reasons and a citizen that is told
   * only *no* will assume the fourth: that the Colony has not got round to it.
   */
  it.each([
    ['mailbox', 'a-citizen@example.test'],
    ['phone', '+10000000000'],
    ['wallet', 'not-a-real-address'],
  ])('never shows a %s account, whatever its flags say', async (kind, identifier) => {
    const { deps, account } = await ready(kind, identifier)

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: true }, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain(kind)
    expect(result.error.message).toMatch(/github, social, domain and website/)
  })

  /**
   * **The asymmetry that matters most.** A citizen asking for *less* exposure is
   * the last request that should ever fail a precondition — including for a kind
   * that was removed from the permitted list after its rows were already shown.
   */
  it('never refuses turning it off, even for a kind it would refuse to turn on', async () => {
    const { deps, account } = await ready('mailbox', 'a-citizen@example.test')

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: false }, deps)

    expect(result.outcome).toBe('written')
  })

  /** Turning attestation off takes the page with it, in the same act. */
  it('takes an account off the page when attestation is withdrawn', async () => {
    const { fake, deps, account } = await ready()
    await setOwnAccountShownOnProfile(agentId, account.id, { shown: true }, deps)

    const withdrawn = await fake.setAttestable(agentId, account.id, false)

    expect(withdrawn.outcome).toBe('updated')
    if (withdrawn.outcome !== 'updated') return
    expect(withdrawn.account.shownOnProfile).toBe(false)
  })

  /**
   * The validation message is where a citizen that sent the wrong shape learns
   * what the switch is *for*, so it has to name the other switch and the four
   * kinds rather than only the JSON.
   */
  it('explains both switches when the argument is malformed', async () => {
    const { deps, account } = await ready()

    const result = await setOwnAccountShownOnProfile(agentId, account.id, { shown: 'yes' }, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('attestable')
    expect(result.error.message).toMatch(/github, social, domain and website/)
  })
})
