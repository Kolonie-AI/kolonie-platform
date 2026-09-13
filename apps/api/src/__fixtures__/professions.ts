import { ProfessionDefinitionSchema } from '@kolonie-ai/core'
import type { Professions, ProfessionPublication } from '../professions.js'

/**
 * The registry as rows, over the port production is wired to (`#1935`).
 *
 * It stores definitions and assignments rather than reimplementing the
 * publication rule: the concurrency and gap-free arguments live in
 * `packages/db/src/storage/professions.ts` and are asserted against PostgreSQL
 * there. A route test only needs a surface that answers.
 */
export const fakeProfessions = (): Professions => {
  const versions = new Map<string, Map<number, ProfessionPublication>>()
  const assignments = new Map<
    string,
    { key: string; chosenAt: string; assignmentVersion: number }
  >()
  const retired = new Set<string>()

  const current = (key: string): ProfessionPublication | null => {
    const held = versions.get(key)
    if (held === undefined) return null
    const highest = [...held.keys()].sort((left, right) => right - left)[0]
    return highest === undefined ? null : (held.get(highest) ?? null)
  }

  return {
    listActive: async () =>
      [...versions.keys()].sort().flatMap((key) => {
        const held = current(key)
        if (held === null || retired.has(key)) return []
        return [
          {
            key: held.definition.key,
            title: held.definition.title,
            summary: held.definition.summary,
            version: held.definition.version,
          },
        ]
      }),
    listForMaintainer: async () =>
      [...versions.keys()].sort().flatMap((key) => {
        const held = current(key)
        if (held === null) return []
        const priorVersions = [...(versions.get(key)?.keys() ?? [])].sort(
          (left, right) => left - right,
        )
        return [
          {
            ...held,
            profession: {
              ...held.profession,
              lifecycle: retired.has(key) ? ('retired' as const) : ('active' as const),
              retiredAt: retired.has(key) ? held.profession.publishedAt : null,
            },
            priorVersions,
          },
        ]
      }),
    read: async (key, version) => {
      const held = versions.get(key)
      if (held === undefined) return null
      const found = version === undefined ? current(key) : (held.get(version) ?? null)
      if (found === null || !retired.has(key)) return found
      return {
        ...found,
        profession: {
          ...found.profession,
          lifecycle: 'retired' as const,
          retiredAt: found.profession.retiredAt ?? found.profession.publishedAt,
        },
      }
    },
    standing: async (agentId) => {
      const assignment = assignments.get(agentId)
      if (assignment === undefined) return { outcome: 'unassigned' as const }
      const found = current(assignment.key)
      if (found === null) {
        return {
          outcome: 'unavailable' as const,
          key: assignment.key,
        }
      }
      return {
        outcome: 'assigned' as const,
        standing: {
          state: 'assigned' as const,
          assignmentVersion: assignment.assignmentVersion,
          definition: found.definition,
          source: 'colony' as const,
        },
      }
    },
    resolveStanding: async (agentId, options) => {
      const assignment = assignments.get(agentId)
      if (assignment === undefined) {
        return {
          state: 'unassigned' as const,
          ...(options.actionable
            ? { next: { tool: 'kolonie.profession' as const, arguments: { act: 'list' as const } } }
            : {}),
        }
      }
      const found = current(assignment.key)
      if (found === null) {
        options.log?.error(
          'Could not resolve the assigned profession.',
          new Error('profession standing unavailable'),
          {
            event: 'profession.standing.failed',
            agentId,
            professionKey: assignment.key,
          },
        )
        return {
          state: 'unavailable' as const,
          key: assignment.key,
          next: {
            tool: 'kolonie.support.open' as const,
            arguments: {
              kind: 'defect' as const,
              route: 'colony' as const,
              subject: 'Profession definition unavailable' as const,
              body: 'My assigned profession could not be resolved during wakeup.' as const,
            },
          },
        }
      }
      return {
        state: 'assigned' as const,
        assignmentVersion: assignment.assignmentVersion,
        definition: found.definition,
        source: 'colony' as const,
      }
    },
    publish: async ({ expectedVersion, definition, publisherId }) => {
      const parsed = ProfessionDefinitionSchema.parse(definition)
      const held = versions.get(parsed.key)
      const now = (held?.size ?? 0) + 1
      if ((expectedVersion ?? 0) + 1 !== parsed.version) {
        return held === undefined
          ? { outcome: 'invalid-version' as const }
          : { outcome: 'conflict' as const, currentVersion: now - 1 }
      }
      if (retired.has(parsed.key)) return { outcome: 'invalid-transition' as const }
      const publication: ProfessionPublication = {
        profession: {
          key: parsed.key,
          lifecycle: 'active',
          currentVersion: parsed.version,
          publishedAt: new Date().toISOString(),
          retiredAt: null,
        },
        definition: parsed,
        publication: {
          publishedAt: new Date().toISOString(),
          publishedByHumanId: publisherId,
        },
      }
      const stored = held ?? new Map<number, ProfessionPublication>()
      stored.set(parsed.version, publication)
      versions.set(parsed.key, stored)
      return { outcome: 'published' as const, ...publication }
    },
    retire: async ({ key, expectedVersion }) => {
      const found = current(key)
      if (found === null || found.profession.currentVersion !== expectedVersion) {
        return {
          outcome: 'conflict' as const,
          currentVersion: found?.profession.currentVersion ?? null,
        }
      }
      if (retired.has(key)) return { outcome: 'invalid-transition' as const }
      retired.add(key)
      return {
        outcome: 'retired' as const,
        profession: {
          ...found.profession,
          lifecycle: 'retired' as const,
          retiredAt: new Date().toISOString(),
        },
      }
    },
    assign: async ({ agentId, key, expectedVersion }) => {
      const held = assignments.get(agentId)
      if ((held?.assignmentVersion ?? null) !== expectedVersion) {
        return { outcome: 'conflict' as const, assignmentVersion: held?.assignmentVersion ?? null }
      }
      if (held?.key === key) {
        const found = current(key)
        if (found === null) throw new Error('assigned profession is missing')
        return {
          outcome: 'assigned' as const,
          assignment: {
            key,
            chosenAt: held.chosenAt,
            assignmentVersion: held.assignmentVersion,
          },
          definition: found.definition,
          lifecycle: retired.has(key) ? ('retired' as const) : ('active' as const),
        }
      }
      const found = current(key)
      if (found === null) return { outcome: 'unavailable' as const, reason: 'not-found' as const }
      if (retired.has(key)) {
        return { outcome: 'unavailable' as const, reason: 'inactive' as const }
      }
      const assignmentVersion = (held?.assignmentVersion ?? 0) + 1
      const chosenAt = new Date().toISOString()
      assignments.set(agentId, { key, chosenAt, assignmentVersion })
      return {
        outcome: 'assigned' as const,
        assignment: { key, chosenAt, assignmentVersion },
        definition: found.definition,
        lifecycle: 'active' as const,
      }
    },
  }
}
