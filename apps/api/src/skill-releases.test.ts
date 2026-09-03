import { describe, expect, it } from 'vitest'
import {
  AgentPlatformSchema,
  SkillReleasesSchema,
  isSkillVersionBehind,
  type Agent,
} from '@kolonie-ai/core'
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
      os: null,
      skillVersion,
      bio: null,
      avatarUrl: null,
      declaredRhythmMinutes: null,
      vocation: null,
      disposition: null,
      goal: null,
      availability: null,
      profession: null,
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
    // `other` used to be deliberately absent, on the reasoning that it named a
    // runtime the Colony had no entry point for and there was therefore nothing
    // to be behind. `kolonie-skill` was created on 2026-08-03
    // (`kolonie-docs#135`) and is exactly that entry point, so the premise is
    // gone and `other` carries a release like any other value.
    expect(Object.keys(DEFAULT_SKILL_RELEASES).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'hermes',
      'kilo',
      'openclaw',
      'other',
    ])
    expect(DEFAULT_SKILL_RELEASES.other?.url).toContain('kolonie-skill')
  })

  it('describes releases the schema would accept, which nothing else checks', () => {
    // `DEFAULT_SKILL_RELEASES` is a typed literal and `skillReleasesFromEnv`
    // only parses the *environment*, so nothing validated the table in code
    // (`#974`). `note` is bounded at 280 characters because it is read inside
    // every citizen's wake-up, and a bound the compiler cannot see is a bound
    // that holds until somebody writes a paragraph.
    expect(() => SkillReleasesSchema.parse(DEFAULT_SKILL_RELEASES)).not.toThrow()
  })

  it('carries a version the notice can actually be behind', () => {
    // The half of `#974` that needs no network. `isSkillVersionBehind` refuses
    // to order anything that is not dot-separated numbers and answers `false`
    // rather than guessing — so an entry reading `nightly` or `2026-08-15` is an
    // entry whose notice can never fire, and a citizen on that runtime is told
    // nothing however far behind it falls. From outside, that is
    // indistinguishable from every citizen being current, which is the shape the
    // whole issue is about.
    //
    // Whether each version is the *published* one is the other half, and it
    // cannot be asked here: it reads seven repositories over the network.
    // `scripts/check-skill-versions.sh` asks it daily.
    for (const [platform, release] of Object.entries(DEFAULT_SKILL_RELEASES)) {
      expect(isSkillVersionBehind('0.0.1', release.version), platform).toBe(true)
    }
  })

  it('names every platform the schema accepts, or leaves a gap on purpose', () => {
    // The table is a partial record, so a missing runtime is silent rather than
    // an error — which is correct and is also how a runtime that gains a skill
    // stays untold. This asserts the gap is empty today, so that adding a
    // platform value without a release has to be a decision somebody takes here.
    const covered = new Set(Object.keys(DEFAULT_SKILL_RELEASES))
    const missing = AgentPlatformSchema.options.filter((platform) => !covered.has(platform))
    expect(missing).toEqual([])
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
