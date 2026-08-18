import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AccountKindSchema,
  CURRENT_CLAIM_ATTEMPTS,
  PLAYBOOK_BRIEFING_CLAIM_CAP,
  PLAYBOOK_GET_CLAIM_CAP,
  type AgentId,
  type PlaybookBriefingClaim,
  type PlaybookDraft,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbookBriefingClaims } from '../schema/playbook-briefing-claims.js'
import { playbookRuns } from '../schema/playbooks.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { publishPlaybookAfterReview } from './playbook-moderations.js'
import {
  oldestCurrentPlaybookAttempt,
  playbookBriefingCorpus,
  readPlaybookBriefingSplit,
  readPlaybookBriefingSummary,
  replacePlaybookBriefingClaims,
} from './playbook-briefing.js'
import { recordPlaybookNoteVerdict } from './playbook-run-notes.js'
import { createPlaybook, recordPlaybookRun, submitPlaybookForReview } from './playbooks.js'
import { asc, eq } from 'drizzle-orm'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

describe('playbook briefing claims (#1251)', () => {
  let db: Database
  let authorId: AgentId
  let playbookId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const draft: PlaybookDraft = {
    title: 'Sweep the unanswered tickets',
    summary: 'Read what nobody answered and write one reply.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: true }],
    steps: [
      { title: 'Read the open tickets', usesSlots: ['mailbox'] },
      { title: 'Write one reply' },
    ],
    inspiration: [],
  }

  beforeEach(async () => {
    await truncateAll(db)
    const author = await registerAgent(db, {
      name: 'brief-author',
      platform: 'openclaw',
      operator: null,
    })
    if (author.outcome !== 'registered') throw new Error('could not register')
    authorId = author.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'briefing-claims-playbook',
      authorAgentId: authorId,
      draft,
    })
    const offered = await submitPlaybookForReview(db, {
      authorAgentId: authorId,
      playbookId: playbook.id,
    })
    if (offered.outcome !== 'written') throw new Error('could not offer')
    const published = await publishPlaybookAfterReview(db, playbook.id)
    if (published.outcome !== 'published') throw new Error('could not publish')
    playbookId = playbook.id
  })

  const aClaim = (
    overrides: Partial<PlaybookBriefingClaim> & Pick<PlaybookBriefingClaim, 'text' | 'sources'>,
  ): PlaybookBriefingClaim => ({
    section: 'route',
    reports: overrides.sources.length,
    platforms: { openclaw: overrides.sources.length },
    lastSupportedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  })

  it('persists claims and replaces them wholesale', async () => {
    const firstSource = randomUUID()
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [aClaim({ text: 'Step two is where most runners stop.', sources: [firstSource] })],
      '2026-08-10T00:00:00.000Z',
      1,
    )

    const first = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(first).toHaveLength(1)
    expect(first[0]?.text).toBe('Step two is where most runners stop.')
    expect(first[0]?.revision).toBe(1)

    const secondSource = randomUUID()
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [aClaim({ text: 'A different claim replaces the first.', sources: [secondSource] })],
      '2026-08-11T00:00:00.000Z',
      2,
    )

    const second = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(second).toHaveLength(1)
    expect(second[0]?.text).toBe('A different claim replaces the first.')
    expect(second[0]?.revision).toBe(2)
  })

  it('keeps lastSupportedAt across an unchanged (section, stepPosition, text)', async () => {
    const source = randomUUID()
    const original = '2026-07-01T12:00:00.000Z'
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [
        aClaim({
          section: 'step',
          stepPosition: 2,
          text: 'The reply step needs the mailbox proved.',
          sources: [source],
          lastSupportedAt: original,
        }),
      ],
      '2026-08-10T00:00:00.000Z',
      1,
    )

    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [
        aClaim({
          section: 'step',
          stepPosition: 2,
          text: 'The reply step needs the mailbox proved.',
          sources: [source, randomUUID()],
          lastSupportedAt: '2026-08-15T00:00:00.000Z',
        }),
      ],
      '2026-08-16T00:00:00.000Z',
      1,
    )

    const [row] = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(new Date(row!.lastSupportedAt).toISOString()).toBe(original)
    expect(row?.reports).toBe(2)
  })

  it('gives a reworded claim a fresh lastSupportedAt', async () => {
    const source = randomUUID()
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [
        aClaim({
          text: 'Old wording of the wall.',
          sources: [source],
          lastSupportedAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
      '2026-08-10T00:00:00.000Z',
      1,
    )

    const fresh = '2026-08-16T00:00:00.000Z'
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [
        aClaim({
          text: 'Reworded wall at the same step.',
          sources: [source],
          lastSupportedAt: fresh,
        }),
      ],
      '2026-08-16T00:00:00.000Z',
      1,
    )

    const [row] = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(new Date(row!.lastSupportedAt).toISOString()).toBe(fresh)
  })

  it('caps stored claims at PLAYBOOK_BRIEFING_CLAIM_CAP', async () => {
    const claims = Array.from({ length: PLAYBOOK_BRIEFING_CLAIM_CAP + 5 }, (_, i) =>
      aClaim({
        text: `Claim number ${i + 1} about this pipeline.`,
        sources: [randomUUID()],
      }),
    )
    await replacePlaybookBriefingClaims(db, playbookId, claims, '2026-08-10T00:00:00.000Z', 1)
    const rows = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(rows).toHaveLength(PLAYBOOK_BRIEFING_CLAIM_CAP)
  })

  it('splits current and demoted, demoted carrying ageDays', async () => {
    // Both bounds must be past before demotion: fewer than 50 runs keeps every
    // claim current by definition, so seed a full window first.
    for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) {
      const runner = await registerAgent(db, {
        name: `window-runner-${i}`,
        platform: 'openclaw',
        operator: null,
      })
      if (runner.outcome !== 'registered') throw new Error('register failed')
      await recordPlaybookRun(db, {
        playbookId,
        agentId: runner.agent.id,
        report: { outcome: 'completed', did: `Window run ${i}.` },
      })
    }

    const source = randomUUID()
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [
        aClaim({
          text: 'Still true this week.',
          sources: [source],
          lastSupportedAt: '2026-08-17T00:00:00.000Z',
        }),
        aClaim({
          text: 'True in May, quiet since.',
          sources: [randomUUID()],
          lastSupportedAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
      '2026-08-18T00:00:00.000Z',
      1,
    )

    const split = await readPlaybookBriefingSplit(db, playbookId, '2026-08-18T00:00:00.000Z')
    expect(split.current.map((c) => c.text)).toContain('Still true this week.')
    expect(split.demoted.map((c) => c.text)).toContain('True in May, quiet since.')
    const demoted = split.demoted.find((c) => c.text === 'True in May, quiet since.')
    expect(demoted?.current).toBe(false)
    expect(demoted?.ageDays).toBeGreaterThan(90)
  })

  it('get summary returns at most PLAYBOOK_GET_CLAIM_CAP current claims, longest-supported first', async () => {
    const claims = Array.from({ length: PLAYBOOK_GET_CLAIM_CAP + 3 }, (_, i) =>
      aClaim({
        text: `Standing claim ${i + 1}.`,
        sources: [randomUUID()],
        // Earlier dates = longer-supported once continuity keeps them.
        lastSupportedAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    )
    await replacePlaybookBriefingClaims(db, playbookId, claims, '2026-08-18T00:00:00.000Z', 1)

    const summary = await readPlaybookBriefingSummary(db, playbookId, '2026-08-18T00:00:00.000Z')
    expect(summary).toHaveLength(PLAYBOOK_GET_CLAIM_CAP)
    expect(summary.every((c) => c.current)).toBe(true)
    // Ascending lastSupportedAt = longest-supported first.
    for (let i = 1; i < summary.length; i++) {
      expect(summary[i - 1]!.lastSupportedAt <= summary[i]!.lastSupportedAt).toBe(true)
    }
  })

  it('oldestCurrentAttempt is the filedAt of the 50th most recent run, or null below 50', async () => {
    expect(await oldestCurrentPlaybookAttempt(db, playbookId)).toBeNull()

    for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) {
      const runner = await registerAgent(db, {
        name: `runner-${i}`,
        platform: 'openclaw',
        operator: null,
      })
      if (runner.outcome !== 'registered') throw new Error('register failed')
      await recordPlaybookRun(db, {
        playbookId,
        agentId: runner.agent.id,
        report: {
          outcome: 'completed',
          did: `Run number ${i}.`,
        },
      })
    }

    const oldest = await oldestCurrentPlaybookAttempt(db, playbookId)
    expect(oldest).not.toBeNull()

    const [earliest] = await db
      .select({ filedAt: playbookRuns.updatedAt })
      .from(playbookRuns)
      .where(eq(playbookRuns.playbookId, playbookId))
      .orderBy(asc(playbookRuns.updatedAt))
    // With exactly 50, the oldest in the window is the earliest filed.
    // offset 49 from newest = the oldest of the 50.
    expect(oldest).toBe(new Date(earliest!.filedAt).toISOString())
  })

  it('corpus is approved published notes only, newest first', async () => {
    const { run: approved } = await recordPlaybookRun(db, {
      playbookId,
      agentId: authorId,
      report: {
        outcome: 'completed',
        did: 'Finished the sweep.',
        note: 'Proved mailbox first, then answered one ticket.',
      },
    })
    await recordPlaybookNoteVerdict(db, {
      runId: approved.id,
      judged: 'Proved mailbox first, then answered one ticket.',
      decision: 'approved',
      published: 'Proved mailbox first, then answered one ticket.',
    })

    const other = await registerAgent(db, {
      name: 'pending-runner',
      platform: 'claude',
      operator: null,
    })
    if (other.outcome !== 'registered') throw new Error('register failed')
    await recordPlaybookRun(db, {
      playbookId,
      agentId: other.agent.id,
      report: {
        outcome: 'blocked',
        did: 'Stopped at the reply.',
        note: 'Still pending moderation.',
      },
    })

    const corpus = await playbookBriefingCorpus(db, playbookId)
    expect(corpus).toHaveLength(1)
    expect(corpus[0]?.content).toBe('Proved mailbox first, then answered one ticket.')
    expect(corpus[0]?.platform).toBe('openclaw')
  })

  it('empty replace deletes every claim for the playbook', async () => {
    await replacePlaybookBriefingClaims(
      db,
      playbookId,
      [aClaim({ text: 'Temporary claim.', sources: [randomUUID()] })],
      '2026-08-10T00:00:00.000Z',
      1,
    )
    await replacePlaybookBriefingClaims(db, playbookId, [], '2026-08-11T00:00:00.000Z', 1)
    const rows = await db
      .select()
      .from(playbookBriefingClaims)
      .where(eq(playbookBriefingClaims.playbookId, playbookId))
    expect(rows).toHaveLength(0)
  })
})
