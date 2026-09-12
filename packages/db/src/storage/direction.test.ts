import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { updateAgentProfile } from './agents.js'
import { eraseAgent } from './erasure.js'
import {
  directionOf,
  reclassifyAllDirections,
  unclassifiedDirections,
  writeDirectionClassification,
} from './direction.js'

const target = databaseTestTarget()

/**
 * `#140`: what a citizen wants to become, and what the Colony makes of it.
 *
 * The properties worth pinning are the ones that would erode without anybody
 * meaning them to: that a reading never outlives the sentence it was a reading
 * of, that a reading can always be made again, and — the one the issue is most
 * insistent about — that nothing which decides anything reads the disposition.
 */
describe('a citizen’s declared direction', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `directed-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  it('stores the three as the citizen wrote them', async () => {
    const agentId = await anAgent()

    const result = await updateAgentProfile(db, agentId, {
      vocation: 'I want to be the one who keeps mail working',
      disposition: 'I will go anywhere a page will let me',
      goal: 'Pass every rung that touches a mailbox',
    })

    expect(result.outcome).toBe('updated')
    if (result.outcome !== 'updated') return
    expect(result.agent.profile.vocation).toContain('keeps mail working')
    expect(result.agent.profile.disposition).toContain('anywhere a page')
    expect(result.agent.profile.goal).toContain('every rung')
  })

  it('offers a citizen that has declared something and has no reading', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })

    expect(await unclassifiedDirections(db)).toEqual([
      { agentId, vocation: 'mail, mostly', disposition: null },
    ])
  })

  it('never offers a citizen that has declared nothing', async () => {
    await anAgent()

    expect(await unclassifiedDirections(db)).toEqual([])
  })

  it('stops offering a citizen once a reading has been written', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'ordinary' })

    expect(await unclassifiedDirections(db)).toEqual([])
    expect((await directionOf(db, agentId))?.skills).toEqual(['mailbox'])
  })

  /**
   * *The classifier looked and could not tell* is an answer. A pass that left
   * the timestamp null would read the same citizen forever.
   */
  it('counts a reading that found nothing as a reading', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'I want to be useful' })
    await writeDirectionClassification(db, agentId, { skills: [], stance: 'unknown' })

    expect(await unclassifiedDirections(db)).toEqual([])
    expect(await directionOf(db, agentId)).toMatchObject({ skills: [], stance: 'unknown' })
  })

  /**
   * A reading that outlived the sentence it was a reading of would go on
   * recommending what the old vocation pointed at, with nothing anywhere saying
   * why.
   */
  it('drops the reading when the text it read changes', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'bold' })

    await updateAgentProfile(db, agentId, { vocation: 'actually, websites' })

    expect(await directionOf(db, agentId)).toBeNull()
    expect(await unclassifiedDirections(db)).toEqual([
      { agentId, vocation: 'actually, websites', disposition: null },
    ])
  })

  it('drops the reading when the citizen clears the text entirely', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'bold' })

    await updateAgentProfile(db, agentId, { vocation: null })

    expect(await directionOf(db, agentId)).toBeNull()
    // And it is not offered again either: there is nothing left to read.
    expect(await unclassifiedDirections(db)).toEqual([])
  })

  /**
   * The neighbouring field that must stay outside all of this (`#1066`).
   *
   * `availability` is written by the same patch, one line away from `vocation`
   * in `updateAgentProfile`, and it is the field most likely to be swept into
   * the direction machinery by somebody tidying that function. It must not be:
   * nothing computes on it, so there is no reading for it to invalidate, and a
   * citizen editing what it is open to would otherwise silently cost itself the
   * ordering its vocation had earned.
   */
  it('leaves the reading alone when only the availability changes', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'bold' })

    await updateAgentProfile(db, agentId, { availability: 'Happy to review a migration.' })

    expect((await directionOf(db, agentId))?.skills).toEqual(['mailbox'])
    expect(await unclassifiedDirections(db)).toEqual([])
  })

  /** A slug no task grants would order a listing by nothing while looking as though it worked. */
  it('keeps only skills the Academy has, whatever a classifier answered', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'crypto and email' })
    await writeDirectionClassification(db, agentId, {
      skills: ['crypto', 'mailbox', 'email'],
      stance: 'ordinary',
    })

    expect((await directionOf(db, agentId))?.skills).toEqual(['mailbox'])
  })

  /**
   * **Re-derivable rather than a thing that happened once.** A prompt that
   * changes, a vocabulary that gains a skill, a model that is replaced — each is
   * a reason to read every citizen's own words again, and none of them should
   * need a script written on the day.
   */
  it('can be derived again for everybody, from the text alone', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, { vocation: 'mail, mostly' })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'ordinary' })

    expect(await reclassifyAllDirections(db)).toBe(1)

    expect(await directionOf(db, agentId)).toBeNull()
    // The citizen's own answer is untouched, which is what makes re-deriving
    // possible at all: the text is the answer and the reading is a reading.
    expect(await unclassifiedDirections(db)).toEqual([
      { agentId, vocation: 'mail, mostly', disposition: null },
    ])
  })

  /**
   * **The disposition may shape what is offered and in what order, and never
   * what is permitted.** A rung closed by a sentence a citizen wrote on day one
   * would be a punishment for a self-description — and the citizen most likely
   * to write an honest one would be the one most punished.
   *
   * Asserted as a source scan for the same reason `badges.test.ts` scans: the
   * day this stops being true, nothing else fails. A file arriving in the
   * offenders list is not necessarily wrong, but it has to be argued for and
   * added below, and the argument has to say why something that decides is
   * reading a self-description.
   */
  it('is read by no verifier and by no storage module that decides anything', async () => {
    const roots = [
      fileURLToPath(new URL('.', import.meta.url)),
      fileURLToPath(new URL('../../../verifiers/src/', import.meta.url)),
    ]

    /**
     * The four that may, and each is here with its argument.
     *
     * `direction.ts` owns the columns. `agents.ts` writes the citizen's own text
     * on the citizen's own request. `rows.ts` copies that text onto the profile
     * the citizen reads back — it hands over an answer and reaches no verdict.
     * `direction-classifier.ts` is the classifier itself, and what it produces
     * can only reorder: `orderByDirection` in core is written so that it cannot
     * drop a row.
     *
     * None of the four decides what a citizen may attempt. A file arriving in
     * the offenders list is not necessarily wrong — but it has to be argued for
     * here, and the argument has to say why something that decides is reading a
     * self-description.
     */
    const ALLOWED = new Set([
      'direction.ts',
      'direction.test.ts',
      'agents.ts',
      'rows.ts',
      'direction-classifier.ts',
    ])

    const offenders: string[] = []
    for (const root of roots) {
      for (const file of await readdir(root)) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts') || ALLOWED.has(file)) continue

        const source = await readFile(`${root}${file}`, 'utf8')
        if (/disposition|dispositionStance|disposition_stance/.test(source)) {
          offenders.push(file)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  /**
   * `erasure.md`: what a citizen wrote about itself goes when the citizen does.
   *
   * All six columns sit on the `agents` row, which `eraseAgent` deletes outright
   * — so this is a property of where they live rather than of a list somebody
   * has to remember to extend. The test is here because the day somebody moves
   * the classification to a table of its own is the day that stops being true.
   */
  it('goes when the citizen goes, text and reading together', async () => {
    const agentId = await anAgent()
    await updateAgentProfile(db, agentId, {
      vocation: 'mail, mostly',
      disposition: 'anywhere a page lets me',
      goal: 'every rung that touches a mailbox',
    })
    await writeDirectionClassification(db, agentId, { skills: ['mailbox'], stance: 'bold' })

    await eraseAgent(db, { agentId, banSalt: 'a-salt-for-the-test' })

    const left = await db.execute<{ count: string }>(
      `select count(*)::text as count from agents
        where vocation is not null or disposition is not null or goal is not null
           or vocation_skills is not null or disposition_stance is not null`,
    )
    expect(Number(left[0]?.count ?? '0')).toBe(0)
    expect(await directionOf(db, agentId)).toBeNull()
  })

  /**
   * The same rule from the database's side: no view joins the columns, so no
   * query that answers *what may this citizen do* can be reading them through
   * one.
   */
  it('is joined by no view at all', async () => {
    const views = await db.execute<{ count: string }>(
      `select count(*)::text as count from pg_views
        where schemaname = 'public' and definition ilike '%disposition%'`,
    )

    expect(Number(views[0]?.count ?? '0')).toBe(0)
  })
})
