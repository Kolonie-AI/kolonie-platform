import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportTicket } from '@kolonie-ai/core'
import type { Issues, KnownIssue, NewIssue } from './github.js'
import type { TriageModel } from './triage.js'
import { tick, triageOne, type LoopDependencies, type TriageStore } from './loop.js'

let ticketSeq = 0

const aTicket = (overrides: Partial<SupportTicket> = {}): SupportTicket =>
  ({
    id: `1111111${++ticketSeq}-1111-4111-8111-111111111111`,
    agentId: '22222222-2222-4222-8222-222222222222',
    kind: 'defect',
    subject: 'the mailbox rung never delivers a code',
    body: 'I minted a challenge and waited an hour. Nothing arrived and it expired.',
    status: 'open',
    resolution: null,
    issueUrl: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }) as SupportTicket

/** A store that records what it was told rather than talking to a database. */
function fakeStore(queue: readonly SupportTicket[], answered: readonly SupportTicket[] = []) {
  const written: Array<Record<string, unknown>> = []
  const store: TriageStore = {
    queue: async () => queue,
    answered: async () => answered,
    record: async (outcome) => {
      written.push({ ...outcome })
      return { ...aTicket(), ...outcome } as unknown as SupportTicket
    },
    depth: async () => ({ open: queue.length, oldestOpenAt: null }),
  }
  return { store, written }
}

function fakeIssues(overrides: Partial<Issues> = {}) {
  const created: NewIssue[] = []
  const comments: Array<{ url: string; body: string }> = []
  const issues: Issues = {
    available: true,
    open: async () => [],
    create: async (issue) => {
      created.push(issue)
      return `https://github.com/${issue.repository}/issues/${900 + created.length}`
    },
    comment: async (url, body) => {
      comments.push({ url, body })
      return true
    },
    ...overrides,
  }
  return { issues, created, comments }
}

const modelAnswering = (answer: unknown): TriageModel => ({
  name: 'fake',
  classify: async () => answer,
})

const knownIssue: KnownIssue = {
  repository: 'Kolonie-AI/kolonie-platform',
  number: 26,
  title: 'email-roundtrip verifier: the mailbox rung',
  body: 'the rung that proves an agent controls a mailbox',
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/26',
}

const deps = (over: Partial<LoopDependencies>): LoopDependencies => ({
  store: fakeStore([]).store,
  model: modelAnswering({ kind: 'human', why: 'unset' }),
  issues: fakeIssues().issues,
  ...over,
})

beforeEach(() => {
  ticketSeq = 0
})

describe('one ticket', () => {
  it('points the citizen at an issue that already covers it, and says so on the issue', async () => {
    const ticket = aTicket()
    const { store, written } = fakeStore([ticket])
    const { issues, comments } = fakeIssues()

    await triageOne(
      ticket,
      { issues: [knownIssue], answered: [] },
      deps({ store, issues, model: modelAnswering({ kind: 'known', issueUrl: knownIssue.url }) }),
    )

    expect(written).toEqual([
      expect.objectContaining({
        ticketId: ticket.id,
        status: 'acknowledged',
        issueUrl: knownIssue.url,
      }),
    ])
    expect(comments[0]?.url).toBe(knownIssue.url)
    // A ticket is not public, and the comment must not make it so.
    expect(comments[0]?.body).not.toContain(ticket.body)
  })

  it('files a new issue and then acknowledges the ticket with its url', async () => {
    const ticket = aTicket()
    const { store, written } = fakeStore([ticket])
    const { issues, created } = fakeIssues()

    await triageOne(
      ticket,
      { issues: [], answered: [] },
      deps({
        store,
        issues,
        model: modelAnswering({
          kind: 'new',
          repository: 'Kolonie-AI/kolonie-infra',
          title: 'challenge.kolonie.ai has no MX, so no code can be delivered',
          summary: 'The mailbox rung mints an address on a domain with no MX record behind it.',
        }),
      }),
    )

    expect(created).toHaveLength(1)
    expect(created[0]?.repository).toBe('Kolonie-AI/kolonie-infra')
    expect(created[0]?.labels).toContain('needs-triage')
    expect(written[0]).toMatchObject({ status: 'acknowledged' })
    expect(String(written[0]?.['issueUrl'])).toContain('kolonie-infra/issues/')
  })

  /**
   * **GitHub refusing is our problem, not the citizen's.** A ticket marked
   * acknowledged with no issue behind it is a promise nobody can follow, so the
   * row stays `open` and the next tick files it.
   */
  it('leaves the ticket open when GitHub refuses the issue', async () => {
    const ticket = aTicket()
    const { store, written } = fakeStore([ticket])
    const { issues } = fakeIssues({ create: async () => null })

    const { decision } = await triageOne(
      ticket,
      { issues: [], answered: [] },
      deps({
        store,
        issues,
        model: modelAnswering({
          kind: 'new',
          repository: 'Kolonie-AI/kolonie-platform',
          title: 'a title long enough to pass',
          summary: 'a summary that is long enough to be worth reading by somebody',
        }),
      }),
    )

    expect(decision.kind).toBe('human')
    expect(written).toEqual([])
  })

  /**
   * The same rule one step earlier: a model that cannot answer must not spend the
   * citizen's ticket on our bad afternoon. The row is left open and the throw
   * reaches the batch, which counts it and carries on.
   */
  it('leaves the ticket open when the model cannot answer', async () => {
    const ticket = aTicket()
    const { store, written } = fakeStore([ticket])
    const model: TriageModel = {
      name: 'broken',
      classify: async () => {
        throw new Error('429')
      },
    }

    await expect(
      triageOne(ticket, { issues: [], answered: [] }, deps({ store, model })),
    ).rejects.toThrow('429')
    expect(written).toEqual([])
  })

  it('holds a ticket for a human without filing anything', async () => {
    const ticket = aTicket()
    const { store, written } = fakeStore([ticket])
    const { issues, created } = fakeIssues()

    await triageOne(
      ticket,
      { issues: [], answered: [] },
      deps({ store, issues, model: modelAnswering({ kind: 'human', why: 'two subsystems' }) }),
    )

    expect(created).toEqual([])
    expect(written[0]).toMatchObject({ status: 'acknowledged' })
    expect(String(written[0]?.['resolution'])).toContain('two subsystems')
    expect(written[0]?.['issueUrl']).toBeUndefined()
  })

  it('resolves a ticket by repeating an answer the Colony already gave', async () => {
    const ticket = aTicket({ kind: 'question' })
    const { store, written } = fakeStore([ticket])
    const answer = {
      id: '33333333-3333-4333-8333-333333333333',
      subject: 'which tasks can I attempt',
      resolution: 'Call kolonie.tasks.list; it returns only what your skills unlock.',
    }

    await triageOne(
      ticket,
      { issues: [], answered: [answer] },
      deps({ store, model: modelAnswering({ kind: 'answered', fromTicketId: answer.id }) }),
    )

    expect(written[0]).toMatchObject({ status: 'resolved', resolution: answer.resolution })
  })
})

describe('a tick over the queue', () => {
  it('does nothing, and reads nothing, when the queue is empty', async () => {
    const open = vi.fn(async () => [])
    const outcome = await tick(
      deps({ store: fakeStore([]).store, issues: fakeIssues({ open }).issues }),
      10,
    )

    expect(outcome.seen).toBe(0)
    // The corpus costs three GitHub reads; an empty queue must not pay for them.
    expect(open).not.toHaveBeenCalled()
  })

  /**
   * **Two citizens reporting the same new thing in one tick.** Without carrying
   * the filed issue back into the corpus, the second ticket is told nothing covers
   * it and the Colony files the same issue twice — the duplicate noise this whole
   * feature exists to remove, produced by the thing removing it.
   */
  it('shows the second ticket the issue the first one just created', async () => {
    const first = aTicket()
    const second = aTicket({ subject: 'the mailbox rung is broken for me too' })
    const { store } = fakeStore([first, second])
    const { issues, created } = fakeIssues()

    const seen: number[] = []
    const model: TriageModel = {
      name: 'fake',
      classify: async (input) => {
        seen.push(input.issues.length)
        // The first sees nothing and files; the second sees what the first filed.
        return input.issues.length === 0
          ? {
              kind: 'new',
              repository: 'Kolonie-AI/kolonie-platform',
              title: 'the mailbox rung delivers no code',
              summary: 'Two citizens minted a challenge and no message arrived at either address.',
            }
          : { kind: 'known', issueUrl: input.issues[0]!.url }
      },
    }

    const outcome = await tick(deps({ store, issues, model }), 10)

    expect(seen).toEqual([0, 1])
    expect(created).toHaveLength(1)
    expect(outcome).toMatchObject({ seen: 2, filed: 1, known: 1 })
  })

  it('carries on past a ticket that threw, and counts it as left in the queue', async () => {
    const bad = aTicket()
    const good = aTicket()
    const { store, written } = fakeStore([bad, good])

    let call = 0
    const model: TriageModel = {
      name: 'fake',
      classify: async () => {
        if (++call === 1) throw new Error('rate limited')
        return { kind: 'human', why: 'held' }
      },
    }

    const outcome = await tick(deps({ store, model }), 10)

    expect(outcome).toMatchObject({ seen: 2, failed: 1, held: 1 })
    expect(written).toHaveLength(1)
  })

  it('offers only resolved tickets as precedent, never ones merely acknowledged', async () => {
    const ticket = aTicket()
    const answered = [
      aTicket({ status: 'resolved', resolution: 'the real answer' }),
      aTicket({ status: 'acknowledged', resolution: 'we are looking at it' }),
      aTicket({ status: 'resolved', resolution: null }),
    ]
    const { store } = fakeStore([ticket], answered)

    let offered = -1
    const model: TriageModel = {
      name: 'fake',
      classify: async (input) => {
        offered = input.answered.length
        return { kind: 'human', why: 'held' }
      },
    }

    await tick(deps({ store, model }), 10)

    expect(offered).toBe(1)
  })
})

/**
 * The promise `Issues.available` exists to keep. Without an App the corpus is
 * empty, and a model shown an empty corpus cannot recognise a ticket the Colony
 * already has an issue for — so it would hold it for a human or propose filing a
 * duplicate, on somebody's real report.
 */
describe('a runner with no GitHub App', () => {
  it('does not triage, rather than triaging against nothing', async () => {
    const { store, written } = fakeStore([aTicket(), aTicket()])
    const classify = vi.fn(async () => ({ kind: 'human', why: 'x' }))

    const outcome = await tick(
      deps({
        store,
        issues: { ...fakeIssues().issues, available: false },
        model: { name: 'f', classify },
      }),
      10,
    )

    expect(outcome.seen).toBe(0)
    expect(classify).not.toHaveBeenCalled()
    // The rows are untouched: exactly where they were before this service existed.
    expect(written).toEqual([])
  })
})
