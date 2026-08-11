import { describe, expect, it } from 'vitest'
import { REVISION_VAR, buildRevision } from './revision.js'

describe('which build is running', () => {
  it('reads the commit the image was built from', () => {
    expect(buildRevision({ [REVISION_VAR]: 'a1b2c3d4e5f6' })).toBe('a1b2c3d4e5f6')
    expect(buildRevision({ [REVISION_VAR]: '61d2fd3a' })).toBe('61d2fd3a')
  })

  it('trims what a shell put whitespace around', () => {
    expect(buildRevision({ [REVISION_VAR]: '  a1b2c3d  \n' })).toBe('a1b2c3d')
  })

  /**
   * The rejection cases, and the reason there are several: an unset build arg
   * reaches a container as the empty string, a `${...}` that never expanded
   * reaches it as literal braces, and a well-meaning deployment might write a
   * word. **None of those is a revision**, and recording one as though it were
   * would make the field it exists to settle unfalsifiable again — which is the
   * failure `#715` is about.
   */
  it('answers nothing for anything that is not a commit', () => {
    for (const value of [
      '',
      '   ',
      '${GITHUB_SHA}',
      'unknown',
      'latest',
      'main',
      'abc',
      'zzzzzzz',
    ]) {
      expect(buildRevision({ [REVISION_VAR]: value }), value).toBeNull()
    }
  })

  it('answers nothing when the variable is absent altogether', () => {
    expect(buildRevision({})).toBeNull()
  })
})
