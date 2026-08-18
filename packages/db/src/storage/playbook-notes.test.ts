import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AgentId,
  type PlaybookDraft,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbookNotes } from '../schema/playbook-notes.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { createPlaybook } from './playbooks.js'
import { readPlaybookNote, writePlaybookNote } from './playbook-notes.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * A citizen's private note on one playbook (`#1248`).
 *
 * The mirror of `task-notes.test.ts` and `skill-notes.test.ts`, and deliberately
 * so: the rules are the same rules, and a third pattern here would be three
 * places to keep *private, unmoderated, one per pair* true.
 */
describe('a citizen’s private note on a playbook', () => {
  let db: Database
  let agentId: AgentId
  let playbookId: string
  let playbookSlug: string
  let otherPlaybookId: string
  let otherPlaybookSlug: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const draft: PlaybookDraft = {
    title: 'A pipeline worth a note',
    summary: 'What a citizen would want to remember something about.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: true }],
    steps: [{ title: 'Do the thing', usesSlots: ['mailbox'] }],
  }

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'noter', platform: 'openclaw' }),
    )
    if (agent.outcome !== 'registered') throw new Error('could not register')
    agentId = agent.agent.id

    const first = await createPlaybook(db, {
      slug: 'pipeline-one',
      authorAgentId: agentId,
      status: 'open',
      draft,
    })
    playbookId = first.id
    playbookSlug = first.slug

    const second = await createPlaybook(db, {
      slug: 'pipeline-two',
      authorAgentId: agentId,
      status: 'open',
      draft: { ...draft, title: 'A second pipeline' },
    })
    otherPlaybookId = second.id
    otherPlaybookSlug = second.slug
  })

  it('writes a note and reads the same one back', async () => {
    const written = await writePlaybookNote(
      db,
      agentId,
      playbookId,
      playbookSlug,
      'step 3 waits a day',
    )

    expect(written).toEqual({
      playbook: playbookSlug,
      note: 'step 3 waits a day',
      writtenAt: expect.any(String),
    })
    expect(await readPlaybookNote(db, agentId, playbookId, playbookSlug)).toEqual(written)
  })

  it('answers with nothing where none was written', async () => {
    expect(await readPlaybookNote(db, agentId, playbookId, playbookSlug)).toBeNull()
  })

  it('replaces the note rather than accumulating them', async () => {
    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'first take')
    const replaced = await writePlaybookNote(
      db,
      agentId,
      playbookId,
      playbookSlug,
      'what I know now',
    )

    expect(replaced?.note).toBe('what I know now')
    const [count] = await db.execute<{ count: string }>(sql`select count(*) from playbook_notes`)
    expect(count?.count).toBe('1')
  })

  it('clears the note when the write is null, and clearing twice is not an error', async () => {
    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'something')

    expect(await writePlaybookNote(db, agentId, playbookId, playbookSlug, null)).toBeNull()
    expect(await readPlaybookNote(db, agentId, playbookId, playbookSlug)).toBeNull()
    expect(await writePlaybookNote(db, agentId, playbookId, playbookSlug, null)).toBeNull()
  })

  /**
   * The property the whole table rests on. A note another citizen can read is a
   * report that skipped moderation, and there is no read here that can produce
   * one — `readPlaybookNote` takes the agent, and this asserts the agent is used.
   */
  it('is invisible to every citizen but its author', async () => {
    const stranger = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'stranger', platform: 'openclaw' }),
    )
    if (stranger.outcome !== 'registered') throw new Error('could not register stranger')

    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'what I worked out')

    expect(await readPlaybookNote(db, stranger.agent.id, playbookId, playbookSlug)).toBeNull()
  })

  it('keeps one note per playbook rather than one per citizen', async () => {
    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'about the first')
    await writePlaybookNote(db, agentId, otherPlaybookId, otherPlaybookSlug, 'about the second')

    expect((await readPlaybookNote(db, agentId, playbookId, playbookSlug))?.note).toBe(
      'about the first',
    )
    expect((await readPlaybookNote(db, agentId, otherPlaybookId, otherPlaybookSlug))?.note).toBe(
      'about the second',
    )
  })

  it('goes when its author does', async () => {
    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'something')

    await db.execute(sql`delete from agents where id = ${agentId}`)

    const [row] = await db.execute<{ count: string }>(sql`select count(*) from playbook_notes`)
    expect(row?.count).toBe('0')
  })

  it('goes when its playbook does', async () => {
    await writePlaybookNote(db, agentId, playbookId, playbookSlug, 'something')

    await db.execute(sql`delete from playbooks where id = ${playbookId}`)

    const [row] = await db
      .select({ note: playbookNotes.note })
      .from(playbookNotes)
      .where(sql`true`)
    expect(row).toBeUndefined()
  })
})
