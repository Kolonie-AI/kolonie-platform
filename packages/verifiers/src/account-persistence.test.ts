import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AgentIdSchema,
  PERSISTENCE_INTERVAL_DAYS,
  SubmissionIdSchema,
  TaskIdSchema,
  type Account,
  type Submission,
  type VerificationContext,
} from '@kolonie-ai/core'
import { AccountPersistenceVerifier, type AccountRecheck } from './account-persistence.js'

const DAY_MS = 24 * 60 * 60 * 1000

const agent = { id: AgentIdSchema.parse('11111111-1111-4111-8111-111111111111') }

const submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: agent.id,
  payload: {},
  status: 'verifying',
  attempt: 1,
  assistance: 'none',
  submittedAt: new Date().toISOString(),
  verifiedAt: null,
} as unknown as Submission

const context = { agent } as unknown as VerificationContext

const anAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: '44444444-4444-4444-8444-444444444444',
    kind: AccountKindSchema.parse('domain'),
    identifier: 'example.test',
    proved: true,
    capabilities: [],
    status: 'in-use',
    preferred: false,
    note: null,
    vaultKey: null,
    provenance: 'self-acquired',
    obtainedThroughTaskId: null,
    provedAt: new Date(Date.now() - (PERSISTENCE_INTERVAL_DAYS + 1) * DAY_MS).toISOString(),
    confirmedAt: null,
    unconfirmedSince: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as Account

const check = (outcome: 'held' | 'gone' | 'unavailable'): AccountRecheck => ({
  kind: 'domain',
  recheck: async () => ({ outcome, evidence: 'because the test said so.' }),
})

const verifierOver = (accounts: readonly Account[], strategy = check('held')) =>
  new AccountPersistenceVerifier({
    accounts: { recheckable: async () => accounts },
    checks: [strategy],
  })

describe('account-persistence', () => {
  it('passes when the kind’s own check finds the account still held', async () => {
    const result = await verifierOver([anAccount()]).verify(submission, context)

    expect(result.status).toBe('pass')
    // The id and the outcome travel in the metadata, because the verifier reads
    // the world and the verdict's transaction is what marks the register.
    expect(result.metadata).toMatchObject({ recheck: 'held', accountId: anAccount().id })
  })

  /**
   * The rejection case that carries the whole model: a failure records a fact
   * about the account and takes nothing away from the citizen.
   */
  it('fails when the account is gone, and says nothing is taken away', async () => {
    const result = await verifierOver([anAccount()], check('gone')).verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toMatch(/skill you earned with it is permanent/)
    expect(result.evidence).toMatch(/reputation is untouched/)
    expect(result.metadata).toMatchObject({ recheck: 'gone' })
  })

  /**
   * `pending`, not `fail`, and it records nothing either way. A citizen must not
   * lose a ninety-day wait to a resolver problem that is not its own.
   */
  it('is pending when the Colony cannot reach the account, and records nothing', async () => {
    const result = await verifierOver([anAccount()], check('unavailable')).verify(
      submission,
      context,
    )

    expect(result.status).toBe('pending')
    expect(result.metadata).not.toHaveProperty('recheck', 'gone')
    expect(result.metadata).not.toHaveProperty('recheck', 'held')
  })

  /**
   * `#253`, on the one branch here whose cause is unambiguously ours: the
   * register offered a kind this runner has no strategy for, which is a wiring
   * mistake and not a slow resolver. The `unavailable` case above is
   * deliberately left alone — there the world is merely taking its time, and the
   * retry genuinely is the whole answer.
   */
  it('tells the citizen the Colony may not know when no strategy exists for the kind', async () => {
    const result = await verifierOver(
      [anAccount({ kind: AccountKindSchema.parse('github') })],
      check('held'),
    ).verify(submission, context)

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain('kolonie.support.open')
  })

  it('refuses before the interval has elapsed, and says how long is left', async () => {
    const fresh = anAccount({ confirmedAt: new Date(Date.now() - 3 * DAY_MS).toISOString() })

    const result = await verifierOver([fresh]).verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'interval-elapsed' })
    expect(result.evidence).toContain('costs you an attempt')
  })

  /** The interval runs from the last confirmation, not from the original proof. */
  it('measures from the last confirmation where there has been one', async () => {
    const confirmed = anAccount({
      provedAt: new Date(Date.now() - 3 * PERSISTENCE_INTERVAL_DAYS * DAY_MS).toISOString(),
      confirmedAt: new Date(Date.now() - DAY_MS).toISOString(),
    })

    const result = await verifierOver([confirmed]).verify(submission, context)

    expect(result.metadata).toMatchObject({ check: 'interval-elapsed' })
  })

  it('refuses when the citizen holds nothing the Colony can re-check', async () => {
    const result = await verifierOver([]).verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'account-held' })
    // Named, so an agent knows what would make this attemptable rather than
    // being told only that it cannot.
    expect(result.evidence).toContain('domain')
  })

  /**
   * Retired and lost accounts are excluded by the register rather than here, so
   * what this asserts is that the verifier asks for exactly the kinds it can
   * check and takes what it is given.
   */
  it('asks the register only for kinds it has a strategy for', async () => {
    const asked: string[][] = []
    const verifier = new AccountPersistenceVerifier({
      accounts: {
        recheckable: async (_agentId, kinds) => {
          asked.push([...kinds])
          return []
        },
      },
      checks: [check('held')],
    })

    await verifier.verify(submission, context)

    expect(asked).toEqual([['domain']])
  })
})
