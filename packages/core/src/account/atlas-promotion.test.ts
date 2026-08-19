import { describe, expect, it } from 'vitest'
import {
  atlasPinReading,
  atlasPromotionOf,
  atlasPromotionSentence,
  type AtlasPromotionStage,
} from './atlas-promotion.js'

/**
 * The way from a walk to a route (`#1303`).
 *
 * **What is asserted here is that nothing promotes anything.** `#1032` says
 * walker prose is never published as the Colony's route, so every case below
 * either names a move a citizen can make or says out loud that the next one is
 * not theirs — and none of them turns a cleared route into a joinable entry.
 */

const row = (over: Partial<{ status: string; steps: unknown[]; attempted: number }> = {}) => ({
  status: over.status ?? 'measured',
  steps: over.steps ?? [],
  figures: { attempted: over.attempted ?? 0 },
})

describe('where one row stands', () => {
  it('is sighted when it is on the map and nobody has walked it', () => {
    const promotion = atlasPromotionOf(row({ status: 'unwritten' }))

    expect(promotion.stage).toBe<AtlasPromotionStage>('sighted')
    expect(promotion.whose).toBe('citizen')
    expect(promotion.next).toContain('walk-report')
  })

  it('is walked once there is a corpus and no route offered', () => {
    const promotion = atlasPromotionOf(row({ attempted: 3 }))

    expect(promotion.stage).toBe<AtlasPromotionStage>('walked')
    expect(promotion.whose).toBe('citizen')
    expect(promotion.next).toContain('`recipe`')
  })

  it('counts attempts and not proofs, so a wall of refusals is still a corpus', () => {
    /**
     * A provider ten citizens were refused by has the evidence most worth
     * writing out — the route that matters there is the one saying where it
     * stops. Counting successes would report `sighted` for the entry with the
     * most behind it.
     */
    expect(atlasPromotionOf(row({ attempted: 10 })).stage).toBe('walked')
  })

  it('is route-offered, and says the next move is not the citizen’s', () => {
    const promotion = atlasPromotionOf(row({ attempted: 2 }), { hasClearedRoute: true })

    expect(promotion.stage).toBe<AtlasPromotionStage>('route-offered')
    expect(promotion.whose).toBe('steward')
    expect(promotion.next).toContain('steward')
  })

  it('does not read route-offered as a promise that it will be adopted', () => {
    /**
     * `#1032`. A cleared route is one citizen's account, scrubbed; whether the
     * Colony repeats it as instruction is a judgement about somebody else's
     * product, and nothing here queues or schedules that judgement.
     */
    const promotion = atlasPromotionOf(row({ attempted: 2 }), { hasClearedRoute: true })

    expect(promotion.next).toContain('has not adopted')
    expect(promotion.next).not.toContain('will be')
  })

  it('is joinable when the Colony wrote steps', () => {
    const promotion = atlasPromotionOf(row({ status: 'joinable', steps: [{}, {}] }))

    expect(promotion.stage).toBe<AtlasPromotionStage>('joinable')
    expect(promotion.whose).toBe('nobody')
  })

  it('is closed on a refusal and on a withdrawal, ahead of everything else', () => {
    /**
     * Ahead of the steps check on purpose: a withdrawn entry keeps the steps it
     * had, and reporting it as a route to follow is the one answer that could
     * send a citizen at a door the Colony has closed.
     */
    expect(atlasPromotionOf(row({ status: 'refused' })).stage).toBe('closed')
    expect(atlasPromotionOf(row({ status: 'retired', steps: [{}] })).stage).toBe('closed')
    expect(atlasPromotionOf(row({ status: 'retired', steps: [{}] })).whose).toBe('nobody')
  })

  it('reports what it was told rather than guessing about a route it did not look up', () => {
    /**
     * The routes are loaded on a one-provider read only (`#1090`), so a
     * catalogue read genuinely does not know. Guessing `false` would report
     * `walked` for an entry whose route is on the page.
     */
    expect(atlasPromotionOf(row({ attempted: 1 })).stage).toBe('walked')
    expect(atlasPromotionOf(row({ attempted: 1 }), { hasClearedRoute: false }).stage).toBe('walked')
  })
})

describe('the sentence a page and a tool print', () => {
  it('names the stage and whose move it is', () => {
    const yours = atlasPromotionSentence(atlasPromotionOf(row({ attempted: 1 })))
    const theirs = atlasPromotionSentence(
      atlasPromotionOf(row({ attempted: 1 }), { hasClearedRoute: true }),
    )
    const nobody = atlasPromotionSentence(atlasPromotionOf(row({ status: 'refused' })))

    expect(yours).toContain('Your move')
    expect(theirs).toContain('Waiting on a steward')
    expect(nobody).toContain('Nothing is waiting')
  })
})

describe('a playbook pinning a provider', () => {
  it('says nothing at all when the pin is supported', () => {
    /**
     * The ordinary case. A note on every draft is a note an author learns to
     * skip, and the ones that matter would be skipped with it.
     */
    const reading = atlasPinReading({
      slot: 'mailbox',
      provider: 'gmx.com',
      entry: { status: 'joinable' },
    })

    expect(reading.standing).toBe('joinable')
    expect(reading.note).toBeNull()
  })

  it('says the Atlas has never heard of it, without refusing the pin', () => {
    const reading = atlasPinReading({ slot: 'notes', provider: 'nowhere.invalid' })

    expect(reading.standing).toBe('absent')
    expect(reading.note).toContain('absence and not a refusal')
    expect(reading.note).toContain('the pin stands')
  })

  it('says a refused pin is a playbook nobody without the account can run', () => {
    const reading = atlasPinReading({
      slot: 'social',
      provider: 'bsky.app',
      entry: { status: 'refused' },
    })

    expect(reading.standing).toBe('closed')
    expect(reading.note).toContain('cannot run this playbook')
  })

  it('distinguishes a walked entry from a joinable one, because they read differently', () => {
    const reading = atlasPinReading({
      slot: 'mailbox',
      provider: 'gmx.com',
      entry: { status: 'measured' },
    })

    expect(reading.standing).toBe('walked')
    expect(reading.note).toContain('no steps to')
  })
})
