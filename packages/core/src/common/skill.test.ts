import { describe, expect, it } from 'vitest'
import {
  isKnownSkill,
  KNOWN_SKILLS,
  mayAttempt,
  missingSkills,
  skill,
  SkillSchema,
  type Skill,
} from './skill.js'

const held = (...skills: string[]): readonly Skill[] => skills.map(skill)

describe('SkillSchema', () => {
  it('accepts kebab-case slugs, the way TaskType does', () => {
    expect(SkillSchema.parse('profile')).toBe('profile')
    expect(SkillSchema.parse('task-author')).toBe('task-author')
  })

  it('rejects anything that would be two names for one capability', () => {
    for (const invalid of ['Profile', 'task_author', 'task--author', '-profile', 'profile-']) {
      expect(SkillSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('knows every skill D-030 names, and nothing else', () => {
    for (const known of KNOWN_SKILLS) expect(isKnownSkill(known)).toBe(true)
    expect(isKnownSkill('browsing')).toBe(false)
  })
})

describe('missingSkills', () => {
  it('names what the agent lacks, in the task’s own order', () => {
    const gate = { requires: held('profile', 'browser'), minReputation: 0 }
    expect(missingSkills(held('browser'), gate)).toEqual(['profile'])
    expect(missingSkills(held(), gate)).toEqual(['profile', 'browser'])
    expect(missingSkills(held('profile', 'browser', 'github'), gate)).toEqual([])
  })
})

describe('mayAttempt', () => {
  it('opens a task once every required skill is held', () => {
    const gate = { requires: held('profile'), minReputation: 0 }
    expect(mayAttempt({ skills: held('profile'), reputation: 0 }, gate)).toBe(true)
    expect(mayAttempt({ skills: held(), reputation: 0 }, gate)).toBe(false)
  })

  it('has no ordering and no ceiling — a graph has neither', () => {
    // The rejection case the ladder could not express: an agent holding the
    // skill for a "later" task and not the one for an "earlier" one may take
    // the later task and not the earlier.
    const early = { requires: held('browser'), minReputation: 0 }
    const late = { requires: held('keypair'), minReputation: 0 }
    const holder = { skills: held('keypair'), reputation: 0 }

    expect(mayAttempt(holder, early)).toBe(false)
    expect(mayAttempt(holder, late)).toBe(true)
  })

  it('refuses a task under its reputation floor even when every skill is held', () => {
    const review = { requires: held('profile'), minReputation: 10 }
    expect(mayAttempt({ skills: held('profile'), reputation: 9 }, review)).toBe(false)
    expect(mayAttempt({ skills: held('profile'), reputation: 10 }, review)).toBe(true)
  })

  it('opens a task that requires nothing to an agent holding nothing', () => {
    // `profile-complete` is the root of the graph, and an arriving agent has to
    // be able to take it on its first call.
    expect(mayAttempt({ skills: held(), reputation: 0 }, { requires: [], minReputation: 0 })).toBe(
      true,
    )
  })
})
