import type { AgentId, SkillNoteEntry } from '@kolonie-ai/core'
import type { SkillNotes } from '../skills.js'

export interface FakeSkillNotes extends SkillNotes {
  /** Give a citizen a skill, which is `packages/db`'s job in the real one. */
  readonly grant: (agentId: AgentId, skill: string) => void
}

/**
 * Notes against skills, in memory (`#348`).
 *
 * **It keeps the held set as well as the notes**, unlike most fixtures here,
 * because the one refusal this surface has is *you do not hold that* — a fake
 * that always answered *held* would let the refusal path pass untested, and one
 * that always answered *not held* would let nothing else be tested at all.
 */
export function fakeSkillNotes(): FakeSkillNotes {
  const notes = new Map<string, SkillNoteEntry>()
  const held = new Set<string>()
  const key = (agentId: AgentId, skill: string) => `${agentId} ${skill}`

  return {
    grant(agentId, skill) {
      held.add(key(agentId, skill))
    },
    async holds(agentId, skill) {
      return held.has(key(agentId, skill))
    },
    async write(agentId, skill, note, expectedVersion) {
      const current = notes.get(key(agentId, skill))
      if (expectedVersion !== undefined && current?.version !== expectedVersion) {
        return { outcome: 'stale' }
      }
      const previousCharacters = current?.note.length ?? 0
      if (note === null) {
        notes.delete(key(agentId, skill))
        return { outcome: 'written', entry: null, previousCharacters }
      }
      const entry: SkillNoteEntry = {
        skill: skill as SkillNoteEntry['skill'],
        note,
        writtenAt: '2026-08-05T09:00:00.000Z',
        version: (current?.version ?? 0) + 1,
      }
      notes.set(key(agentId, skill), entry)
      return { outcome: 'written', entry, previousCharacters }
    },
    async read(agentId, skill) {
      return notes.get(key(agentId, skill)) ?? null
    },
    async readMany(agentId, skills) {
      return skills
        .map((skill) => notes.get(key(agentId, skill)))
        .filter((entry): entry is SkillNoteEntry => entry !== undefined)
    },
  }
}
