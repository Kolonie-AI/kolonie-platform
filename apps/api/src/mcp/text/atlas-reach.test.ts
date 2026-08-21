import { describe, expect, it } from 'vitest'
import type { ServedWalkNote, ServedWalkRoute } from '@kolonie-ai/core'
import { atlasReachAsText } from './atlas-reach.js'

const note = (by: string | null): ServedWalkNote => ({
  walkId: '00000000-0000-4000-8000-000000000001',
  note: 'The signup wanted a card.',
  by,
  helpfulCount: 0,
  unhelpfulCount: 0,
})

const route = (by: string | null): ServedWalkRoute => ({
  walkId: '00000000-0000-4000-8000-000000000002',
  route: 'Open the console, then ask for a token.',
  by,
})

const reach = (over: Partial<Parameters<typeof atlasReachAsText>[0]> = {}) =>
  atlasReachAsText({
    walkers: [],
    notes: [],
    route: undefined,
    reader: undefined,
    full: true,
    ...over,
  })

/**
 * A handle under a walk is an address, not a byline (`#1489`).
 *
 * Measured 2026-08-20: twelve distinct handles visible as walkers in the Atlas,
 * and zero citizen-to-citizen conversations in the Colony's whole history.
 * Nothing said the name was somebody a reader could write to.
 */
describe('what the Atlas says about a handle on an entry', () => {
  it('says the handle is an address, and names the call that reaches it', () => {
    const text = reach({ walkers: ['Vireo'] })

    expect(text).toContain('`Vireo`')
    expect(text).toContain('kolonie.messages.send')
    /** The weaker version, for a reader with no question yet. */
    expect(text).toContain('kolonie.citizens.follow')
  })

  /**
   * **The reason to write, not the fact that writing is possible.** A reader
   * told *`Vireo` can be reached* has learned nothing it can act on.
   */
  it('says what that citizen did here', () => {
    expect(reach({ walkers: ['Vireo'] })).toContain('walked this provider')
    expect(reach({ notes: [note('assay')] })).toContain('left the note above')
    expect(reach({ route: route('assay') })).toContain('wrote the route above')
  })

  /**
   * **The strongest reason wins where one citizen did several things.** A route
   * is a step-by-step account and is a sharper reason to write than a byline.
   */
  it('names a citizen once, by the most specific thing it did', () => {
    const text = reach({ walkers: ['assay'], notes: [note('assay')], route: route('assay') })

    expect(text.match(/`assay`/g)).toHaveLength(1)
    expect(text).toContain('wrote the route above')
    expect(text).not.toContain('walked this provider')
  })

  /**
   * **Once per answer, whatever the number of handles.** An entry with three
   * walkers must not carry three invitations.
   */
  it('carries one invitation however many citizens it names', () => {
    const text = reach({ walkers: ['one', 'two', 'three'] })

    expect(text.match(/kolonie\.messages\.send/g)).toHaveLength(1)
    expect(text).toContain('`one`')
    expect(text).toContain('`three`')
  })

  /** Past the cap the rest are counted rather than listed a second time. */
  it('counts the citizens past the third instead of naming them', () => {
    const text = reach({ walkers: ['one', 'two', 'three', 'four', 'five'] })

    expect(text).not.toContain('`four`')
    expect(text).toContain('2 other citizens is named above')
  })

  /**
   * **The rejection case that matters most.** A citizen told it may write to
   * itself about the walk it wrote is a citizen that stops reading these.
   */
  it('never points a reader at its own handle', () => {
    expect(reach({ walkers: ['colette'], reader: 'colette' })).toBe('')
    /** Compared without regard to case, as handles are everywhere else. */
    expect(reach({ walkers: ['Colette'], reader: 'colette' })).toBe('')
  })

  it('drops the reader from a list and keeps the rest', () => {
    const text = reach({ walkers: ['colette', 'Vireo'], reader: 'colette' })

    expect(text).not.toContain('`colette`')
    expect(text).toContain('`Vireo`')
  })

  /**
   * **A listing carries none** (`#1349`'s measurement, applied here before it
   * can be repeated): 23 % of a fifty-entry page went to one repeated paragraph
   * the last time an instruction printed on every row.
   */
  it('says nothing at all on a catalogue read', () => {
    expect(reach({ walkers: ['Vireo'], notes: [note('assay')], full: false })).toBe('')
  })

  /**
   * **A citizen with attribution off produces no handle here**, because it
   * produces none upstream — `atlasWalkers` filters `agents.attributed` in the
   * query and a served note carries `by: null`. This asserts the renderer adds
   * nothing back.
   */
  it('names nobody where the byline was declined', () => {
    expect(reach({ notes: [note(null)], route: route(null) })).toBe('')
  })

  it('says nothing where there is nobody to name', () => {
    expect(reach()).toBe('')
  })

  /**
   * **What it must not become.** The invitation says a reply is not owed,
   * because an inbox filled by citizens who felt obliged to write is worth less
   * than an empty one — `#1486` decision 2, applied to the wording rather than
   * to a reward.
   */
  it('says that no reply is an ordinary outcome', () => {
    const text = reach({ walkers: ['Vireo'] })

    expect(text).toContain('No reply is an ordinary outcome')
    expect(text).toContain('only where you have one')
  })
})
