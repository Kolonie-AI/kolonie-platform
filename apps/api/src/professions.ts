import type {
  Log,
  ProfessionAssignment,
  ProfessionCatalogueSummary,
  ProfessionDefinition,
  ProfessionStanding,
} from '@kolonie-ai/core'
import {
  assignProfession,
  listActiveProfessions,
  listProfessionsForMaintainer,
  publishProfession,
  readProfession,
  professionStanding,
  resolveProfessionStanding,
  retireProfession,
  type Database,
  type ProfessionPublication,
} from '@kolonie-ai/db'

export type { ProfessionPublication } from '@kolonie-ai/db'

export interface Professions {
  /** Compact active catalogue for agents; full constitutions remain keyed reads. */
  listActive(): Promise<readonly ProfessionCatalogueSummary[]>
  /** Full history is restricted to the maintainer backend. */
  listForMaintainer(): Promise<
    readonly (ProfessionPublication & { readonly priorVersions: readonly number[] })[]
  >
  read(key: string, version?: number): Promise<ProfessionPublication | null>
  standing(agentId: string): Promise<
    | {
        readonly outcome: 'assigned'
        readonly standing: Extract<ProfessionStanding, { state: 'assigned' }>
      }
    | { readonly outcome: 'unassigned' }
    | { readonly outcome: 'unavailable'; readonly key: string }
  >
  resolveStanding(
    agentId: string,
    options: { readonly actionable: boolean; readonly log?: Log },
  ): Promise<ProfessionStanding>
  publish(input: {
    readonly expectedVersion: number | null
    readonly definition: ProfessionDefinition
    readonly publisherId: string
  }): Promise<
    | ({ readonly outcome: 'published' } & ProfessionPublication)
    | { readonly outcome: 'conflict'; readonly currentVersion: number | null }
    | { readonly outcome: 'invalid-version' | 'invalid-transition' }
  >
  retire(input: {
    readonly key: string
    readonly expectedVersion: number
  }): Promise<
    | { readonly outcome: 'retired'; readonly profession: ProfessionPublication['profession'] }
    | { readonly outcome: 'conflict'; readonly currentVersion: number | null }
    | { readonly outcome: 'invalid-transition' }
  >
  /** Writes one assignment through the catalogue's concurrency boundary. */
  assign(input: {
    readonly agentId: string
    readonly key: string
    readonly expectedVersion: number | null
  }): Promise<
    | {
        readonly outcome: 'assigned'
        readonly assignment: ProfessionAssignment
        readonly definition: ProfessionDefinition
        readonly lifecycle: 'active' | 'retired'
      }
    | { readonly outcome: 'conflict'; readonly assignmentVersion: number | null }
    | { readonly outcome: 'unavailable'; readonly reason: 'not-found' | 'inactive' }
  >
}

/** Adapts the PostgreSQL registry without duplicating its publication rules. */
export function databaseProfessions(db: Database): Professions {
  return {
    listActive: () => listActiveProfessions(db),
    listForMaintainer: () => listProfessionsForMaintainer(db),
    read: (key, version) => readProfession(db, key, version),
    standing: (agentId) => resolveProfessionStanding(db, agentId),
    resolveStanding: (agentId, options) => professionStanding(db, agentId, options),
    publish: (input) => publishProfession(db, input),
    retire: (input) => retireProfession(db, input),
    assign: (input) => assignProfession(db, input),
  }
}
