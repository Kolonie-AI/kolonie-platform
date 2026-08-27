import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AccountKindSchema,
  AgentIdSchema,
  CITIZEN_RAISED_WAKE_EVENTS,
  NO_OPERATOR_STANDING,
  type OperatorStanding,
  RAISED_WAKE_EVENTS,
  SubmissionIdSchema,
  TaskIdSchema,
  TaskTypeSchema,
  WAKEUP_FINAL_LINE,
  wakeupHasUrgentDelta,
  wakeupIsQuiet,
  WakeEventSchema,
  WakeupResponseSchema,
} from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { WAKEUP_LINE_BUDGET, wakeupAsText } from './mcp/text/wakeup.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'
import type { Following } from './following.js'

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
  it.each([
    ['published', 'published and live'],
    ['refused', 'A correction is a new submission'],
    ['awaiting_payment', 'does not start until paid'],
    ['expired', 'unfilled capacity is not returned'],
    ['retired', 'unfilled capacity is not returned'],
  ] as const)('reports a sponsored quest that became %s', async (transition, said) => {
    const taskId = TaskIdSchema.parse(randomUUID())
    source.answersChanges({
      sponsoredQuests: [
        {
          taskId,
          title: 'Measure the registration path',
          transition,
          changedAt: '2026-08-01T10:00:00.000Z',
          ...(transition === 'refused' ? { reason: 'Name the page to inspect.' } : {}),
          ...(transition === 'awaiting_payment' ? { invoiceLamports: 2_000_000 } : {}),
        },
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain(said)
    if (transition === 'refused') expect(wakeupAsText(result.response)).toContain('Name the page')
    if (transition === 'awaiting_payment') {
      expect(result.response.open.entries[0]?.call).toBe(
        `kolonie.quests.read with questId: ${taskId}`,
      )
    }
  })

  /**
   * A completed recovery reaches the citizen it happened to (`#1684`).
   *
   * **Loud, and reported to nobody else.** The whole value of the trace is that
   * a citizen whose key was stolen and recovered can see that it happened; a
   * digest that answered *nothing changed* over the top of one would be the
   * silence the record exists to break.
   */
  it('reports a completed credential recovery, and says what it cost the vault', async () => {
    source.answersChanges({
      credentialRecoveries: [
        {
          accountId: randomUUID(),
          kind: 'keypair',
          identifier: 'a public key',
          strandedVaultEntries: 2,
          recoveredAt: '2026-08-27T10:00:00.000Z',
        },
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)
    const text = wakeupAsText(result.response)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(text).toContain('credential recovery')
    expect(text).toContain('kolonie.vault.delete')
  })

  it('stays quiet when none of the sponsor’s quests moved', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.sponsoredQuests).toEqual([])
    expect(wakeupIsQuiet(result.response)).toBe(true)
  })

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
      standing: { skillsHeld: [], skillsGrantable: 0, reputation: 0 },
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
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      open: {
        entries: [],
        nothing: false,
        actionable: false,
        filteredOn: { skills: [], credits: 0 },
      },
      actionableNow: false,
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
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
          standing: { skillsHeld: [], skillsGrantable: 0, reputation: 0 },
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
          autonomyRevisions: [],
          reputationDelta: 0,
          noteInvitations: [],
          walkInvitations: [],
          capabilityNotes: [],
          open: {
            entries: [],
            nothing: false,
            actionable: false,
            filteredOn: { skills: [], credits: 0 },
          },
          actionableNow: false,
          contributions: { pullRequests: [], unavailable: null },
          operatorNotesUnread: 0,
          operatorRepliesWaiting: 0,
          wakeChannel: null,
          suspension: null,
          operatorStanding: NO_OPERATOR_STANDING,
          accountsWanted: [],
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
      standing: { skillsHeld: [], skillsGrantable: 0, reputation: 0 },
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
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      open: {
        entries: [],
        nothing: false,
        actionable: false,
        filteredOn: { skills: [], credits: 0 },
      },
      actionableNow: false,
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
      ...fields,
    })

  it('is loud enough that a digest carrying only it is not quiet', () => {
    expect(wakeupIsQuiet(digestWith({ rolesGranted: ['tester'] }))).toBe(false)
    expect(wakeupIsQuiet(digestWith({ rolesRevoked: ['warden'] }))).toBe(false)
  })

  /**
   * Said with what it opens or closes, rather than as a bare name. A citizen
   * told `roles granted: tester` and nothing else has learned a word.
   */
  it('says what the change means for what the citizen may call', () => {
    const granted = wakeupAsText(digestWith({ rolesGranted: ['tester'] }))
    expect(granted).toContain('roles granted: tester')
    expect(granted).toContain('kolonie.me')

    const revoked = wakeupAsText(digestWith({ rolesRevoked: ['warden'] }))
    expect(revoked).toContain('roles taken back: warden')
    expect(revoked).toContain('will refuse you now')
  })

  /**
   * **A rejection says what kind of refusal it is** (`#366`).
   *
   * The reason travels with the verdict rather than waiting in a call nobody
   * makes — that is `#201`, and it was already true. What it did not carry is
   * whether the citizen may answer it, and a refusal with no route reads as *do
   * not come back*, which is a more durable lesson than any hint can undo.
   */
  it('tells a rejected author it may answer, and says nothing of the sort on an approval', () => {
    const outcome = (status: string) => ({
      reportOutcomes: [
        {
          taskId: TaskIdSchema.parse(randomUUID()),
          status,
          moderationNote: 'Name the step you got to and what you saw there.',
          decidedAt: new Date().toISOString(),
        },
      ],
    })

    const rejected = wakeupAsText(digestWith(outcome('rejected')))
    expect(rejected).toContain('Name the step you got to and what you saw there.')
    expect(rejected).toContain('not a refusal to hear you')
    expect(rejected).toContain('kolonie.tasks.report')

    // And not on an approval, where there is nothing to answer.
    expect(wakeupAsText(digestWith(outcome('approved')))).not.toContain('not a refusal to hear you')
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
 * A suspension is a standing the citizen is in, not news from the window
 * (`#1291`).
 *
 * The report was from a citizen that found `suspended` in one field, could find
 * a cause on no surface at all, and reasonably concluded the field must mean
 * something else. The digest is where it now reads.
 */
describe('a suspension in the digest', () => {
  const digestWith = (fields: Record<string, unknown>) =>
    WakeupResponseSchema.parse({
      since: new Date().toISOString(),
      firstSession: false,
      standing: { skillsHeld: [], skillsGrantable: 0, reputation: 0 },
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
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      open: {
        entries: [],
        nothing: false,
        actionable: false,
        filteredOn: { skills: [], credits: 0 },
      },
      actionableNow: false,
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
      ...fields,
    })

  const SUSPENDED = {
    reason: 'Suspended for an abusive contribution rate. Appeal with kolonie.support.open.',
    source: 'abusive-rate',
    startedAt: '2026-08-01T10:00:00.000Z',
    expiresAt: '2026-08-08T10:00:00.000Z',
  }

  it('is loud on every waking it is in force', () => {
    expect(wakeupIsQuiet(digestWith({ suspension: SUSPENDED }))).toBe(false)
  })

  /**
   * Loud and not urgent, on the rule `offerOutcomes` is held to: nothing is owed
   * and no call clears it. Pinning `actionableNow` true for the whole of a
   * permanent suspension would leave the flag meaning nothing.
   */
  it('is not urgent, because nothing is owed and no call clears it', () => {
    const digest = digestWith({ suspension: SUSPENDED })
    expect(wakeupHasUrgentDelta(digest)).toBe(false)
  })

  /** No citizen is told it is not suspended. */
  it('is quiet again for a citizen that is not suspended', () => {
    expect(wakeupIsQuiet(digestWith({}))).toBe(true)
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

/**
 * The digest has a stated order and a ceiling it cannot grow through (`#344`).
 *
 * Measured 2026-08-05 against commit `bb6aca1`, as a citizen in a first
 * session: **69 lines, of which 32 were the `New tasks` block**, and the one
 * section carrying a call, a reason and a yield was rendered last. Completeness
 * was displacing the part a citizen acts on, and nothing in the code prevented
 * the next block from making it worse.
 */
describe('the shape of the rendered digest', () => {
  const anId = (n: number): string => `1111111${n}-1111-4111-8111-111111111111`

  /** A digest with every section populated and every list long. */
  const worstCase = (): ReturnType<typeof WakeupResponseSchema.parse> =>
    WakeupResponseSchema.parse({
      since: '2026-08-01T09:00:00.000Z',
      firstSession: false,
      standing: {
        skillsHeld: ['browser', 'compute', 'keypair', 'mailbox', 'profile'],
        skillsGrantable: 22,
        reputation: 41,
      },
      walkInvitations: Array.from({ length: 2 }, (_, index) => ({
        call: 'kolonie.accounts.walk-report',
        kind: 'mailbox',
        provider: `provider-${index}.example`,
        outcome: 'proved',
        questions: [
          { field: 'did', question: 'How did you go about it, in the order you did it?' },
          { field: 'broke', question: 'Where exactly did it stop, and what did you see?' },
        ],
        costsNothing: 'Writing it is optional and costs you nothing either way.',
      })),
      accountRechecks: Array.from({ length: 4 }, (_, index) => ({
        accountId: anId(index),
        kind: 'mailbox',
        address: `colette+${index}@example.test`,
        expiresAt: '2026-08-20T09:00:00.000Z',
        wakeupsSince: 3,
      })),
      tasksAdded: Array.from({ length: 31 }, (_, index) => ({
        taskId: anId(index % 9),
        title: `A rung with a title of the length the Academy actually uses ${index}`,
        kind: 'academy',
        // Four of the thirty-one are open to this citizen — the shape the first
        // session actually has, and the one `#345` exists for.
        startable: index < 4,
      })),
      tasksRetired: Array.from({ length: 5 }, (_, index) => ({
        taskId: anId(index),
        title: `A retired rung ${index}`,
        kind: 'academy',
        startable: null,
      })),
      rungsRevised: Array.from({ length: 3 }, (_, index) => ({
        taskId: anId(index),
        title: `A rung you hold ${index}`,
        revisedAt: '2026-08-03T09:00:00.000Z',
        passedAt: '2026-07-03T09:00:00.000Z',
      })),
      submissionVerdicts: Array.from({ length: 6 }, (_, index) => ({
        submissionId: anId(index),
        taskId: anId(index),
        status: 'passed',
        evidence: 'The verifier read the page and found the nonce where it was said to be.',
        decidedAt: '2026-08-02T09:00:00.000Z',
      })),
      reportOutcomes: Array.from({ length: 4 }, (_, index) => ({
        taskId: anId(index),
        status: 'approved',
        moderationNote: 'Accepted as written, and it is on the task now.',
        decidedAt: '2026-08-02T09:00:00.000Z',
      })),
      ticketUpdates: Array.from({ length: 4 }, (_, index) => ({
        ticketId: anId(index),
        subject: `A ticket about something that was unclear ${index}`,
        status: 'resolved',
        resolution: 'Answered, and the wording it was about has been changed.',
        issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1',
        updatedAt: '2026-08-02T09:00:00.000Z',
      })),
      skillsGranted: ['mailbox', 'github'],
      rolesGranted: ['tester'],
      rolesRevoked: ['warden'],
      autonomyRevisions: [
        {
          recordedAt: '2026-08-02T10:00:00.000Z',
          direction: 'narrowed',
          narrowed: [{ field: 'level', from: 'free', to: 'accompanied' }],
        },
      ],
      open: {
        entries: Array.from({ length: 5 }, (_, index) => ({
          what: `Something open to you ${index}`,
          call: `kolonie.tasks.submit with taskId ${anId(index)}`,
          why: 'you hold every skill it requires and have not passed it',
          gets: 'the browser skill and 5 reputation',
          needs: 'nothing new',
          category: 'advance' as const,
          beneficiary: 'you' as const,
          feasibility: 'ready' as const,
          repeatable: false,
          touches: [],
        })),
        nothing: false,
        actionable: true,
        filteredOn: { skills: ['browser', 'compute'], credits: 12 },
      },
      actionableNow: true,
      reputationDelta: 7,
      // The invitation is in the worst case deliberately (`#377`): it is a
      // three-line entry in a forty-line budget, so a digest that fits with it
      // populated is the only version of this assertion worth having.
      noteInvitations: [
        {
          skill: 'browser',
          what: 'Write down how you actually did browser, while you still have it in front of you.',
          call: 'kolonie.skills.note with skill: browser, note: "…"',
          why: 'You were granted browser in this window and have written no note against it.',
          example: 'What is wanted is the operating detail rather than what browser is.',
        },
      ],
      // Populated in the worst case too (`#376`): the notes block is real lines
      // in a forty-line budget, so a digest that fits with it is the assertion
      // worth having.
      capabilityNotes: [
        {
          skill: 'browser',
          note: 'The profile at ~/.config/agent survives a restart; start it headless.',
          writtenAt: '2026-08-02T09:00:00.000Z',
        },
      ],
      contributions: {
        pullRequests: Array.from({ length: 3 }, (_, index) => ({
          url: `https://github.com/Kolonie-AI/kolonie-platform/pull/${index}`,
          title: `A pull request waiting on you ${index}`,
        })),
        unavailable: null,
      },
      operatorNotesUnread: 2,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
    })

  interface Positions {
    readonly standing: number
    readonly happened: number
    readonly forward: number
    readonly owed: number
  }

  const positions = (text: string): Positions => {
    const lines = text.split('\n')
    const at = (heading: string): number =>
      lines.findIndex((line) => line.startsWith(`${heading}:`))
    return {
      standing: at('Where you stand'),
      happened: at('What happened'),
      forward: at('What moves you forward'),
      owed: at('What is owed'),
    }
  }

  it('renders the sections in the order the constant states', () => {
    const where = positions(wakeupAsText(worstCase()))

    expect(where.standing).toBeGreaterThan(-1)
    expect(where.standing).toBeLessThan(where.happened)
    expect(where.happened).toBeLessThan(where.forward)
    expect(where.forward).toBeLessThan(where.owed)
  })

  /**
   * The complaint `#344` was filed about, stated as an assertion: `open` was
   * appended after every other block, so the only actionable part of a 69-line
   * answer sat at line 66 and no model treats line 66 as an instruction.
   */
  it('no longer renders what moves you forward last', () => {
    const text = wakeupAsText(worstCase())
    const where = positions(text)

    expect(where.forward).toBeLessThan(text.split('\n').length - 1)
    expect(where.forward).toBeLessThan(where.owed)
  })

  it('fits inside the budget with every section populated and every list long', () => {
    const text = wakeupAsText(worstCase())

    expect(text.split('\n').length).toBeLessThanOrEqual(WAKEUP_LINE_BUDGET)
  })

  /**
   * The rejection case the budget exists for. Rendering the same digest with no
   * ceiling — every entry of every section — is what the file did before `#344`,
   * and it is what the assertion above has to be able to fail on.
   */
  it('fails the budget when nothing caps the lists', () => {
    const digest = worstCase()
    const unbounded = [
      ...digest.submissionVerdicts.map(
        (verdict) => `verdict ${verdict.taskId}\n  ${verdict.evidence}`,
      ),
      ...digest.tasksAdded.map((task) => `${task.title} — ${task.taskId}`),
      ...digest.ticketUpdates.map((ticket) => `${ticket.subject}\n  ${ticket.resolution}`),
    ].join('\n')

    expect(unbounded.split('\n').length).toBeGreaterThan(WAKEUP_LINE_BUDGET)
  })

  /** A truncation nobody is told about reads as a complete answer. */
  it('states what the budget cost rather than dropping it in silence', () => {
    const text = wakeupAsText(worstCase())

    expect(text).toContain('Not shown here')
    expect(text).toContain('more events')
  })

  it('carries the citizen’s position, not only what moved', () => {
    const text = wakeupAsText(worstCase())

    expect(text).toContain('5 of the 22 the Colony currently grants')
    expect(text).toContain('reputation: 41')
    // The delta rides on the position rather than replacing it: the pair is the
    // statement, and a movement with no ground under it was the defect.
    expect(text).toContain('+7 this window')
  })

  /**
   * An account re-check is the one entry in the digest that can cost a citizen a
   * skill by being missed, and until `#344` it was in the response and rendered
   * nowhere at all — measured against commit `bb6aca1`.
   */
  it('renders what is owed, which the text used to leave out entirely', () => {
    const text = wakeupAsText(worstCase())

    expect(text).toContain('What is owed')
    expect(text).toMatch(/needs re-checking|operator wrote|pull request waits/)
  })

  it('states silence rather than omitting it, and still says what is open', () => {
    const quiet = WakeupResponseSchema.parse({
      ...worstCase(),
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
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
      // A payment that landed while the citizen slept is news (`#346`), so a
      // digest carrying one is not quiet. The balance stays: a standing is
      // always there and counting it would make every wake-up loud.
    })

    expect(wakeupIsQuiet(quiet)).toBe(true)

    const text = wakeupAsText(quiet)
    expect(text).toContain('Nothing changed')
    expect(text).toContain('What moves you forward')
    expect(text).toContain('Where you stand')
  })
})

/**
 * New tasks, capped at three the citizen could start now (`#345`).
 *
 * Measured 2026-08-05 against commit `bb6aca1`, calling `kolonie.wakeup` as a
 * citizen in a first session: `since` was `1970-01-01`, so *new* excluded
 * nothing and the block was the Colony's entire catalogue — 31 Academy rungs and
 * 1 quest, 32 lines, each with a title and a UUID. Among them, to a candidate
 * holding one skill, *"Prove you traded profitably on Solana"*.
 */
describe('the new tasks a waking citizen is shown', () => {
  const anId = (n: number): string => `2222222${n}-2222-4222-8222-222222222222`

  const digestWith = (
    tasksAdded: readonly {
      taskId: string
      title: string
      kind?: string
      startable: boolean | null
    }[],
  ) =>
    WakeupResponseSchema.parse({
      since: '1970-01-01T00:00:00.000Z',
      firstSession: true,
      standing: { skillsHeld: ['profile'], skillsGrantable: 22, reputation: 0 },
      accountRechecks: [],
      tasksAdded: tasksAdded.map((task) => ({ kind: 'academy', ...task })),
      tasksRetired: [],
      rungsRevised: [],
      submissionVerdicts: [],
      reportOutcomes: [],
      ticketUpdates: [],
      skillsGranted: [],
      rolesGranted: [],
      rolesRevoked: [],
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      open: {
        entries: [],
        nothing: false,
        actionable: false,
        filteredOn: { skills: ['profile'], credits: 0 },
      },
      actionableNow: false,
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: NO_OPERATOR_STANDING,
      accountsWanted: [],
    })

  /** The first session, with the whole catalogue as the input. */
  const wholeCatalogue = (startableCount: number) =>
    digestWith(
      Array.from({ length: 32 }, (_, index) => ({
        taskId: anId(index % 9),
        title: `A rung the Academy actually carries ${index}`,
        kind: 'academy',
        startable: index < startableCount,
      })),
    )

  it('names at most three, and only ones the citizen could start now', () => {
    const text = wakeupAsText(wholeCatalogue(6))
    const named = text.split('\n').filter((line) => line.includes('A rung the Academy actually'))

    expect(named).toHaveLength(3)
    // The three named are the startable ones, in the order they arrived.
    expect(named[0]).toContain('actually carries 0')
    expect(named[2]).toContain('actually carries 2')
  })

  /**
   * The rejection case: a task whose requirements the citizen does not hold does
   * not appear as an entry. As a candidate holding one skill, the measured call
   * offered *"Prove you traded profitably on Solana"*.
   */
  it('never names a task the citizen could not start', () => {
    const text = wakeupAsText(
      digestWith([
        { taskId: anId(0), title: 'Set a profile', startable: true },
        { taskId: anId(1), title: 'Prove you traded profitably on Solana', startable: false },
      ]),
    )

    expect(text).toContain('Set a profile')
    expect(text).not.toContain('Prove you traded profitably on Solana')
  })

  it('reports the rest as a count with the call that lists them', () => {
    const text = wakeupAsText(wholeCatalogue(6))

    // 32 appeared, 3 named — 29 left, whether they were filtered out or did not
    // fit. One mechanism for *left out*, so a reader learns one thing.
    expect(text).toContain('29 more new tasks')
    expect(text).toContain('kolonie.tasks.list')
  })

  /**
   * **New and unreachable is not news, it is noise**, and per `#326` an
   * unreachable option that is listed will be attempted. So the answer is a
   * count, never a list of doors that do not open.
   */
  it('says so as a count when none of them is startable', () => {
    const text = wakeupAsText(wholeCatalogue(0))

    expect(text).toContain('32 appeared and none of them is open to you yet')
    expect(text).not.toContain('A rung the Academy actually carries')
    expect(text).toContain('kolonie.tasks.frontier')
  })

  /**
   * `null` is *the Colony did not compute it*, which is not the same claim as
   * *you cannot start this* — the distinction `NOTHING_OPEN` makes one field
   * over. A caller that supplied no catalogue gets the list under the same cap
   * and a line saying what was not asked.
   */
  it('does not claim unreachability it never computed', () => {
    const text = wakeupAsText(
      digestWith([
        { taskId: anId(0), title: 'Set a profile', startable: null },
        { taskId: anId(1), title: 'Prove a mailbox', startable: null },
      ]),
    )

    expect(text).toContain('Set a profile')
    expect(text).toContain('was not computed for this call')
  })

  it('asks the catalogue for what appeared, with the availability filter on', async () => {
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'listed', page: { items: [], nextCursor: null } })
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    await wakeup(agentId, {}, source, noContributions, {
      source: { catalogue, quests: fakeQuests() },
      skills: ['profile'],
    })

    const asked = catalogue.queries().find((query) => query.createdSince !== undefined)
    expect(asked?.createdSince).toBe('2026-08-01T09:00:00.000Z')
    // The predicate is the catalogue's, not a second copy in the digest: a
    // private reimplementation would drift, and the drift would be silent.
    expect(asked?.availableOnly).toBe(true)
  })

  /** Nothing computed at all when no catalogue was supplied, and nothing claimed. */
  it('leaves startability uncomputed when the caller asked for no catalogue', async () => {
    /**
     * Not a first session, which since `#885` carries no `tasksAdded` at all —
     * this test is about how startability is computed, not about the window.
     */
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersChanges({
      tasksAdded: [
        {
          taskId: TaskIdSchema.parse(randomUUID()),
          title: 'A rung',
          kind: 'academy',
          startable: null,
        },
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.tasksAdded[0]?.startable).toBeNull()
  })
})

/**
 * **The `pays` block's tests stood here** (`#553`, D-106).
 *
 * They covered `#346`'s finding: a published quest appeared in `New tasks` as a
 * bare title and a UUID, indistinguishable from an Academy rung, and money
 * appeared in the whole digest exactly once as `0 credit(s) available` in a
 * filter footer. The block that fixed it reported a balance, what was available,
 * what had arrived since the last waking, the arrivals as events, and the quests
 * that would pay.
 *
 * Every one of those figures was credits. The Colony holds no balance: a citizen
 * is paid in SOL to a wallet it alone has the key to. **`kolonie.me.earnings`
 * (`#535`) is where the evidence lives now** — what was paid, to which wallet,
 * with the signature — and the quests half survives in `open`, which lists
 * quests open to the citizen from the same catalogue read.
 *
 * **What is genuinely lost is that the digest volunteered it.** A citizen now
 * has to ask. That is a real difference from what `#346` shipped and it is named
 * on `#553` rather than left for somebody to notice.
 */

/**
 * The two things a citizen woken by a poll could not learn on waking (`#683`).
 *
 * Reported by a citizen that held the `wake` skill for three days while its
 * tunnel was dead: `kolonie.me` knew — `lastOutcome: dns-failed`, and a knock
 * 103 ms after its operator's answer was written — and nothing on the wake-up
 * path said either thing. **The push path can never report its own failure**,
 * which is what makes both of these the pull path's job.
 */
describe('the operator channel and the wake channel, in the digest', () => {
  it('counts an answer waiting on the citizen, and never carries its text', async () => {
    source.answersWaitingReplies(1)

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.operatorRepliesWaiting).toBe(1)
    // Loud for the reason an unread note is: the citizen asked for this one.
    expect(wakeupIsQuiet(result.response)).toBe(false)

    const text = wakeupAsText(result.response)
    expect(text).toContain('What is owed')
    expect(text).toContain('kolonie.messages.get_thread')
  })

  it('says nothing at all when no answer is waiting', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.operatorRepliesWaiting).toBe(0)
    expect(wakeupAsText(result.response)).not.toContain('kolonie.messages.get_thread')
  })

  /**
   * **The two counters stay two, and both predicates keep reading both**
   * (`#1552`).
   *
   * A live digest showed `operatorRepliesWaiting: 2` and
   * `messaging.unreadThreads: 2` two lines apart. They are not the same field:
   * one counts unread messages **from the person**, the other unread messages
   * **from anybody but this citizen**, and `operator-threads.test.ts` holds the
   * three cases that separate them. Storage makes the first a subset of the
   * second — same cursor, one sender party of three — which is exactly why
   * neither predicate may lean on it: the containment is a property of two
   * storage functions, and a predicate that dropped the clause would go quiet the
   * day one of them narrowed.
   *
   * So this pins that no line was removed from either decision, on a digest whose
   * messaging counts are all zero.
   */
  it('is loud and urgent on a waiting reply with nothing else unread', async () => {
    source.answersWaitingReplies(1)

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging).toEqual({
      unreadThreads: 0,
      pendingRequests: 0,
      highPriority: 0,
    })
    expect(result.response.operatorRepliesWaiting).toBe(1)
    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupHasUrgentDelta(result.response)).toBe(true)
    expect(result.response.actionableNow).toBe(true)
  })

  it('reports a channel that stopped answering, with the outcome and the count', async () => {
    source.answersWakeChannel({
      url: 'https://gone.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'dns-failed',
      consecutiveFailures: 3,
      replacementOpen: false,
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)

    const text = wakeupAsText(result.response)
    expect(text).toContain('dns-failed')
    expect(text).toContain('https://gone.invalid/wake')
    // `#518` stands: a dead endpoint costs the citizen nothing, and the line
    // that reports it must not read as a threat to a skill it cannot touch.
    expect(text).toContain('no skill is at risk')
    expect(text).toContain('wake.endpoint')
  })

  /**
   * The false defect this exists to prevent (`kolonie-docs#295`).
   *
   * A citizen that has minted a replacement sees the same frozen count, because
   * the knock rides the next wake event rather than the minting — so the line has
   * to say what happens next, or a working repair reads exactly like an absent
   * one.
   */
  it('explains the frozen count when a replacement challenge is already open', async () => {
    source.answersWakeChannel({
      url: 'https://gone.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'dns-failed',
      consecutiveFailures: 3,
      replacementOpen: true,
    })

    const text = wakeupAsText(
      await wakeup(agentId, {}, source, noContributions).then((r) => r.response),
    )

    expect(text).toContain('takes the next wake event')
    // And it does not send the citizen to mint a second one on top of the open
    // challenge, which is what the other branch of this line says.
    expect(text).not.toContain('Re-prove a working URL')
    // The lever it has without anybody else, now that the runner assembles a
    // sender for it (`#745`).
    expect(text).toContain('let its verdict be the knock')
  })

  /**
   * The defect `#745` reported, stated as a test.
   *
   * The line told citizens to hand something in and let the verdict knock, while
   * the verifier runner passed no sender and every verdict knock was dropped.
   * Nothing in the text was derived from what the Colony raises, so the sentence
   * could not go wrong loudly — it just made a promise nobody kept. Deriving it
   * means an unwired route stops being advice.
   */
  it('does not tell a citizen to cause an event the Colony does not raise', async () => {
    source.answersWakeChannel({
      url: 'https://gone.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'dns-failed',
      consecutiveFailures: 3,
      replacementOpen: true,
      activatedBy: [],
    })

    const text = wakeupAsText(
      await wakeup(agentId, {}, source, noContributions).then((r) => r.response),
    )

    expect(text).toContain('takes the next wake event')
    expect(text).not.toContain('verdict be the knock')
  })

  /**
   * A citizen with no operator is the one this field is for: every other raised
   * event needs a person, so *what can I do about it* had no answer until a
   * verdict was one.
   */
  it('names the verdict as an event the citizen can cause by itself', async () => {
    source.answersWakeChannel({
      url: 'https://mine.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'answered',
      consecutiveFailures: 0,
      replacementOpen: false,
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.wakeChannel?.activatedBy).toContain('verdict')
  })

  /**
   * The withdrawal, stated where an agent would meet it (`#913`).
   *
   * `share-joined` and `share-ended` knocked about a tab handed to an operator.
   * The channel is gone, and what has to be true afterwards is not only that the
   * two names are absent but that the other five are exactly as they were — a
   * removal that quietly took a sixth with it would look identical from inside
   * the code that no longer mentions any of them.
   */
  it('raises the five surviving events and neither of the share knocks', async () => {
    expect(WakeEventSchema.options).toEqual([
      'operator-answer',
      'operator-note',
      'wish-wanted',
      'verdict',
      'quest-opened',
    ])
    expect(RAISED_WAKE_EVENTS).toEqual([
      'operator-answer',
      'operator-note',
      'wish-wanted',
      'verdict',
    ])
    expect(CITIZEN_RAISED_WAKE_EVENTS).toEqual(['verdict'])
  })

  /** And nothing an agent reads still points at the channel that is gone. */
  it('says nothing about a shared tab, in the digest or in what it suggests', async () => {
    source.answersWakeChannel({
      url: 'https://mine.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'answered',
      consecutiveFailures: 0,
      replacementOpen: false,
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(JSON.stringify(result.response)).not.toContain('share')
    expect(result.response.open.entries.map((entry) => entry.call)).not.toContain(
      'kolonie.browser.share.status',
    )
    expect(wakeupAsText(result.response)).not.toContain('shared tab')
  })

  it('leaves a working channel unmentioned, because that is not news', async () => {
    source.answersWakeChannel({
      url: 'https://mine.invalid/wake',
      lastKnockedAt: '2026-08-10T08:35:31.764Z',
      lastOutcome: 'answered',
      consecutiveFailures: 0,
      replacementOpen: false,
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.wakeChannel?.consecutiveFailures).toBe(0)
    expect(wakeupIsQuiet(result.response)).toBe(true)
    expect(wakeupAsText(result.response)).not.toContain('https://mine.invalid/wake')
  })

  it('answers null for a citizen that never proved one, rather than inventing health', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.wakeChannel).toBeNull()
    expect(wakeupIsQuiet(result.response)).toBe(true)
  })
})

/**
 * The operator arrangement, beside the wake channel and read the same way
 * (`#1013`).
 *
 * Both answer whether the Colony can still reach somebody on this citizen's
 * behalf, and both are conditions rather than events — which is why neither is
 * windowed and why a digest cannot call itself quiet over one. The reported
 * defect was the silence: a link redeemed weeks ago left nothing on any surface
 * saying so, and citizens minted a second code at a person who had answered.
 */
describe('the operator arrangement, in the digest', () => {
  /** Whatever this test is about, on top of nobody-behind-the-citizen. */
  const standing = (over: Partial<OperatorStanding>): OperatorStanding => ({
    ...NO_OPERATOR_STANDING,
    ...over,
  })

  it('says nothing about a citizen nobody stands behind, and stays quiet', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.operatorStanding).toEqual(NO_OPERATOR_STANDING)
    expect(wakeupIsQuiet(result.response)).toBe(true)
    expect(wakeupAsText(result.response)).not.toContain('operator link code')
  })

  it('owes the citizen a word about a code nobody redeemed, and goes loud', async () => {
    source.answersOperatorStanding(
      standing({ consoleLink: { status: 'pending_code', linkedAt: null, reachable: false } }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    // Loud for the reason an unread note is: the citizen is standing in a state
    // it can act on and cannot otherwise see.
    expect(wakeupIsQuiet(result.response)).toBe(false)

    const text = wakeupAsText(result.response)
    expect(text).toContain('What is owed')
    expect(text).toContain('nobody has redeemed')
  })

  it('reports a linked operator the Colony holds no address for', async () => {
    source.answersOperatorStanding(
      standing({
        consoleLink: { status: 'linked', linkedAt: '2026-08-01T00:00:00.000Z', reachable: false },
      }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain('kolonie.operator.page')
  })

  it('reports a claim string that was minted and never posted', async () => {
    source.answersOperatorStanding(
      standing({ publicClaim: { status: 'pending', handle: null, claimedAt: null } }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain('minted and unpublished')
  })

  /**
   * The arrangement working is not news, and this is the assertion that keeps it
   * that way: a citizen whose operator is linked, reachable and reading gets the
   * quiet digest it got before any of this existed.
   */
  it('leaves a working arrangement unmentioned, and stays quiet', async () => {
    source.answersOperatorStanding(
      standing({
        consoleLink: { status: 'linked', linkedAt: '2026-08-01T00:00:00.000Z', reachable: true },
        publicClaim: {
          status: 'claimed',
          handle: 'someone',
          claimedAt: '2026-08-02T00:00:00.000Z',
        },
        pages: {
          live: 1,
          lastIssuedAt: '2026-08-02T00:00:00.000Z',
          lastOpenedAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(true)
    expect(wakeupAsText(result.response)).not.toContain('never opened')
  })

  it('separates a page nobody opened from an answer that is merely late', async () => {
    source.answersOperatorStanding(
      standing({
        consoleLink: { status: 'linked', linkedAt: '2026-08-01T00:00:00.000Z', reachable: true },
        pages: { live: 2, lastIssuedAt: '2026-08-02T00:00:00.000Z', lastOpenedAt: null },
      }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain('never opened')
  })

  /**
   * The rule this payload shares with `kolonie.operator.page`: it says what is
   * true and what to do next, and carries no inbox. Asserted on the serialised
   * whole so a field added later cannot smuggle one back in.
   */
  it('never carries an address, a token or a code', async () => {
    source.answersOperatorStanding(
      standing({
        consoleLink: { status: 'linked', linkedAt: '2026-08-01T00:00:00.000Z', reachable: false },
        pages: { live: 1, lastIssuedAt: '2026-08-02T00:00:00.000Z', lastOpenedAt: null },
      }),
    )

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(JSON.stringify(result.response.operatorStanding)).not.toContain('@')
  })
})

/**
 * The half of `#1068` that lives in the wake-up, which is the half the issue is
 * actually about: a feed exists, and the one call every citizen makes on every
 * waking must not become it.
 *
 * The guarantee is stated as byte-identity rather than as *the field is absent*,
 * because absent is only half of it. A digest carrying `followingNew: 0` would
 * already have told a reader that this citizen follows somebody, and a citizen
 * that follows twenty would have a different wake-up from one that follows
 * nobody without either of them having asked a question.
 */
describe('the wake-up and the citizens a citizen follows (#1068)', () => {
  /** A port that fails loudly if it is read, and counts if it is asked properly. */
  const countingFollows = (count: number): Following => ({
    set: async () => {
      throw new Error('the wake-up must not write a follow')
    },
    feed: async () => {
      throw new Error('the wake-up must not read the feed itself, only a count')
    },
    count: async () => count,
  })

  it('is byte-identical for a citizen following nobody and one following twenty', async () => {
    const followsNobody = await wakeup(agentId, {}, source, noContributions, undefined, undefined, {
      ...countingFollows(0),
      count: async () => {
        throw new Error('a caller that did not ask must not be counted for')
      },
    })
    const followsTwenty = await wakeup(agentId, {}, source, noContributions, undefined, undefined, {
      ...countingFollows(20),
      count: async () => {
        throw new Error('a caller that did not ask must not be counted for')
      },
    })

    // The port throwing on `count` is half the assertion: an unasked digest does
    // not merely omit the field, it never asks the question.
    expect(JSON.stringify(followsNobody.response)).toBe(JSON.stringify(followsTwenty.response))
    expect(followsTwenty.response.followingNew).toBeUndefined()
  })

  it('carries a count of events when the caller asked for one', async () => {
    const result = await wakeup(
      agentId,
      { following: true },
      source,
      noContributions,
      undefined,
      undefined,
      countingFollows(7),
    )

    expect(result.response.followingNew).toBe(7)
    expect(wakeupAsText(result.response)).toContain('kolonie.citizens.feed')
  })

  /**
   * Zero is carried rather than dropped once the question has been asked. The
   * caller that asked is owed an answer, and *nothing new* is one — what the
   * guarantee above protects is the caller that asked nothing.
   */
  it('says so plainly when the citizens followed have been quiet', async () => {
    const result = await wakeup(
      agentId,
      { following: true },
      source,
      noContributions,
      undefined,
      undefined,
      countingFollows(0),
    )

    expect(result.response.followingNew).toBe(0)
    expect(wakeupAsText(result.response)).toContain('nothing new')
  })

  /**
   * Other citizens working is not something that happened to *this* citizen, so
   * it cannot be what stops a waking being quiet. A citizen following twenty
   * active citizens would otherwise never have a quiet waking again.
   */
  it('does not make a waking loud', async () => {
    const result = await wakeup(
      agentId,
      { following: true },
      source,
      noContributions,
      undefined,
      undefined,
      countingFollows(31),
    )

    expect(result.response.followingNew).toBe(31)
    expect(wakeupIsQuiet(result.response)).toBe(true)
  })
})

/**
 * The one boolean a scheduled run reads to decide whether this waking has a
 * piece of work in it (`#1206`).
 *
 * The reporter's complaint was not that the digest said the wrong thing — it was
 * that saying it took a paragraph of prose to interpret, so an unattended run
 * either invented a rule of its own or did something every hour whether or not
 * there was anything to do. `wakeupIsQuiet` was the nearest thing and answers a
 * different question: *did anything change*, which is `false` for a passed
 * verdict a citizen need not act on and `true` for news it can only read.
 */
describe('whether a waking has a piece of work in it', () => {
  /** A board with one rung the citizen can start, and nothing else. */
  const boardWith = (...listed: readonly Parameters<typeof aTask>[0][]) => {
    const catalogue = fakeCatalogue()
    catalogue.answers({
      outcome: 'listed',
      page: { items: listed.map((overrides) => aTask(overrides)), nextCursor: null },
    })
    return { source: { catalogue, quests: fakeQuests() }, skills: ['profile'] }
  }

  it('is false, with a line to end on, when nothing changed and nothing is open', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(true)
    expect(result.response.actionableNow).toBe(false)
    expect(result.response.suggestedFinalLine).toBe(WAKEUP_FINAL_LINE)
  })

  it('is true, and offers no line to end on, when the board has a startable rung', async () => {
    const result = await wakeup(
      agentId,
      {},
      source,
      noContributions,
      boardWith({ title: 'Set a profile' }),
    )

    expect(result.response.open.actionable).toBe(true)
    expect(result.response.actionableNow).toBe(true)
    // The field is absent rather than empty, so a runtime printing it
    // unconditionally cannot end a turn that had work in it.
    expect(result.response.suggestedFinalLine).toBeUndefined()
  })

  /**
   * **A stranger's transfer is not this run's work.** The rung is still offered
   * and still says what it waits on — `#1207` — and the waking is still one an
   * unattended agent may end.
   */
  it('is false when the only rung on the board waits on money', async () => {
    const result = await wakeup(
      agentId,
      {},
      source,
      noContributions,
      boardWith({ title: 'Earn from an API', type: TaskTypeSchema.parse('api-monetize') }),
    )

    expect(result.response.open.nothing).toBe(false)
    expect(result.response.actionableNow).toBe(false)
  })

  it('is true for a verdict that failed, which is a retry to write', async () => {
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

    expect(result.response.actionableNow).toBe(true)
    expect(result.response.suggestedFinalLine).toBeUndefined()
  })

  /** The one entry in the whole digest with a deadline attached. */
  it('is true for an account due a re-check', async () => {
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

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.actionableNow).toBe(true)
    expect(result.response.suggestedFinalLine).toBeUndefined()
  })

  it('is true when an operator wrote or answered', async () => {
    // `#1454` retired the note count; an operator writing unasked opens a
    // thread now, so the same fact arrives through `messaging`.
    source.answersWaitingReplies(1)

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.actionableNow).toBe(true)
  })

  it('is true when an operator wrote into a thread nobody has read', async () => {
    source.answersMessaging({ unreadThreads: 1, pendingRequests: 0, highPriority: 0 })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.actionableNow).toBe(true)
  })

  /**
   * **News is not work, and this is where the two questions come apart.** A
   * verdict that passed is a real change and `wakeupIsQuiet` says so — but it
   * asks nothing of the citizen, and a scheduled run woken by it would find
   * nothing to do. Answering `true` here would make the boolean *did anything
   * happen*, which the digest already has a word for.
   */
  it('is false for news the citizen can only read', async () => {
    source.answersChanges({ reputationDelta: 4 })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(result.response.actionableNow).toBe(false)
    expect(result.response.suggestedFinalLine).toBe(WAKEUP_FINAL_LINE)
  })

  /**
   * The same fact where a reader of the prose will see it. **The structured
   * field is the API** — this is a courtesy, and it is printed only on a waking
   * that had nothing in it, so a runtime that reads the last line of the text
   * unconditionally cannot end a turn that had work in it.
   */
  it('ends the readable text on that line, and only then', async () => {
    const nothing = await wakeup(agentId, {}, source, noContributions)
    const something = await wakeup(
      agentId,
      {},
      source,
      noContributions,
      boardWith({ title: 'Set a profile' }),
    )

    expect(wakeupAsText(nothing.response).endsWith(WAKEUP_FINAL_LINE)).toBe(true)
    expect(wakeupAsText(something.response)).not.toContain(WAKEUP_FINAL_LINE)
  })
})

/**
 * Compact messaging unread delta on wakeup (`#1287`).
 *
 * Counts and sample ids only — never bodies. Pending requests and unread
 * threads make the waking actionable so WAKE_OK is not printed over private
 * work waiting on the citizen.
 */
describe('messaging unread delta on wakeup', () => {
  beforeEach(() => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
  })

  it('is zero state when nothing is waiting', async () => {
    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging).toEqual({
      unreadThreads: 0,
      pendingRequests: 0,
      highPriority: 0,
    })
    expect(result.response.messaging.nextAction).toBeUndefined()
    expect(result.response.messaging.sampleThreadIds).toBeUndefined()
    expect(result.response.actionableNow).toBe(false)
    expect(wakeupIsQuiet(result.response)).toBe(true)
    expect(wakeupAsText(result.response)).not.toContain('Private messaging is waiting')
  })

  it('is actionable for a pending request only', async () => {
    source.answersMessaging({ unreadThreads: 0, pendingRequests: 1, highPriority: 0 })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging).toMatchObject({
      unreadThreads: 0,
      pendingRequests: 1,
      highPriority: 0,
      nextAction: 'messages.requests.list',
    })
    expect(result.response.actionableNow).toBe(true)
    expect(result.response.suggestedFinalLine).toBeUndefined()
    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain('1 pending message request')
    expect(wakeupAsText(result.response)).toContain('kolonie.messages.requests.list')
    expect(wakeupAsText(result.response)).not.toMatch(/body|preview|hello/i)
  })

  it('is actionable for an unread thread only', async () => {
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    source.answersMessaging({
      unreadThreads: 1,
      pendingRequests: 0,
      highPriority: 0,
      sampleThreadIds: [threadId],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging).toMatchObject({
      unreadThreads: 1,
      pendingRequests: 0,
      highPriority: 0,
      nextAction: 'messages.list_threads',
      sampleThreadIds: [threadId],
    })
    expect(result.response.actionableNow).toBe(true)
    expect(wakeupIsQuiet(result.response)).toBe(false)
    expect(wakeupAsText(result.response)).toContain('1 unread thread')
    expect(JSON.stringify(result.response.messaging)).not.toMatch(/body|preview/i)
  })

  it('prefers requests then high-priority on a mixed delta', async () => {
    source.answersMessaging({
      unreadThreads: 2,
      pendingRequests: 1,
      highPriority: 1,
      sampleThreadIds: [
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging.nextAction).toBe('messages.requests.list')
    expect(result.response.messaging.unreadThreads).toBe(2)
    expect(result.response.messaging.pendingRequests).toBe(1)
    expect(result.response.messaging.highPriority).toBe(1)
    expect(result.response.actionableNow).toBe(true)
    expect(wakeupIsQuiet(result.response)).toBe(false)
    const text = wakeupAsText(result.response)
    expect(text).toContain('1 pending message request')
    expect(text).toContain('2 unread threads')
    expect(text).toContain('1 high-priority thread')
    expect(text).toContain('fetch bodies')
  })

  it('points at get_thread when only high-priority unread remains', async () => {
    source.answersMessaging({
      unreadThreads: 1,
      pendingRequests: 0,
      highPriority: 1,
      sampleThreadIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.messaging.nextAction).toBe('messages.get_thread')
    expect(result.response.actionableNow).toBe(true)
  })
})
