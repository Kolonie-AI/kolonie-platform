import { describe, expect, it } from 'vitest'
import { registeredTools, toolNamesIn } from './tool-names.js'

/**
 * The parser the parity checks are built on (`#196`, `#244`, `#1322`).
 *
 * **It has been wrong and green twice**, both times for the same reason: a
 * character a real tool name contains that the pattern did not admit, and no
 * Colony-authored text naming such a tool yet. `#244` was the hyphen and
 * `#1322` was the underscore. What follows is the shape of both, asserted
 * against the registry rather than against a list written here — a third
 * character would otherwise be discovered the same way.
 */
describe('reading the tool names out of Colony prose', () => {
  it('reads a plain name, and drops the full stop after it', () => {
    expect(toolNamesIn('Start with kolonie.tasks.list.')).toEqual(['kolonie.tasks.list'])
  })

  /** `#244`: `kolonie.tasks.set-aside` read as `kolonie.tasks.set`. */
  it('reads a hyphenated segment whole', () => {
    expect(toolNamesIn('Put it down with kolonie.tasks.set-aside.')).toEqual([
      'kolonie.tasks.set-aside',
    ])
  })

  /** `#1322`: `kolonie.messages.get_thread` read as `kolonie.messages.get`. */
  it('reads an underscored segment whole', () => {
    expect(toolNamesIn('Read it with kolonie.messages.get_thread.')).toEqual([
      'kolonie.messages.get_thread',
    ])
  })

  it('does not let trailing punctuation extend a name', () => {
    expect(toolNamesIn('kolonie.messages.send- and kolonie.messages.send_')).toEqual([
      'kolonie.messages.send',
      'kolonie.messages.send',
    ])
  })

  /** `#373`: a sister project's domain matches the grammar exactly. */
  it('is not fooled by a sister project domain', () => {
    expect(toolNamesIn('The domain kolonie.sh is excluded.')).toEqual([])
  })

  /**
   * **The property both regressions actually broke.** Every name the surface
   * registers has to survive a round trip through the parser; anything that
   * does not is a name a text can mention and the parity check will call
   * unregistered.
   */
  it('reads every registered tool name back unchanged', () => {
    for (const tool of registeredTools()) {
      expect(toolNamesIn(`Call ${tool}.`), tool).toEqual([tool])
    }
  })
})
