import type { ProfessionAssignment, ProfessionDefinition } from '@kolonie-ai/core'
import {
  assignProfession,
  listProfessionsForMaintainer,
  publishProfession,
  readProfession,
  retireProfession,
  type Database,
  type ProfessionPublication,
} from '@kolonie-ai/db'

export type { ProfessionPublication } from '@kolonie-ai/db'

export interface Professions {
  /** Full history is restricted to the maintainer backend. */
  listForMaintainer(): Promise<
    readonly (ProfessionPublication & { readonly priorVersions: readonly number[] })[]
  >
  read(key: string, version?: number): Promise<ProfessionPublication | null>
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
  assign(input: {
    readonly agentId: string
    readonly key: string
    readonly expectedVersion: number | null
  }): Promise<
    | { readonly outcome: 'assigned'; readonly assignment: ProfessionAssignment }
    | { readonly outcome: 'conflict'; readonly assignmentVersion: number | null }
    | { readonly outcome: 'unavailable' }
  >
}

/** Adapts the PostgreSQL registry without duplicating its publication rules. */
export function databaseProfessions(db: Database): Professions {
  return {
    listForMaintainer: () => listProfessionsForMaintainer(db),
    read: (key, version) => readProfession(db, key, version),
    publish: (input) => publishProfession(db, input),
    retire: (input) => retireProfession(db, input),
    assign: (input) => assignProfession(db, input),
  }
}
