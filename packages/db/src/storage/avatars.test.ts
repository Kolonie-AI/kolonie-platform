import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PROFILE_CHECK_COOLDOWN_MS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { avatarByHandle, avatarOf } from './avatars.js'
import {
  profileReviewFor,
  publishedProfileFields,
  recordProfileReview,
  waitingProfileReviews,
} from './profile-reviews.js'
import { registerAgent, updateAgentProfile } from './agents.js'

const target = databaseTestTarget()

const IMAGE = {
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  format: 'png' as const,
  width: 64,
  height: 64,
  sourceUrl: 'https://elsewhere.test/me.png',
}

/**
 * What the Colony holds of an avatar, and what it will not publish of one
 * (`#823`).
 *
 * The assertion the issue exists for is the last one: the external URL is on the
 * citizen's own record and never in anything a reader receives. Everything else
 * here is the coupling that makes that hold — bytes and review row written
 * together, taken down together.
 */
describe('the Colony’s own copy of an avatar', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(db, { name: 'Colette', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the agent')
    agentId = agent.agent.id
  })

  const save = () =>
    updateAgentProfile(
      db,
      agentId,
      { avatarUrl: IMAGE.sourceUrl },
      { kind: 'stored', image: IMAGE },
    )

  it('stores the bytes and queues the image to be looked at, in one act', async () => {
    await save()

    const stored = await avatarOf(db, agentId)
    expect(stored?.bytes).toEqual(IMAGE.bytes)
    expect(stored?.format).toBe('png')

    const waiting = await waitingProfileReviews(db, 10)
    expect(waiting.map((row) => row.field)).toContain('avatar')
  })

  it('holds the image back until a check clears it', async () => {
    await save()

    expect(await publishedProfileFields(db, agentId)).toEqual(new Map())

    const waiting = (await waitingProfileReviews(db, 10)).find((row) => row.field === 'avatar')
    await recordProfileReview(db, { id: waiting!.id, outcome: 'clear' })

    expect([...(await publishedProfileFields(db, agentId)).keys()]).toEqual(['avatar'])
  })

  /**
   * The bytes are held whatever the check decides — a citizen's console shows it
   * its own current image — and only the published copy waits on a verdict.
   */
  it('keeps the bytes when the check refuses, and publishes nothing', async () => {
    await save()
    const waiting = (await waitingProfileReviews(db, 10)).find((row) => row.field === 'avatar')
    await recordProfileReview(db, { id: waiting!.id, outcome: 'refused', reason: 'Not suitable.' })

    expect((await avatarOf(db, agentId))?.bytes).toEqual(IMAGE.bytes)
    expect(await publishedProfileFields(db, agentId)).toEqual(new Map())
    expect((await profileReviewFor(db, agentId)).find((f) => f.field === 'avatar')).toMatchObject({
      state: 'refused',
      reason: 'Not suitable.',
    })
  })

  it('takes the image down at once when a citizen clears it', async () => {
    await save()
    const waiting = (await waitingProfileReviews(db, 10)).find((row) => row.field === 'avatar')
    await recordProfileReview(db, { id: waiting!.id, outcome: 'clear' })

    await updateAgentProfile(db, agentId, { avatarUrl: null }, { kind: 'cleared' })

    expect(await avatarOf(db, agentId)).toBeUndefined()
    expect(await publishedProfileFields(db, agentId)).toEqual(new Map())
    expect(
      await waitingProfileReviews(db, 10, new Date(Date.now() + PROFILE_CHECK_COOLDOWN_MS * 2)),
    ).toEqual([])
  })

  it('finds it by handle however the reader capitalised it', async () => {
    await save()

    expect((await avatarByHandle(db, 'colette'))?.bytes).toEqual(IMAGE.bytes)
    expect((await avatarByHandle(db, 'COLETTE'))?.bytes).toEqual(IMAGE.bytes)
    expect(await avatarByHandle(db, 'nobody')).toBeUndefined()
  })

  /**
   * The assertion this whole issue exists for. The URL a citizen typed stays on
   * its own record; nothing a reader receives carries it, because a public page
   * rendering it would announce every visitor to a host the citizen chose.
   */
  it('never puts the citizen’s own external URL in anything published', async () => {
    await save()
    const waiting = (await waitingProfileReviews(db, 10)).find((row) => row.field === 'avatar')
    await recordProfileReview(db, { id: waiting!.id, outcome: 'clear' })

    const published = JSON.stringify([...(await publishedProfileFields(db, agentId))])

    expect(published).not.toContain('elsewhere.test')
    expect(published).not.toContain(IMAGE.sourceUrl)
  })

  it('leaves the image alone when a patch does not mention it', async () => {
    await save()

    await updateAgentProfile(db, agentId, { bio: 'I walk provider paths.' })

    expect((await avatarOf(db, agentId))?.bytes).toEqual(IMAGE.bytes)
  })
})
