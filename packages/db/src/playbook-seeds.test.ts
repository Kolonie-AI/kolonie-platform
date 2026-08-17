import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { PlaybookDraftSchema, looksLikeCredential } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { PLAYBOOK_HOUSE_AUTHOR, PLAYBOOK_SEEDS, seedPlaybooks } from './playbook-seeds.js'
import { agents } from './schema/agents.js'
import { playbooks } from './schema/playbooks.js'
import { createPlaybook, playbookBySlug, playbooksByStatus } from './storage/playbooks.js'
import { registerAgent } from './storage/agents.js'

const target = databaseTestTarget()

/**
 * The starting catalogue of playbooks (`#1175`).
 *
 * **The acceptance criteria are asserted rather than reviewed.** Every rule the
 * issue names — three seeds or more, two steps each, a slot each, one
 * `needsOperator` step somewhere, all `open`, no credential, no promised income —
 * is a rule about the data, so it is checked against the data. A criterion signed
 * off by reading is one the sixth seed will break quietly.
 */
describe('the playbooks the Colony ships with', () => {
  it('has at least three, all of them slugged distinctly', () => {
    expect(PLAYBOOK_SEEDS.length).toBeGreaterThanOrEqual(3)
    const slugs = PLAYBOOK_SEEDS.map((one) => one.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('gives every seed at least two steps and at least one slot', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      expect(seed.draft.steps.length, seed.slug).toBeGreaterThanOrEqual(2)
      expect(seed.draft.requiredAccounts.length, seed.slug).toBeGreaterThanOrEqual(1)
    }
  })

  it('parses every seed through the schema a citizen’s draft is parsed through', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      expect(() => PlaybookDraftSchema.parse(seed.draft), seed.slug).not.toThrow()
    }
  })

  /**
   * Documenting the pattern is the point of the criterion, and a pattern nobody
   * demonstrates is one the first community author has to invent.
   */
  it('demonstrates needsOperator on at least one step', () => {
    const marked = PLAYBOOK_SEEDS.flatMap((seed) =>
      seed.draft.steps.filter((step) => step.needsOperator === true).map(() => seed.slug),
    )
    expect(marked.length).toBeGreaterThanOrEqual(1)
  })

  /**
   * Freeze A: a layer whose purpose is to end idle time may not begin by adding a
   * rung to climb. A seed demanding a proved account would be that rung, on the
   * five entries a citizen meets first.
   */
  it('asks no seed slot for a proved account', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      for (const slot of seed.draft.requiredAccounts) {
        expect(slot.minProved, `${seed.slug}/${slot.slot}`).toBe(false)
      }
    }
  })

  it('lets every step name only slots the playbook declares', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      const declared = new Set(seed.draft.requiredAccounts.map((one) => one.slot))
      for (const step of seed.draft.steps) {
        for (const slot of step.usesSlots ?? []) {
          expect(declared.has(slot), `${seed.slug}: step names ${slot}`).toBe(true)
        }
      }
    }
  })

  /**
   * The scrub already runs inside `PlaybookDraftSchema`, so this cannot fail
   * while that holds — which is exactly why it is worth having. It fails the day
   * somebody relaxes the schema, and it names the seed rather than the parse.
   */
  it('writes nothing that looks like a credential', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      const prose = [
        seed.draft.title,
        seed.draft.summary,
        ...seed.draft.steps.flatMap((step) => [step.title, step.detail ?? '']),
        ...(seed.draft.inspiration ?? []).map((one) => one.ref),
      ]
      for (const text of prose) {
        expect(looksLikeCredential(text), `${seed.slug}: ${text.slice(0, 40)}`).toBe(false)
      }
    }
  })

  /**
   * The issue's constraint, and not a stylistic one: a catalogue entry that
   * promises income is the shape of every scheme the open web is full of, and the
   * Colony's own five are what a citizen reads to learn what a playbook is.
   */
  it('promises nobody an income', () => {
    const promises =
      /guaranteed|guarantee[sd]? (?:income|earnings|payout)|passive income|risk-free/i
    for (const seed of PLAYBOOK_SEEDS) {
      const prose = [
        seed.draft.title,
        seed.draft.summary,
        ...seed.draft.steps.flatMap((step) => [step.title, step.detail ?? '']),
      ].join('\n')
      expect(promises.test(prose), seed.slug).toBe(false)
    }
  })

  /**
   * `inspiration` is a note about where an idea came from. Freeze B allows a URL
   * and forbids scraping, and the seeds carry notes only — nothing here is a
   * fetch waiting to happen.
   */
  it('carries notes as inspiration rather than anything to fetch', () => {
    for (const seed of PLAYBOOK_SEEDS) {
      for (const one of seed.draft.inspiration ?? []) {
        expect(one.type, seed.slug).toBe('note')
      }
    }
  })
})

describe('seeding the starting catalogue', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('writes every seed as an open, published playbook', async () => {
    const result = await seedPlaybooks(db)

    expect(result.created).toBe(PLAYBOOK_SEEDS.length)
    expect(result.updated).toBe(0)
    expect(result.skipped).toEqual([])

    const open = await playbooksByStatus(db, { statuses: ['open'] })
    expect(open.map((one) => one.slug).sort()).toEqual(PLAYBOOK_SEEDS.map((one) => one.slug).sort())
    for (const one of open) {
      expect(one.publishedAt, one.slug).not.toBeNull()
      expect(one.authorAgentId, one.slug).toBe(result.authorAgentId)
    }
  })

  it('attributes them to a house row that is a test account and holds no key', async () => {
    const { authorAgentId } = await seedPlaybooks(db)

    const [author] = await db.select().from(agents).where(eq(agents.id, authorAgentId)).limit(1)
    expect(author?.name).toBe(PLAYBOOK_HOUSE_AUTHOR)
    /**
     * The row is excluded from every citizen statistic by the twenty-odd queries
     * already written `eq(agents.type, 'citizen')`. Marking it `citizen` would
     * add one to the population of the Colony, which is false.
     */
    expect(author?.type).toBe('test')
  })

  it('is safe to run again, and puts a hand-edited seed back', async () => {
    const first = await seedPlaybooks(db)

    const edited = await playbookBySlug(db, PLAYBOOK_SEEDS[0]!.slug)
    expect(edited).not.toBeNull()
    // Somebody corrects a title by hand, the way an urgent fix reaches a
    // production row. The next deploy is what puts the repository back in charge.
    await db
      .update(playbooks)
      .set({ title: 'Edited in production, by somebody in a hurry' })
      .where(eq(playbooks.id, edited!.id))

    const second = await seedPlaybooks(db)
    expect(second.created).toBe(0)
    expect(second.updated).toBe(PLAYBOOK_SEEDS.length)
    expect(second.authorAgentId).toBe(first.authorAgentId)

    const open = await playbooksByStatus(db, { statuses: ['open'] })
    expect(open.length).toBe(PLAYBOOK_SEEDS.length)

    const again = await playbookBySlug(db, PLAYBOOK_SEEDS[0]!.slug)
    expect(again?.title).toBe(PLAYBOOK_SEEDS[0]!.draft.title)
    /** Refreshed, not replaced: the row a citizen may already have run keeps its id. */
    expect(again?.id).toBe(edited?.id)
  })

  /**
   * Expected never to happen — `kolonie` is a reserved handle fragment, so no
   * citizen can hold the house name. What is asserted is the behaviour if a slug
   * is somehow taken anyway: the citizen's playbook stands, and the seed says so
   * rather than overwriting it.
   */
  it('leaves a slug held by another author alone, and reports it', async () => {
    const citizen = await registerAgent(db, {
      name: 'not-the-house',
      platform: 'openclaw',
      operator: null,
    })
    if (citizen.outcome !== 'registered') throw new Error('could not register the citizen')

    const taken = PLAYBOOK_SEEDS[0]!
    await createPlaybook(db, {
      slug: taken.slug,
      authorAgentId: citizen.agent.id,
      status: 'open',
      draft: {
        title: 'A citizen’s own pipeline, under a name the Colony wanted',
        summary: 'Written by somebody else, and not the seed script’s to rewrite.',
        requiredAccounts: taken.draft.requiredAccounts,
        steps: taken.draft.steps,
      },
    })

    const result = await seedPlaybooks(db)
    expect(result.skipped).toEqual([taken.slug])
    expect(result.created).toBe(PLAYBOOK_SEEDS.length - 1)

    const kept = await playbookBySlug(db, taken.slug)
    expect(kept?.authorAgentId).toBe(citizen.agent.id)
  })
})
