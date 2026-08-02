import { describe, expect, it } from 'vitest'
import type { Agent } from '@kolonie-ai/core'
import { skillVersionNotice } from './mcp/text/me.js'
import {
  DEFAULT_SKILL_RELEASES,
  skillReleasesFromEnv,
  SKILL_RELEASES_VAR,
} from './skill-releases.js'

const RELEASES = {
  claude: {
    version: '1.2.0',
    note: 'The recommended wake-up allowlist admits no shell.',
    url: 'https://github.com/Kolonie-AI/kolonie-claude',
  },
} as const

function agentOn(platform: Agent['profile']['platform'], skillVersion: string | null): Agent {
  return {
    id: '00000000-0000-4000-8000-000000000000' as Agent['id'],
    profile: {
      name: 'canary',
      platform,
      operator: null,
      capabilities: [],
      pronouns: null,
      model: null,
      runtimeVersion: null,
      skillVersion,
      bio: null,
      avatarUrl: null,
      declaredRhythmHours: null,
    },
    status: 'citizen',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  }
}

describe('skillReleasesFromEnv', () => {
  it('falls back to the table in code when nothing is configured', () => {
    expect(skillReleasesFromEnv({})).toEqual(DEFAULT_SKILL_RELEASES)
    expect(skillReleasesFromEnv({ [SKILL_RELEASES_VAR]: '   ' })).toEqual(DEFAULT_SKILL_RELEASES)
  })

  it('reads a table from the environment, so publishing costs no release', () => {
    const parsed = skillReleasesFromEnv({ [SKILL_RELEASES_VAR]: JSON.stringify(RELEASES) })
    expect(parsed.claude?.version).toBe('1.2.0')
  })

  it('throws at startup on malformed JSON rather than telling every citizen nothing', () => {
    expect(() => skillReleasesFromEnv({ [SKILL_RELEASES_VAR]: '{oops' })).toThrow(
      SKILL_RELEASES_VAR,
    )
  })

  it('throws when the table does not describe releases', () => {
    expect(() =>
      skillReleasesFromEnv({ [SKILL_RELEASES_VAR]: JSON.stringify({ claude: { version: '1' } }) }),
    ).toThrow(SKILL_RELEASES_VAR)
  })

  it('ships a release for every runtime that has a skill repository', () => {
    // `other` is deliberately absent: it is the value for a runtime the Colony
    // has no entry point for, so there is nothing to be behind.
    expect(Object.keys(DEFAULT_SKILL_RELEASES).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'hermes',
      'kilo',
      'openclaw',
    ])
    expect(DEFAULT_SKILL_RELEASES.other).toBeUndefined()
  })
})

describe('skillVersionNotice', () => {
  it('says nothing to a citizen running the current version', () => {
    expect(skillVersionNotice(agentOn('claude', '1.2.0'), RELEASES)).toBe('')
  })

  it('tells a citizen running an older version, once, with what changed and where', () => {
    const notice = skillVersionNotice(agentOn('claude', '1.1.0'), RELEASES)
    expect(notice).toContain('1.1.0')
    expect(notice).toContain('1.2.0')
    expect(notice).toContain('admits no shell')
    expect(notice).toContain('https://github.com/Kolonie-AI/kolonie-claude')
  })

  it('never instructs the skill to update itself', () => {
    const notice = skillVersionNotice(agentOn('claude', '1.1.0'), RELEASES)
    expect(notice).toContain('yours to decide')
    expect(notice.toLowerCase()).not.toContain('automatically')
  })

  it('says nothing to a citizen that has declared no version', () => {
    expect(skillVersionNotice(agentOn('claude', null), RELEASES)).toBe('')
  })

  it('says nothing for a runtime with no release on file, and does not throw', () => {
    // The case that would otherwise 500 a call every citizen makes on every
    // wake-up: a platform value the Colony accepts and has no skill for.
    expect(skillVersionNotice(agentOn('other', '1.0.0'), RELEASES)).toBe('')
    expect(skillVersionNotice(agentOn('kilo', '1.0.0'), RELEASES)).toBe('')
  })

  it('says nothing when the declared version cannot be ordered against the current one', () => {
    expect(skillVersionNotice(agentOn('claude', 'nightly'), RELEASES)).toBe('')
  })
})
