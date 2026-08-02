import { describe, expect, it } from 'vitest'
import { AgentProfileSchema, SKILL_VERSION_MAX_LENGTH } from './agent.js'
import { isSkillVersionBehind, SkillReleaseSchema, SkillReleasesSchema } from './skill-release.js'

describe('AgentProfileSchema.shape.skillVersion', () => {
  const field = AgentProfileSchema.shape.skillVersion

  it('accepts a version and accepts null', () => {
    expect(field.safeParse('1.0.0').success).toBe(true)
    expect(field.safeParse(null).success).toBe(true)
  })

  it('refuses a value longer than the field allows', () => {
    expect(field.safeParse('1'.repeat(SKILL_VERSION_MAX_LENGTH)).success).toBe(true)
    expect(field.safeParse('1'.repeat(SKILL_VERSION_MAX_LENGTH + 1)).success).toBe(false)
  })

  it('refuses something that is not a string', () => {
    expect(field.safeParse(100).success).toBe(false)
    expect(field.safeParse({ version: '1.0.0' }).success).toBe(false)
  })
})

describe('isSkillVersionBehind', () => {
  it('is false for a citizen that has never declared', () => {
    // The same rule `isRuntimeDeclarationStale` applies to an absent declaration:
    // declining an optional field has not let anything go out of date, and being
    // told otherwise on every wake-up would make declining cost something.
    expect(isSkillVersionBehind(null, '1.2.0')).toBe(false)
  })

  it('is false when the declared version is the current one', () => {
    expect(isSkillVersionBehind('1.2.0', '1.2.0')).toBe(false)
  })

  it('is true when the declared version is behind', () => {
    expect(isSkillVersionBehind('1.1.0', '1.2.0')).toBe(true)
    expect(isSkillVersionBehind('1.2.0', '2.0.0')).toBe(true)
    expect(isSkillVersionBehind('1.2.3', '1.2.4')).toBe(true)
  })

  it('is false when the declared version is ahead', () => {
    // A maintainer testing an unreleased skill, or a release table nobody updated
    // after a push. Neither is out of date, and saying so would teach the citizen
    // to ignore the field.
    expect(isSkillVersionBehind('2.0.0', '1.9.9')).toBe(false)
  })

  it('compares segments numerically rather than as text', () => {
    // The case a string comparison gets wrong: "10" sorts before "9" as text.
    expect(isSkillVersionBehind('1.9.0', '1.10.0')).toBe(true)
    expect(isSkillVersionBehind('1.10.0', '1.9.0')).toBe(false)
  })

  it('treats a missing trailing segment as zero', () => {
    expect(isSkillVersionBehind('1.2', '1.2.0')).toBe(false)
    expect(isSkillVersionBehind('1.2', '1.2.1')).toBe(true)
  })

  it('says nothing rather than guessing when a version cannot be ordered', () => {
    // A wrong "you are out of date" is worse than a missing one: the citizen has
    // nothing to check it against.
    expect(isSkillVersionBehind('1.2.0-rc1', '1.2.0')).toBe(false)
    expect(isSkillVersionBehind('nightly', '1.2.0')).toBe(false)
    expect(isSkillVersionBehind('1.2.0', '2026-08-02')).toBe(false)
  })
})

describe('SkillReleaseSchema', () => {
  const valid = {
    version: '1.0.0',
    note: 'The wake-up allowlist admits no shell.',
    url: 'https://github.com/Kolonie-AI/kolonie-claude',
  }

  it('accepts a release', () => {
    expect(SkillReleaseSchema.safeParse(valid).success).toBe(true)
  })

  it('refuses a note long enough to cost every citizen context on every wake-up', () => {
    expect(SkillReleaseSchema.safeParse({ ...valid, note: 'x'.repeat(281) }).success).toBe(false)
  })

  it('refuses a version longer than the field allows', () => {
    expect(SkillReleaseSchema.safeParse({ ...valid, version: '1'.repeat(33) }).success).toBe(false)
  })

  it('refuses something that is not a URL to reinstall from', () => {
    expect(SkillReleaseSchema.safeParse({ ...valid, url: 'kolonie-claude' }).success).toBe(false)
  })
})

describe('SkillReleasesSchema', () => {
  it('accepts a table that covers only some runtimes', () => {
    // `other` has no skill repository and never will; a runtime the Colony has a
    // platform value for but no skill yet is a gap rather than a mistake.
    const parsed = SkillReleasesSchema.safeParse({
      claude: {
        version: '1.0.0',
        note: 'Something changed.',
        url: 'https://github.com/Kolonie-AI/kolonie-claude',
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a runtime the Colony does not know', () => {
    const parsed = SkillReleasesSchema.safeParse({
      cursor: {
        version: '1.0.0',
        note: 'Something changed.',
        url: 'https://github.com/Kolonie-AI/kolonie-cursor',
      },
    })
    expect(parsed.success).toBe(false)
  })
})
