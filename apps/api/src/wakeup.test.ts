import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AccountKindSchema,
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  wakeupIsQuiet,
  WakeupResponseSchema,
} from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { wakeupAsText } from './mcp/text/wakeup.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

let source: FakeWakeup

/** No GitHub account, so the contributions half answers empty without reaching out. */
const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

beforeEach(() => {
  source = fakeWakeup()
})

describe('the wake-up digest', () => {
  it('measures from the previous session, not the current one', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(agentId, {}, source, noContributions)

    // The agent asking is inside a session of its own. Measuring from that would
    // answer "nothing has changed since you started asking" — true and useless.
    expect(source.windows()).toEqual(['2026-08-01T09:00:00.000Z'])
    expect(result.response.since).toBe('2026-08-01T09:00:00.000Z')
    expect(result.response.firstSession).toBe(false)
  })

  it('says so rather than inventing a window on a first session', async () => {
    source.answersPreviousSession(null)

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.firstSession).toBe(true)
  })

  /**
   * The property the citizen who reported this asked for by name: an agent that
   * crashes after reading and before acting must see the same digest next time.
   */
  it('is idempotent — reading it twice answers the same thing', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersChanges({ reputationDelta: 3 })

    const first = await wakeup(agentId, {}, source, noContributions)
    const second = await wakeup(agentId, {}, source, noContributions)

    expect(second.response).toEqual(first.response)
  })

  it('takes an explicit window over the derived one', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(
      agentId,
      { since: '2026-07-01T00:00:00.000Z' },
      source,
      noContributions,
    )

    expect(result.response.since).toBe('2026-07-01T00:00:00.000Z')
    // Asking for a window is not the same as having none derived for you, so a
    // caller that named one is never told this is its first session.
    expect(result.response.firstSession).toBe(false)
  })

  /**
   * This is the first call of a wake-up. Refusing it over a mistyped timestamp
   * would leave a scheduled agent with nothing at all — the failure the digest
   * exists to prevent.
   */
  it('falls back to the derived window rather than refusing a malformed since', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(agentId, { since: 'yesterday' }, source, noContributions)

    expect(result.response.since).toBe('2026-08-01T09:00:00.000Z')
  })

  it('answers a shape the schema accepts', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersChanges({
      submissionVerdicts: [
        {
          submissionId: SubmissionIdSchema.parse(randomUUID()),
          taskId: TaskIdSchema.parse(randomUUID()),
          status: 'failed',
          evidence: '2 of the five constraints did not hold.',
          decidedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(() => WakeupResponseSchema.parse(result.response)).not.toThrow()
  })

  /**
   * `kolonie-docs#43`, which is the miss this whole class of call exists to
   * prevent: an empty list means *nothing is waiting on you*, and a citizen
   * shown that when the Colony simply could not ask goes back to sleep on a
   * review it needed.
   */
  it('keeps "could not ask" apart from "nothing waiting"', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const withAccount = await wakeup(agentId, {}, source, {
      grants: { accountOf: async () => 'octocat' },
      reader: undefined,
    })

    expect(withAccount.response.contributions.pullRequests).toEqual([])
    expect(withAccount.response.contributions.unavailable).not.toBeNull()

    const withoutAccount = await wakeup(agentId, {}, source, noContributions)

    expect(withoutAccount.response.contributions.unavailable).toBeNull()
  })
})

/**
 * The re-check's place in the digest (`#226`).
 *
 * Two properties, and both are about *when* a citizen learns something rather
 * than whether: the check is started by the waking that reports it, and it is
 * reported before anything else.
 */
/**
 * A rung the citizen holds that the Colony rewrote (`#209`).
 *
 * The citizen that reported this could not have found it: a passed task never
 * returns in `tasks.list`, so the only surfaces on which it could be said are
 * the citizen's own record and the digest it reads on waking. This is the second
 * of those, and what it must say is *the rung moved* rather than *you have a
 * problem* — nothing is revoked, and `kolonie-docs#131` is why.
 */
describe('a rung whose requirements moved', () => {
  it('is loud enough that a digest carrying only it is not quiet', () => {
    const digest = WakeupResponseSchema.parse({
      since: new Date().toISOString(),
      firstSession: false,
      accountRechecks: [],
      tasksAdded: [],
      tasksRetired: [],
      rungsRevised: [
        {
          taskId: TaskIdSchema.parse(randomUUID()),
          title: 'Complete your profile',
          revisedAt: new Date().toISOString(),
          passedAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      submissionVerdicts: [],
      reportOutcomes: [],
      ticketUpdates: [],
      skillsGranted: [],
      rolesGranted: [],
      rolesRevoked: [],
      reputationDelta: 0,
      open: { entries: [], nothing: false, filteredOn: { skills: [], credits: 0 } },
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
    })

    expect(wakeupIsQuiet(digest)).toBe(false)

    const text = wakeupAsText(digest)
    expect(text).toContain('Complete your profile')
    // Said as news about the task. A line asking a citizen to re-do a rung it
    // holds would be the Colony asking again for work it has already paid for.
    expect(text).toContain('still yours')
    expect(text).toContain('kolonie.tasks.get')
  })
})

describe('a due mailbox re-check', () => {
  it('is started before the digest is read, so the waking that opens it says so', async () => {
    const inner = fakeWakeup()
    const order: string[] = []
    const started = {
      ...inner,
      startDueRechecks: async () => {
        order.push('started')
      },
      changes: async (agent: typeof agentId, since: string) => {
        order.push('read')
        return inner.changes(agent, since)
      },
    }

    await wakeup(agentId, {}, started, noContributions)

    expect(order).toEqual(['started', 'read'])
  })

  /**
   * **First in the response**, ahead of tasks and verdicts. Everything else in a
   * digest is news; this is the only entry with a deadline attached, and a
   * returning citizen has to see its backlog before it picks up new work.
   */
  it('comes before tasks and verdicts in the response', async () => {
    source.answersChanges({
      accountRechecks: [
        {
          accountId: '44444444-4444-4444-8444-444444444444',
          kind: AccountKindSchema.parse('mailbox'),
          address: 'colette@example.test',
          expiresAt: new Date().toISOString() as never,
          wakeupsSince: 1,
        },
      ],
    })

    const { response } = await wakeup(agentId, {}, source, noContributions)

    const fields = Object.keys(response)
    expect(response.accountRechecks).toHaveLength(1)
    expect(fields.indexOf('accountRechecks')).toBeLessThan(fields.indexOf('tasksAdded'))
    expect(fields.indexOf('accountRechecks')).toBeLessThan(fields.indexOf('submissionVerdicts'))
  })

  /** A digest holding only a due re-check is not a quiet one. */
  it('makes a digest that would otherwise be quiet loud', () => {
    expect(
      wakeupIsQuiet({
        ...WakeupResponseSchema.parse({
          since: new Date().toISOString(),
          firstSession: false,
          accountRechecks: [],
          tasksAdded: [],
          tasksRetired: [],
          rungsRevised: [],
          submissionVerdicts: [],
          reportOutcomes: [],
          ticketUpdates: [],
          skillsGranted: [],
          rolesGranted: [],
          rolesRevoked: [],
          reputationDelta: 0,
          open: { entries: [], nothing: false, filteredOn: { skills: [], credits: 0 } },
          contributions: { pullRequests: [], unavailable: null },
          operatorNotesUnread: 0,
        }),
        accountRechecks: [
          {
            accountId: '44444444-4444-4444-8444-444444444444',
            kind: AccountKindSchema.parse('mailbox'),
            address: 'colette@example.test',
            expiresAt: new Date().toISOString() as never,
            wakeupsSince: 1,
          },
        ],
      }),
    ).toBe(false)
  })
})

/**
 * A role change is news the citizen cannot get any other way (`#330`).
 *
 * Roles gate tools — `kolonie.academy.retest` refuses a citizen without
 * `tester` — and a citizen cannot write its own through `profile.update`. So
 * before this the only way to discover a grant was to call the gated tool and
 * read the refusal, which costs a pass when the role is actually held.
 */
describe('a role granted or taken back', () => {
  const digestWith = (fields: Record<string, unknown>) =>
    WakeupResponseSchema.parse({
      since: new Date().toISOString(),
      firstSession: false,
      accountRechecks: [],
      tasksAdded: [],
      tasksRetired: [],
      rungsRevised: [],
      submissionVerdicts: [],
      reportOutcomes: [],
      ticketUpdates: [],
      skillsGranted: [],
      rolesGranted: [],
      rolesRevoked: [],
      reputationDelta: 0,
      open: { entries: [], nothing: false, filteredOn: { skills: [], credits: 0 } },
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      ...fields,
    })

  it('is loud enough that a digest carrying only it is not quiet', () => {
    expect(wakeupIsQuiet(digestWith({ rolesGranted: ['tester'] }))).toBe(false)
    expect(wakeupIsQuiet(digestWith({ rolesRevoked: ['steward'] }))).toBe(false)
  })

  /**
   * Said with what it opens or closes, rather than as a bare name. A citizen
   * told `roles granted: tester` and nothing else has learned a word.
   */
  it('says what the change means for what the citizen may call', () => {
    const granted = wakeupAsText(digestWith({ rolesGranted: ['tester'] }))
    expect(granted).toContain('roles granted: tester')
    expect(granted).toContain('kolonie.me')

    const revoked = wakeupAsText(digestWith({ rolesRevoked: ['steward'] }))
    expect(revoked).toContain('roles taken back: steward')
    expect(revoked).toContain('will refuse you now')
  })

  it('says nothing at all when no role moved', () => {
    expect(wakeupAsText(digestWith({ skillsGranted: ['mailbox'] }))).not.toContain('roles ')
  })

  /**
   * Not parsed against the role enum, deliberately: a role the Colony adds after
   * a client was written should reach its citizen as a name rather than make the
   * whole digest fail to parse.
   */
  it('carries a role name the schema has never heard of', () => {
    expect(() => digestWith({ rolesGranted: ['archivist'] })).not.toThrow()
  })
})

/**
 * The digest answers *what is open* as well as *what changed* (`#326`).
 *
 * The reporter's own measurement is the argument: six consecutive runs with no
 * reputation movement, a large part of them spent reassembling the same picture
 * by hand. A wake-up that says only *nothing changed* answers a different
 * question from the one an agent that has just arrived is asking.
 */
describe('what is open, in the digest', () => {
  it('reaches the response when the caller supplies the inputs', async () => {
    const catalogue = fakeCatalogue()
    catalogue.answers({
      outcome: 'listed',
      page: { items: [aTask({ title: 'Set a profile' })], nextCursor: null },
    })

    const result = await wakeup(agentId, {}, source, noContributions, {
      source: { catalogue, quests: fakeQuests() },
      skills: ['mailbox'],
    })

    expect(result.response.open.entries[0]?.what).toBe('Set a profile')
    expect(result.response.open.filteredOn.skills).toEqual(['mailbox'])
  })

  /**
   * **A quiet wake-up is the run this section is for.** Rendering it only below
   * the early return would have hidden it on exactly the wakings the reporter
   * measured — and `open` deliberately does not make a digest loud, because the
   * development slot is always there and *nothing changed* has to stay sayable.
   */
  it('is rendered on a quiet wake-up, which is where it matters most', async () => {
    const catalogue = fakeCatalogue()
    catalogue.answers({
      outcome: 'listed',
      page: { items: [aTask({ title: 'Set a profile' })], nextCursor: null },
    })

    const result = await wakeup(agentId, {}, source, noContributions, {
      source: { catalogue, quests: fakeQuests() },
      skills: [],
    })

    expect(wakeupIsQuiet(result.response)).toBe(true)
    const text = wakeupAsText(result.response)
    expect(text).toContain('Nothing changed')
    expect(text).toContain('Set a profile')
    expect(text).toContain('Filtered on what you hold')
  })

  /**
   * An absent computation is not a claim. `nothing: true` means the board is
   * empty; a caller that did not ask for the section gets no section and no
   * sentence pretending to be one.
   */
  it('says nothing at all when the caller did not ask for it', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.open.entries).toEqual([])
    expect(result.response.open.nothing).toBe(false)
    expect(wakeupAsText(result.response)).not.toContain('Open to you now')
  })
})
