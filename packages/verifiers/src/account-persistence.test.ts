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
import {
  AccountPersistenceVerifier,
  mailboxRecheck,
  webServerRecheck,
  websiteRecheck,
  type AccountRecheck,
  type MailboxRechecks,
} from './account-persistence.js'
import type { PageReader } from './website-verify.js'

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

/**
 * The `website` strategy (`#242`).
 *
 * Every case is driven through the {@link PageReader} port rather than the
 * network, which is what the port is for: a timeout and a 5xx are the outcomes
 * this measurement has to get right, and neither is producible against a real
 * host on purpose.
 */
describe('websiteRecheck', () => {
  const proved = anAccount({
    kind: AccountKindSchema.parse('website'),
    identifier: 'https://example.test/kolonie',
  })

  const pageServing = (html: string): PageReader => ({
    read: async () => ({ outcome: 'read', html, contentType: 'text/html' }),
  })

  const tagged = (token: string) => `<html><head><meta name="kolonie-verify" content="${token}">`

  const strategyOver = (pages: PageReader, tokens: readonly string[] = ['fresh-token']) =>
    websiteRecheck({ pages, challenges: { openWebsiteTokens: async () => tokens } })

  it('holds when the proved page serves a freshly issued token', async () => {
    const found = await strategyOver(pageServing(tagged('fresh-token'))).recheck(agent.id, proved)

    expect(found.outcome).toBe('held')
  })

  /**
   * The measurement this strategy exists for: the *same page*, not any page the
   * citizen controls now. A citizen that stood up a second site has shown it can
   * pass `website-verify` twice.
   */
  it('reads the URL in the register and never one the citizen names now', async () => {
    const asked: string[] = []
    const found = await strategyOver({
      read: async (url) => {
        asked.push(url)
        return { outcome: 'read', html: tagged('fresh-token'), contentType: 'text/html' }
      },
    }).recheck(agent.id, proved)

    expect(asked).toEqual([proved.identifier])
    expect(found.outcome).toBe('held')
  })

  it('is gone when the page answers and carries no token the Colony issued', async () => {
    const found = await strategyOver(pageServing(tagged('some-other-token'))).recheck(
      agent.id,
      proved,
    )

    expect(found.outcome).toBe('gone')
  })

  it('is gone when the page is no longer served', async () => {
    const found = await strategyOver({
      read: async () => ({ outcome: 'missing', reason: 'it answered 404.' }),
    }).recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
    expect(found.evidence).toContain('404')
  })

  /**
   * A host having a bad afternoon is not a citizen abandoning its site, and the
   * two rejection cases the issue names are the ones that must never read as
   * evidence about the citizen.
   */
  it.each([
    ['a timeout', 'it did not answer within 10000ms.'],
    ['a 5xx', 'it answered 503.'],
  ])('is unavailable on %s, never gone', async (_case, reason) => {
    const found = await strategyOver({
      read: async () => ({ outcome: 'unavailable', reason }),
    }).recheck(agent.id, proved)

    expect(found.outcome).toBe('unavailable')
  })

  /** The tag that earned the skill proves only that nobody deleted it. */
  it('is gone when the citizen has minted no fresh token', async () => {
    const found = await strategyOver(pageServing(tagged('fresh-token')), []).recheck(
      agent.id,
      proved,
    )

    expect(found.outcome).toBe('gone')
    expect(found.evidence).toContain('kolonie.academy.website.challenge')
  })

  /**
   * The whole model, asserted where it can be seen: a `gone` page produces a
   * failed badge and the verdict says the skill is untouched. Nothing in this
   * package can remove `website`, and the evidence is what tells the citizen so.
   */
  it('takes nothing away when the page is gone', async () => {
    const verifier = new AccountPersistenceVerifier({
      accounts: { recheckable: async () => [proved] },
      checks: [
        strategyOver({ read: async () => ({ outcome: 'missing', reason: 'it answered 404.' }) }),
      ],
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ recheck: 'gone', kind: 'website' })
    expect(result.evidence).toContain('the skill you earned with it is permanent')
  })
})

/**
 * The `mailbox` strategy (`#226`).
 *
 * The port is what the API left behind, so every state a mailbox re-check can be
 * in is producible here without a mailer: waiting, answered, closed unanswered,
 * and refused by the address.
 */
describe('mailboxRecheck', () => {
  const proved = anAccount({
    kind: AccountKindSchema.parse('mailbox'),
    identifier: 'colette@example.test',
  })

  const strategyOver = (
    start: MailboxRechecks['start'],
    sendProved: MailboxRechecks['sendProved'] = () => false,
  ) => mailboxRecheck({ rechecks: { start, sendProved } })

  /**
   * The fourth outcome, and the reason it exists: the Colony cannot answer this
   * question by itself, so *the check is running* has to be sayable.
   */
  it('is pending while the citizen has not answered, and names the tool and the deadline', async () => {
    const found = await strategyOver(async () => ({
      outcome: 'open',
      address: proved.identifier,
      expiresAt: '2026-09-01T00:00:00.000Z',
    })).recheck(agent.id, proved)

    expect(found.outcome).toBe('pending')
    expect(found.evidence).toContain('kolonie.academy.email.code')
    expect(found.evidence).toContain('2026-09-01')
  })

  it('holds once the code has been handed back', async () => {
    const found = await strategyOver(async () => ({
      outcome: 'answered',
      address: proved.identifier,
    })).recheck(agent.id, proved)

    expect(found.outcome).toBe('held')
  })

  /**
   * Silence is the ambiguous case, and the whole model turns on refusing to
   * read it as evidence: an unread mail and a dead mailbox look identical here.
   */
  it('is unavailable when the window closes unanswered, and never gone', async () => {
    const found = await strategyOver(async () => ({
      outcome: 'window_closed',
      address: proved.identifier,
    })).recheck(agent.id, proved)

    expect(found.outcome).toBe('unavailable')
    expect(found.evidence).toContain('not read as the mailbox being gone')
  })

  it('is gone only on a permanent delivery failure', async () => {
    const found = await strategyOver(async () => ({
      outcome: 'undeliverable',
      reason: '550 5.1.1 no such user',
      permanent: true,
    })).recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
  })

  it.each([
    ['a soft bounce', '451 try again later'],
    ['a full mailbox', '452 mailbox full'],
    ['a provider error', '421 service unavailable'],
  ])('is unavailable on %s', async (_case, reason) => {
    const found = await strategyOver(async () => ({
      outcome: 'undeliverable',
      reason,
      permanent: false,
    })).recheck(agent.id, proved)

    expect(found.outcome).toBe('unavailable')
  })

  /**
   * A citizen that never proved sending is not failed for not doing it now —
   * the defect D-031 found one node over, and the reason the rung was split.
   */
  it('re-proves sending only where sending was proved', async () => {
    const receiveOnly = await strategyOver(async () => ({
      outcome: 'answered',
      address: proved.identifier,
    })).recheck(agent.id, proved)

    const both = await strategyOver(
      async () => ({ outcome: 'answered', address: proved.identifier }),
      () => true,
    ).recheck(agent.id, proved)

    expect(receiveOnly.outcome).toBe('held')
    expect(receiveOnly.evidence).toContain('Only receiving was re-checked')
    expect(both.evidence).toContain('send capability')
  })

  /** A `pending` strategy leaves the submission open and spends no attempt. */
  it('produces a pending verdict rather than a failure', async () => {
    const verifier = new AccountPersistenceVerifier({
      accounts: { recheckable: async () => [proved] },
      checks: [
        strategyOver(async () => ({
          outcome: 'open',
          address: proved.identifier,
          expiresAt: '2026-09-01T00:00:00.000Z',
        })),
      ],
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('pending')
    expect(result.metadata).toMatchObject({ recheck: 'pending', kind: 'mailbox' })
  })
})

/**
 * The fourth kind (`#395`) — the citizen still runs a server, ninety days on.
 *
 * **A strategy rather than the `web-server-persistence` rung the issue asked
 * for**, chosen by the maintainer on 2026-08-05 against `#152`'s record that
 * there is no `website-persistence` node *and there will not be one*. Everything
 * the issue decided survives the change of shape, and these are what say so.
 *
 * Every address is `example.test` — a reserved TLD, per RFC 6761. Nothing here
 * reaches a network.
 */
describe('webServerRecheck', () => {
  const proved = anAccount({
    kind: AccountKindSchema.parse('web-server'),
    identifier: 'https://old.example.test',
  })

  const aProbe = (overrides: Record<string, unknown> = {}) => ({
    challengeId: '55555555-5555-4555-8555-555555555555',
    origin: 'https://now.example.test',
    which: 'first' as const,
    path: '/.well-known/kolonie/fresh-path',
    nonce: 'fresh-code',
    firstServedAt: null,
    ...overrides,
  })

  const strategyOver = (
    body: string | Error,
    // Explicitly `undefined` where a test is about there being no live probe —
    // a default parameter would silently substitute one and the test would pass
    // for the wrong reason, which is what happened writing it.
    probe: ReturnType<typeof aProbe> | undefined,
    status = 200,
  ) => {
    const asked: string[] = []
    const strategy = webServerRecheck({
      challenges: {
        liveProbe: async () => probe,
        openChallenge: async () => undefined,
      },
      fetch: async (url: string) => {
        asked.push(url)
        if (body instanceof Error) throw body
        return new Response(body, { status })
      },
    })
    return { strategy, asked }
  }

  it('holds when the server serves the code the Colony named today', async () => {
    const { strategy, asked } = strategyOver('fresh-code', aProbe())

    const found = await strategy.recheck(agent.id, proved)

    expect(found.outcome).toBe('held')
    expect(asked).toEqual(['https://now.example.test/.well-known/kolonie/fresh-path'])
  })

  /**
   * **The one place this parts company with `websiteRecheck`, and `#395` decided
   * it deliberately.** A citizen that moved its server still runs one, and
   * asking for the old address would certify the address rather than the citizen.
   */
  it('follows the origin the citizen names now, not the one in the register', async () => {
    const { strategy, asked } = strategyOver('fresh-code', aProbe())

    await strategy.recheck(agent.id, proved)

    expect(asked[0]).toContain('now.example.test')
    expect(asked[0]).not.toContain('old.example.test')
  })

  /**
   * **The rejection case the issue calls the point of the rung.** The old code
   * at the old path cannot pass, because neither is what a live probe names —
   * and the evidence says the code was not there rather than that the fetch
   * failed.
   */
  it('is gone when the server serves the earlier rung’s code', async () => {
    const { strategy } = strategyOver('the-code-from-ninety-days-ago', aProbe())

    const found = await strategy.recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
    expect(found.evidence).toContain('was not in what came back')
    expect(found.evidence).not.toContain('did not answer')
  })

  it('is gone when the earlier path is served and the one named today is not', async () => {
    const { strategy } = strategyOver('', aProbe(), 404)

    const found = await strategy.recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
    expect(found.evidence).toContain('404')
    expect(found.evidence).toContain('not serving the path the Colony named')
  })

  /**
   * **A server that does not answer at all is a `gone` and not an
   * `unavailable`**, which is the opposite call from `websiteRecheck` and the
   * whole reason this badge is worth having. A page is served by somebody else's
   * host and an afternoon of theirs is not evidence about the citizen; a server
   * the citizen runs *is* the citizen, and silence ninety days on is an answer.
   */
  it('is gone when nothing answers, rather than unavailable', async () => {
    const { strategy } = strategyOver(new Error('connect ECONNREFUSED'), aProbe())

    const found = await strategy.recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
    expect(found.outcome).not.toBe('unavailable')
    expect(found.evidence).toContain('did not answer')
    // And it says what a failure costs, which is nothing.
    expect(found.evidence).toContain('untouched')
  })

  /**
   * A fresh probe is required, and the wording tells the citizen it may name a
   * different origin — the fact it is most likely to guess wrong about.
   */
  it('is gone when no probe is live, and says the origin may be a new one', async () => {
    const { strategy } = strategyOver('fresh-code', undefined)

    const found = await strategy.recheck(agent.id, proved)

    expect(found.outcome).toBe('gone')
    expect(found.evidence).toContain('kolonie.academy.web-server.challenge')
    expect(found.evidence).toContain('does not have to be')
  })

  /** One fetch, where the rung asks twice. Ninety days does the rest. */
  it('asks once', async () => {
    const { strategy, asked } = strategyOver('fresh-code', aProbe())

    await strategy.recheck(agent.id, proved)

    expect(asked).toHaveLength(1)
  })
})
