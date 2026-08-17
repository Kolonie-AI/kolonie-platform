import { describe, expect, it } from 'vitest'
import { AgentPlatformSchema } from '@kolonie-ai/core'
import { atlasRuntimeLine, atlasRuntimeNames } from './runtimes.js'
import { DEFAULT_SKILL_RELEASES } from '../skill-releases.js'

describe('the runtime line on an Atlas page', () => {
  /**
   * The measurement in `kolonie-website#110`: zero occurrences of either name
   * on `/atlas`, on a shelf and on a provider page. This is the floor under
   * that, and it is asserted on the two runtimes the issue named.
   */
  it('names the runtimes the Colony ships a skill for', () => {
    expect(atlasRuntimeNames()).toContain('OpenClaw')
    expect(atlasRuntimeNames()).toContain('Hermes')
    expect(atlasRuntimeLine()).toContain('OpenClaw')
  })

  /**
   * **The guard that makes the sentence maintain itself.** `AgentPlatform` is
   * exhaustive by type, so a new runtime cannot be missed from the name table —
   * but it could be added with `null` beside a skill the Colony does ship, and
   * that failure is invisible: the page still reads as a complete list.
   */
  it('has a name for every runtime the release table carries', () => {
    const shipped = AgentPlatformSchema.options.filter(
      (platform) => platform !== 'other' && DEFAULT_SKILL_RELEASES[platform] !== undefined,
    )

    expect(atlasRuntimeNames()).toHaveLength(shipped.length)
  })

  /**
   * `other` is the runtime with no name of its own. Naming it would put *other*
   * in a list of products, which is a sentence that helps nobody searching.
   */
  it('leaves the unnamed runtime out of the sentence', () => {
    expect(atlasRuntimeLine()).not.toContain('other,')
    expect(atlasRuntimeNames({ other: DEFAULT_SKILL_RELEASES.other })).toEqual([])
  })

  /**
   * A runtime is named only where a skill for it exists, which is what keeps the
   * sentence from claiming one the Colony does not ship.
   */
  it('names nothing when the Colony ships nothing', () => {
    expect(atlasRuntimeNames({})).toEqual([])
    expect(atlasRuntimeLine([])).toBe('')
  })

  /** A list is read as a sentence, so the last two are joined with a word. */
  it('lists the runtimes in the enum’s own order, which is arrival and not rank', () => {
    const line = atlasRuntimeLine(['OpenClaw', 'Hermes', 'Kilo'])

    expect(line).toContain('skill for OpenClaw, Hermes and Kilo,')
  })

  /**
   * The half that costs something to write. Naming runtimes invites *this
   * provider works on Hermes and not on Kilo*, which no page here has the
   * evidence for — so the line says what silence means before a reader guesses.
   */
  it('says what a runtime’s absence from a provider page means', () => {
    expect(atlasRuntimeLine()).toContain('reported none')
  })
})
