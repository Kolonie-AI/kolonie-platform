import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, figureKey, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import {
  pendingOperateNotes,
  publishedOperateNotes,
  publishedOperateNotesAt,
  recordOperateNoteVerdict,
  rewardPublishedOperateNotes,
  upsertOperateNote,
} from './provider-operate-notes.js'
import { sql } from 'drizzle-orm'
import { OPERATE_NOTE_PUBLISHED_REPUTATION } from '@kolonie-ai/core'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * Post-account operate tips (`#1299`).
 *
 * What only a database can answer: pending tips are invisible to readers, an
 * approved scrubbed body is what is served, a rewrite resets moderation, and
 * attribution follows `agents.attributed`. The tip never lands in recipe steps —
 * that refusal lives in `episodeOperateNote` / `episodeVerdict` in core.
 */
describe('provider operate notes (#1299)', () => {
  let db: Database
  let author: AgentId
  let other: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const register = async (name: string): Promise<AgentId> => {
    const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return agent.agent.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    author = await register('tipper')
    other = await register('other')
  })

  const where = { kind: kind('mailbox'), provider: 'mail.example' }
  const tip =
    'No IMAP on the free plan — fetch mail through the provider app password flow instead.'

  it('files a tip as pending and serves nothing until approved', async () => {
    const written = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'access-method',
      note: tip,
    })
    expect(written).toEqual({ outcome: 'written', id: expect.any(String), replaced: false })

    expect(await publishedOperateNotes(db, where)).toEqual([])
    expect(await pendingOperateNotes(db, 10)).toEqual([
      {
        id: written.outcome === 'written' ? written.id : '',
        kind: 'mailbox',
        provider: 'mail.example',
        tag: 'access-method',
        body: tip,
      },
    ])
  })

  it('serves only the scrubbed body after approval, with attribution', async () => {
    const written = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'access-method',
      note: tip,
    })
    if (written.outcome !== 'written') throw new Error('expected write')

    const scrubbed = 'No IMAP on the free plan — use the app password flow instead.'
    expect(
      await recordOperateNoteVerdict(db, {
        id: written.id,
        judged: tip,
        decision: 'approved',
        published: scrubbed,
      }),
    ).toEqual({ outcome: 'recorded' })

    expect(await publishedOperateNotes(db, where)).toEqual([
      {
        id: written.id,
        tag: 'access-method',
        note: scrubbed,
        by: 'tipper',
      },
    ])
    expect(await pendingOperateNotes(db, 10)).toEqual([])
  })

  it('hides the author handle when attribution is declined', async () => {
    await updateAgentProfile(db, author, { attributed: false })

    const written = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'quota',
      note: 'Free tier caps at 50 messages a day; the paid plan lifts that overnight.',
    })
    if (written.outcome !== 'written') throw new Error('expected write')

    await recordOperateNoteVerdict(db, {
      id: written.id,
      judged: 'Free tier caps at 50 messages a day; the paid plan lifts that overnight.',
      decision: 'approved',
      published: 'Free tier caps at 50 messages a day; the paid plan lifts that overnight.',
    })

    expect(await publishedOperateNotes(db, where)).toEqual([
      {
        id: written.id,
        tag: 'quota',
        note: 'Free tier caps at 50 messages a day; the paid plan lifts that overnight.',
        by: null,
      },
    ])
  })

  it('replaces a standing tip and resets moderation', async () => {
    const first = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'api',
      note: 'Create an API app under Settings → Developers before the token endpoint answers.',
    })
    if (first.outcome !== 'written') throw new Error('expected write')

    await recordOperateNoteVerdict(db, {
      id: first.id,
      judged: 'Create an API app under Settings → Developers before the token endpoint answers.',
      decision: 'approved',
      published: 'Create an API app under Settings → Developers before the token endpoint answers.',
    })

    const replacement =
      'The Developers page moved under Workspace → Integrations; create the app there first.'
    const second = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'api',
      note: replacement,
    })
    expect(second).toEqual({ outcome: 'written', id: first.id, replaced: true })
    expect(await publishedOperateNotes(db, where)).toEqual([])
    expect(await pendingOperateNotes(db, 10)).toEqual([
      expect.objectContaining({ id: first.id, body: replacement, tag: 'api' }),
    ])
  })

  it('keeps one citizen’s tip when another files on the same tag', async () => {
    const a = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'prove',
      note: 'Prove via provider-mail; the profile page never shows the verification string.',
    })
    const b = await upsertOperateNote(db, {
      agentId: other,
      ...where,
      tag: 'prove',
      note: 'Prove via provider-post on the public bio; mail proofs are ignored here.',
    })
    if (a.outcome !== 'written' || b.outcome !== 'written') throw new Error('expected writes')

    await recordOperateNoteVerdict(db, {
      id: a.id,
      judged: 'Prove via provider-mail; the profile page never shows the verification string.',
      decision: 'approved',
      published: 'Prove via provider-mail; the profile page never shows the verification string.',
    })
    await recordOperateNoteVerdict(db, {
      id: b.id,
      judged: 'Prove via provider-post on the public bio; mail proofs are ignored here.',
      decision: 'approved',
      published: 'Prove via provider-post on the public bio; mail proofs are ignored here.',
    })

    const served = await publishedOperateNotes(db, where)
    expect(served).toHaveLength(2)
    expect(served.map((note) => note.by).sort()).toEqual(['other', 'tipper'])
  })

  it('treats a stale verdict as no write when the body moved', async () => {
    const written = await upsertOperateNote(db, {
      agentId: author,
      ...where,
      tag: 'payout-ops',
      note: 'Payouts clear on Fridays; a Monday request waits the rest of the week.',
    })
    if (written.outcome !== 'written') throw new Error('expected write')

    expect(
      await recordOperateNoteVerdict(db, {
        id: written.id,
        judged: 'a different body the author no longer holds',
        decision: 'approved',
        published: 'Payouts clear on Fridays; a Monday request waits the rest of the week.',
      }),
    ).toEqual({ outcome: 'stale' })
    expect(await publishedOperateNotes(db, where)).toEqual([])
  })

  it('groups published tips by kind at one provider', async () => {
    const mailbox = await upsertOperateNote(db, {
      agentId: author,
      kind: kind('mailbox'),
      provider: 'shared.example',
      tag: 'access-method',
      note: 'Mailbox IMAP needs the app password, not the login password.',
    })
    const domain = await upsertOperateNote(db, {
      agentId: author,
      kind: kind('domain'),
      provider: 'shared.example',
      tag: 'access-method',
      note: 'Nameservers take up to 48 hours; the panel shows pending until then.',
    })
    if (mailbox.outcome !== 'written' || domain.outcome !== 'written') {
      throw new Error('expected writes')
    }

    await recordOperateNoteVerdict(db, {
      id: mailbox.id,
      judged: 'Mailbox IMAP needs the app password, not the login password.',
      decision: 'approved',
      published: 'Mailbox IMAP needs the app password, not the login password.',
    })
    await recordOperateNoteVerdict(db, {
      id: domain.id,
      judged: 'Nameservers take up to 48 hours; the panel shows pending until then.',
      decision: 'approved',
      published: 'Nameservers take up to 48 hours; the panel shows pending until then.',
    })

    const at = await publishedOperateNotesAt(db, 'shared.example')
    expect([...at.keys()].sort()).toEqual([
      figureKey('domain', 'shared.example'),
      figureKey('mailbox', 'shared.example'),
    ])
  })
})

/**
 * Paying for the Atlas's second contribution class (`#1300`).
 *
 * **What is asserted here is the cap.** `rewardPublishedWalks` pays once per
 * citizen × pair forever, which is what keeps breadth paying and depth paying
 * nothing — and a second class that could be earned five times at one provider
 * would put back exactly what that clause takes away. Every case below is either
 * *this is paid once* or *this is not paid at all*.
 */
describe('paying for a published operate tip (#1300)', () => {
  let db: Database
  let author: AgentId
  let other: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const register = async (name: string): Promise<AgentId> => {
    const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return agent.agent.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    author = await register('tipper')
    other = await register('other')
  })

  const pair = { kind: kind('mailbox'), provider: 'mail.example' }
  const body = 'No IMAP on the free plan — fetch mail through the app password flow instead.'

  const fileAndApprove = async (
    who: AgentId,
    tag: 'access-method' | 'api' | 'quota',
    at = pair,
    note = body,
  ): Promise<string> => {
    const written = await upsertOperateNote(db, { agentId: who, ...at, tag, note })
    if (written.outcome !== 'written') throw new Error('the tip was not written')

    const verdict = await recordOperateNoteVerdict(db, {
      id: written.id,
      judged: note,
      decision: 'approved',
      published: note,
    })
    if (verdict.outcome !== 'recorded') throw new Error('the verdict went stale in a fixture')

    return written.id
  }

  /**
   * **Counted on the ledger and not on the tip**, because *paid twice* is a
   * claim about reputation: a bug that stamped one `rewarded_at` and booked two
   * events would pass every assertion made against the tip rows alone.
   */
  const paymentsBooked = async (who: AgentId): Promise<number> => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from reputation_events
           where agent_id = ${who} and reason = 'operate_note_published'`,
    )
    return [...rows][0]?.n ?? 0
  }

  const reputation = async (who: AgentId): Promise<number> => {
    const rows = await db.execute<{ total: number }>(
      sql`select coalesce(sum(delta), 0)::int as total from reputation_events where agent_id = ${who}`,
    )
    return [...rows][0]?.total ?? 0
  }

  it('pays the author once the tip is readable', async () => {
    const id = await fileAndApprove(author, 'access-method')

    const paid = await rewardPublishedOperateNotes(db)

    expect(paid).toHaveLength(1)
    expect(paid[0]?.noteId).toBe(id)
    expect(paid[0]?.agentId).toBe(author)
    expect(paid[0]?.provider).toBe(pair.provider)
    expect(paid[0]?.tag).toBe('access-method')
    expect(await reputation(author)).toBe(OPERATE_NOTE_PUBLISHED_REPUTATION)
    expect(await paymentsBooked(author)).toBe(1)
  })

  it('pays nothing for a tip nobody has approved yet', async () => {
    const written = await upsertOperateNote(db, {
      agentId: author,
      ...pair,
      tag: 'access-method',
      note: body,
    })
    if (written.outcome !== 'written') throw new Error('the tip was not written')

    expect(await rewardPublishedOperateNotes(db)).toEqual([])
    expect(await paymentsBooked(author)).toBe(0)
  })

  it('pays nothing for a tip a moderator refused', async () => {
    const written = await upsertOperateNote(db, {
      agentId: author,
      ...pair,
      tag: 'access-method',
      note: body,
    })
    if (written.outcome !== 'written') throw new Error('the tip was not written')
    await recordOperateNoteVerdict(db, { id: written.id, judged: body, decision: 'rejected' })

    expect(await rewardPublishedOperateNotes(db)).toEqual([])
    expect(await paymentsBooked(author)).toBe(0)
  })

  it('is idempotent: a second sweep pays nothing more', async () => {
    await fileAndApprove(author, 'access-method')

    await rewardPublishedOperateNotes(db)

    expect(await rewardPublishedOperateNotes(db)).toEqual([])
    expect(await paymentsBooked(author)).toBe(1)
  })

  /**
   * **The cap, and the whole reason this class could be added at all.** The tag
   * vocabulary is closed and finite, so paying per tag would be five payments at
   * one provider — depth farming with extra steps, and precisely what the walk
   * bound exists to refuse.
   */
  it('pays once per pair however many tags the citizen files there', async () => {
    await fileAndApprove(author, 'access-method')
    await fileAndApprove(
      author,
      'api',
      pair,
      'The v2 API needs a separate token, made in settings.',
    )
    await fileAndApprove(author, 'quota', pair, 'Two hundred messages a day, and it is a hard cap.')

    const paid = await rewardPublishedOperateNotes(db)

    expect(paid).toHaveLength(1)
    expect(await paymentsBooked(author)).toBe(1)
    expect(await reputation(author)).toBe(OPERATE_NOTE_PUBLISHED_REPUTATION)
  })

  it('pays a second time at a different provider, because breadth is what pays', async () => {
    await fileAndApprove(author, 'access-method')
    await rewardPublishedOperateNotes(db)

    await fileAndApprove(author, 'access-method', {
      kind: kind('mailbox'),
      provider: 'other.example',
    })

    expect(await rewardPublishedOperateNotes(db)).toHaveLength(1)
    expect(await paymentsBooked(author)).toBe(2)
  })

  it('pays a second time for a different kind at the same provider', async () => {
    /**
     * The walk bound is per (kind, provider) and this matches it. A mailbox and
     * an API account at one host are two different accounts to operate, and a
     * tip about one says nothing about the other.
     */
    await fileAndApprove(author, 'access-method')
    await rewardPublishedOperateNotes(db)

    await fileAndApprove(author, 'api', { kind: kind('api'), provider: pair.provider })

    expect(await rewardPublishedOperateNotes(db)).toHaveLength(1)
    expect(await paymentsBooked(author)).toBe(2)
  })

  it('does not pay again when the author rewrites a tip it was already paid for', async () => {
    /**
     * A rewrite resets moderation and clears the scrub, so the row goes back
     * through the pass. A citizen correcting itself must not be paid again for
     * it — and must not lose what it earned either.
     */
    await fileAndApprove(author, 'access-method')
    await rewardPublishedOperateNotes(db)

    const corrected = 'IMAP is available on the free plan after all — the setting is under Mail.'
    await fileAndApprove(author, 'access-method', pair, corrected)

    expect(await rewardPublishedOperateNotes(db)).toEqual([])
    expect(await paymentsBooked(author)).toBe(1)
  })

  it('pays two citizens who each wrote a tip at the same pair', async () => {
    /**
     * The cap is per citizen. Refine-by-others is the whole point: the second
     * citizen deepening a provider is doing work the first did not.
     */
    await fileAndApprove(author, 'access-method')
    await fileAndApprove(other, 'api', pair, 'The v2 API needs a separate token, made in settings.')

    const paid = await rewardPublishedOperateNotes(db)

    expect(paid).toHaveLength(2)
    expect(await paymentsBooked(author)).toBe(1)
    expect(await paymentsBooked(other)).toBe(1)
  })

  it('is worth less than a walk, because a tip is a sentence and a walk is a session', async () => {
    expect(OPERATE_NOTE_PUBLISHED_REPUTATION).toBeLessThan(3)
  })
})
