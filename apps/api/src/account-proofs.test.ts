import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AccountKindSchema, AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { PageRead, PageReader } from '@kolonie-ai/verifiers'
import {
  fakeAccountProofs,
  fakeAccountRegister,
  type FakeAccountRegister,
} from './__fixtures__/accounts.js'
import type { AccountProofDependencies } from './account-proofs.js'
import { openProof, openProofAsText, proofAsText, submitPostProof } from './account-proofs.js'

/**
 * The two generic proofs (`#520`).
 *
 * **Unit tests over the fake rather than route tests**, on the argument
 * `accounts.test.ts` makes about the mailbox defect: what is under test here is the
 * decision each refusal takes, and those are the lines a fixture cannot get wrong
 * for you. Whether Postgres spends a row exactly once under two concurrent
 * submissions is asserted in `packages/db`, against a real database, where that
 * property lives.
 */

const agentId: AgentId = AgentIdSchema.parse(randomUUID())
const another: AgentId = AgentIdSchema.parse(randomUUID())

let register: FakeAccountRegister
let deps: AccountProofDependencies

/** A reader that answers one canned page, so no test needs a network. */
const readerServing = (page: PageRead): PageReader => ({ read: async () => page })

const withReader = (page: PageRead): AccountProofDependencies => ({
  ...deps,
  reader: readerServing(page),
})

/** The mailbox a mail proof binds to, put in place the way a rung would have. */
const withProvedMailbox = (owner: AgentId = agentId): string => {
  const address = `agent-${owner.slice(0, 8)}@mail.example`
  register.proveDirectly(owner, { kind: AccountKindSchema.parse('mailbox'), identifier: address })

  return address
}

beforeEach(() => {
  register = fakeAccountRegister()
  deps = { proofs: fakeAccountProofs(register), challengeDomain: 'challenge.example' }
})

describe('opening a proof', () => {
  it('opens one for a kind the Colony has never heard of', async () => {
    const opened = await openProof(
      agentId,
      { kind: 'trello', identifier: 'colette-board', method: 'provider-post' },
      deps,
    )

    expect(opened.outcome).toBe('ok')
    if (opened.outcome !== 'ok') return

    // The whole point of `#520`: `trello` cost no migration, no verifier and no
    // deploy. A kind absent from `KNOWN_ACCOUNT_KINDS` has to open cleanly.
    expect(opened.response.kind).toBe('trello')
    expect(opened.response.secret).toMatch(/^kol_acct_[0-9a-f]+$/)
    // A post proof has nowhere to forward to, and says so rather than composing
    // an address nobody could use.
    expect(opened.response.forwardTo).toBeNull()
  })

  it('gives a mail proof an address under the configured host', async () => {
    withProvedMailbox()

    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      deps,
    )

    expect(opened.outcome).toBe('ok')
    if (opened.outcome !== 'ok') return
    expect(opened.response.forwardTo).toBe(`${opened.response.secret}@challenge.example`)
  })

  it('refuses a mail proof from a citizen with no proved mailbox', async () => {
    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      deps,
    )

    expect(opened.outcome).toBe('rejected')
    if (opened.outcome !== 'rejected') return
    expect(opened.error.code).toBe('conflict')
    // The refusal has to name the way out, not only the wall: a post proof needs
    // no mailbox at all.
    expect(opened.error.message).toContain('provider-post')
  })

  it('refuses a mail proof when the deployment can receive no mail', async () => {
    withProvedMailbox()

    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      { ...deps, challengeDomain: '' },
    )

    // Refused rather than answered with `kol_acct_…@`, which is a value a citizen
    // would spend an afternoon trying to forward to.
    expect(opened.outcome).toBe('rejected')
    if (opened.outcome !== 'rejected') return
    expect(opened.error.message).toContain('provider-post')
  })

  it('refuses an account another citizen has already proved', async () => {
    register.claimForAnother('trello', 'shared-board')

    const opened = await openProof(
      agentId,
      { kind: 'trello', identifier: 'shared-board', method: 'provider-post' },
      deps,
    )

    expect(opened.outcome).toBe('rejected')
    if (opened.outcome !== 'rejected') return
    expect(opened.error.code).toBe('conflict')
  })

  it('tells a mail proof to forward from its proved mailbox, and says why', async () => {
    withProvedMailbox()

    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      deps,
    )
    if (opened.outcome !== 'ok') throw new Error('expected the proof to open')

    const text = openProofAsText(opened.response)

    expect(text).toContain(opened.response.forwardTo ?? '')
    expect(text).toContain(opened.response.secret)
    // The binding is the part an agent has to understand, so the instruction
    // carries the reason rather than only the rule.
    expect(text).toContain('proved mailbox')
    // And nothing anywhere asks for a credential.
    expect(text).toContain('password')
    expect(text).toContain('vault')
  })
})

describe('submitting a post proof', () => {
  /**
   * `provider` is `null` and never `undefined` for *no provider named*: passing
   * `undefined` to a defaulted parameter is what the default is for, so the
   * sentinel has to be a value.
   */
  const openPost = async (identifier = 'colette-board', provider: string | null = 'trello.com') => {
    const opened = await openProof(
      agentId,
      {
        kind: 'trello',
        identifier,
        method: 'provider-post',
        ...(provider === null ? {} : { provider }),
      },
      deps,
    )
    if (opened.outcome !== 'ok') throw new Error('expected the proof to open')

    return opened.response
  }

  it('proves the account when the string is in the page', async () => {
    const proof = await openPost()

    const submitted = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/colette-board' },
      withReader({
        outcome: 'read',
        html: `<p>hello ${proof.secret}</p>`,
        contentType: 'text/html',
      }),
    )

    expect(submitted.outcome).toBe('ok')
    if (submitted.outcome !== 'ok') return
    expect(submitted.response).toMatchObject({
      kind: 'trello',
      identifier: 'colette-board',
      provedBy: 'provider-post',
    })

    /**
     * **The walk, asked for at the one moment it can be answered** (`#907`),
     * prefilled with the three facts the Colony already holds so that what is
     * left is the part only the agent saw.
     */
    expect(submitted.response.walk).toMatchObject({
      call: 'kolonie.accounts.walk-report',
      kind: 'trello',
      provider: 'trello.com',
      outcome: 'proved',
    })
    expect(submitted.response.walk?.questions.map((one) => one.field)).toEqual([
      'did',
      'broke',
      'changed',
      'discarded',
    ])

    /** An offer and never a gate: the response says so in the same breath. */
    expect(proofAsText(submitted.response)).toContain('costs you nothing')

    const held = await register.list(agentId)
    const account = held.find((row) => row.kind === 'trello')
    expect(account?.proved).toBe(true)
    // The strength travels with the proof and is not a rung's.
    expect(account?.provedBy).toBe('provider-post')
    // Possession, and no capability. `capabilities` is what a verdict proved an
    // account can *do*, and publishing a string is not that.
    expect(account?.capabilities).toEqual([])
    // The provider named at mint lands on the row, so the aggregate can count it
    // without the citizen making a second call it would forget.
    expect(account?.provider).toBe('trello.com')
  })

  /**
   * **The rejection case in `#907`'s acceptance criteria.** A proof succeeds,
   * grants everything it grants, and is recorded identically whether or not a
   * walk follows it — the ask is an offer and never a toll on proving an
   * account, which is the one thing the Colony most wants agents to do.
   *
   * Where no provider was named there is nothing to prefill: a walk is keyed on
   * `(kind, provider)`, and an ask the Colony cannot fill in is the form-filling
   * the prefill exists to remove. Absent rather than guessed.
   */
  it('proves an account with no provider named, and asks for no walk', async () => {
    const proof = await openPost('colette-noprovider', null)

    const submitted = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/colette-noprovider' },
      withReader({
        outcome: 'read',
        html: `<p>hello ${proof.secret}</p>`,
        contentType: 'text/html',
      }),
    )

    expect(submitted.outcome).toBe('ok')
    if (submitted.outcome !== 'ok') return

    expect(submitted.response.walk).toBeUndefined()
    expect(proofAsText(submitted.response)).not.toContain('walk-report')

    /** Recorded identically: the account is proved and carries the same strength. */
    const held = await register.list(agentId)
    const account = held.find((row) => row.identifier === 'colette-noprovider')
    expect(account?.proved).toBe(true)
    expect(account?.provedBy).toBe('provider-post')
  })

  it('does not spend the proof when the string is absent, so a retry works', async () => {
    const proof = await openPost()

    const missed = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/colette-board' },
      withReader({ outcome: 'read', html: '<p>nothing here yet</p>', contentType: 'text/html' }),
    )

    expect(missed.outcome).toBe('rejected')
    if (missed.outcome !== 'rejected') return
    expect(missed.error.code).toBe('validation_failed')

    // The rejection case that matters most: a citizen whose page had not deployed
    // yet must not lose the string. The same proof, the same id, and it lands.
    const retried = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/colette-board' },
      withReader({ outcome: 'read', html: proof.secret, contentType: 'text/plain' }),
    )

    expect(retried.outcome).toBe('ok')
  })

  it('answers an unreachable page as the Colony’s problem and not the citizen’s', async () => {
    const proof = await openPost()

    const submitted = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/colette-board' },
      withReader({ outcome: 'unavailable', reason: 'it answered 503.' }),
    )

    expect(submitted.outcome).toBe('rejected')
    if (submitted.outcome !== 'rejected') return
    /**
     * **Never `validation_failed`.** A page being unreachable is not evidence that
     * the string is absent, and a citizen who published correctly must not be sent
     * to look for a mistake that is not its own.
     */
    expect(submitted.error.code).toBe('internal')
    expect(submitted.error.message).toContain('not your problem')
  })

  it('answers a 404 as the address being wrong, which a retry will not fix', async () => {
    const proof = await openPost()

    const submitted = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/typo' },
      withReader({ outcome: 'missing', reason: 'it answered 404.' }),
    )

    expect(submitted.outcome).toBe('rejected')
    if (submitted.outcome !== 'rejected') return
    // The other side of the split: the site answered that there is no such page,
    // which is the citizen's own address and just as true in five minutes.
    expect(submitted.error.code).toBe('validation_failed')
  })

  it('refuses a submission against a mail proof', async () => {
    withProvedMailbox()
    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      deps,
    )
    if (opened.outcome !== 'ok') throw new Error('expected the proof to open')

    const submitted = await submitPostProof(
      agentId,
      opened.response.id,
      { url: 'https://notion.so/colette' },
      withReader({ outcome: 'read', html: opened.response.secret, contentType: 'text/html' }),
    )

    expect(submitted.outcome).toBe('rejected')
    if (submitted.outcome !== 'rejected') return
    // A mail proof has one way to close and this is not it. A second way is the
    // one that gets the sender check wrong.
    expect(submitted.error.message).toContain('forward')
  })

  it('refuses a proof belonging to another citizen', async () => {
    const proof = await openPost()

    const submitted = await submitPostProof(
      another,
      proof.id,
      { url: 'https://trello.com/colette-board' },
      withReader({ outcome: 'read', html: proof.secret, contentType: 'text/html' }),
    )

    expect(submitted.outcome).toBe('rejected')
    if (submitted.outcome !== 'rejected') return
    expect(submitted.error.code).toBe('conflict')
  })

  it('cannot be spent twice', async () => {
    const proof = await openPost()
    const page: PageRead = { outcome: 'read', html: proof.secret, contentType: 'text/html' }

    expect(
      (await submitPostProof(agentId, proof.id, { url: 'https://trello.com/x' }, withReader(page)))
        .outcome,
    ).toBe('ok')

    const again = await submitPostProof(
      agentId,
      proof.id,
      { url: 'https://trello.com/x' },
      withReader(page),
    )

    expect(again.outcome).toBe('rejected')
  })
})

describe('a forwarded mail', () => {
  const openMail = async () => {
    const address = withProvedMailbox()
    const opened = await openProof(
      agentId,
      { kind: 'notion', identifier: 'colette', method: 'provider-mail' },
      deps,
    )
    if (opened.outcome !== 'ok') throw new Error('expected the proof to open')

    return { address, proof: opened.response }
  }

  it('proves the account when it arrives from the proved mailbox', async () => {
    const { address, proof } = await openMail()

    const arrived = await deps.proofs.inbound(proof.secret, address)

    expect(arrived.outcome).toBe('accepted')

    const account = (await register.list(agentId)).find((row) => row.kind === 'notion')
    expect(account?.proved).toBe(true)
    expect(account?.provedBy).toBe('provider-mail')
    expect(account?.capabilities).toEqual([])
  })

  it('proves nothing when it arrives from anywhere else', async () => {
    const { proof } = await openMail()

    /**
     * **The rejection case the whole method rests on.** The forwarded message is
     * evidence only because it came from an address the Colony itself verified;
     * from any other sender it is a mail anybody could have sent, and a token in
     * an address is a value anybody on the internet can write to.
     */
    const arrived = await deps.proofs.inbound(proof.secret, 'stranger@example.org')

    expect(arrived.outcome).toBe('sender_mismatch')
    expect((await register.list(agentId)).some((row) => row.kind === 'notion')).toBe(false)
  })

  it('says nothing about a token it does not hold', async () => {
    const arrived = await deps.proofs.inbound('kol_acct_deadbeef', 'stranger@example.org')

    // Distinguishable from every other outcome, because the inbound handler tries
    // the mailbox challenges through the same door and needs to know this token is
    // not one of ours.
    expect(arrived.outcome).toBe('unknown_token')
  })
})

describe('what a citizen is told it now holds', () => {
  it('names the strength rather than letting a citizen infer a rung', async () => {
    const text = proofAsText({
      kind: 'trello',
      identifier: 'colette-board',
      provedBy: 'provider-post',
    })

    expect(text).toContain('provider-post')
    // Said out loud, because a citizen told only *proved* would carry a belief the
    // register does not — and would discover the difference from a refusal later.
    expect(text).toContain('not as a rung')
    expect(text).toContain('No capability is claimed')
  })
})
