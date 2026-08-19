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
  upsertOperateNote,
} from './provider-operate-notes.js'

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
