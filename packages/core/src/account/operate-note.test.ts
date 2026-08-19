import { describe, expect, it } from 'vitest'
import { episodeVerdict } from './episode-recipe.js'
import {
  episodeOperateNote,
  FileOperateNoteSchema,
  OPERATE_NOTE_TAGS,
  OperateNoteBodySchema,
  OperateNoteTagSchema,
  ServedOperateNoteSchema,
} from './operate-note.js'

describe('operate note tags (#1299)', () => {
  it('accepts the five post-account tags and refuses anything else', () => {
    for (const tag of OPERATE_NOTE_TAGS) {
      expect(OperateNoteTagSchema.parse(tag)).toBe(tag)
    }
    expect(() => OperateNoteTagSchema.parse('signup')).toThrow()
    expect(() => OperateNoteTagSchema.parse('steps')).toThrow()
  })
})

describe('operate note body (#1299)', () => {
  it('takes a short tip and refuses a credential-shaped value', () => {
    expect(
      OperateNoteBodySchema.parse(
        'No IMAP on the free plan — fetch mail through the provider app password flow instead.',
      ),
    ).toContain('IMAP')

    expect(() => OperateNoteBodySchema.parse('short')).toThrow()
    expect(() =>
      OperateNoteBodySchema.parse('password=a7Kd93LsPq2mZx8vRt4Nb6Yh1Wc5Ge0Uj7Fi3Ao9'),
    ).toThrow()
  })
})

describe('filing and serving shapes (#1299)', () => {
  it('files against a kind/provider/tag and serves without the raw body', () => {
    const filed = FileOperateNoteSchema.parse({
      kind: 'mailbox',
      provider: 'gmx.com',
      tag: 'access-method',
      note: 'No IMAP on the free plan — use the app password flow to fetch mail.',
    })
    expect(filed.tag).toBe('access-method')

    const served = ServedOperateNoteSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      tag: 'access-method',
      note: 'No IMAP on the free plan — use the app password flow to fetch mail.',
      by: 'walker',
    })
    expect(served.by).toBe('walker')
    expect(served).not.toHaveProperty('body')
  })
})

describe('episodeOperateNote (#1299)', () => {
  it('accepts a closed maintenance repair or failure as a tip source', () => {
    expect(episodeOperateNote({ kind: 'maintenance', outcome: 'repaired', wall: null }).kind).toBe(
      'note',
    )
    expect(
      episodeOperateNote({ kind: 'maintenance', outcome: 'failed', wall: 'no IMAP' }).kind,
    ).toBe('note')
  })

  it('refuses acquisition, abandoned, and open episodes', () => {
    expect(episodeOperateNote({ kind: 'acquisition', outcome: 'created', wall: null }).kind).toBe(
      'nothing',
    )
    expect(episodeOperateNote({ kind: 'maintenance', outcome: 'abandoned', wall: null }).kind).toBe(
      'nothing',
    )
    expect(episodeOperateNote({ kind: 'maintenance', outcome: null, wall: null }).kind).toBe(
      'nothing',
    )
  })

  it('leaves episodeVerdict untouched — maintenance still proposes no recipe steps', () => {
    for (const outcome of ['repaired', 'failed', 'abandoned'] as const) {
      const episode = {
        kind: 'maintenance' as const,
        outcome,
        wall: outcome === 'failed' ? 'the wall' : null,
      }
      expect(episodeVerdict(episode, undefined).kind).toBe('nothing')
    }
    // A repaired maintenance may file an operate tip without ever writing steps.
    expect(episodeOperateNote({ kind: 'maintenance', outcome: 'repaired', wall: null }).kind).toBe(
      'note',
    )
    expect(
      episodeVerdict({ kind: 'maintenance', outcome: 'repaired', wall: null }, undefined).kind,
    ).toBe('nothing')
  })
})
