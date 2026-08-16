import type { AcademyProgress, AgentId, CallHour, Diagnosis } from '@kolonie-ai/core'
import { DIAGNOSES_PAGE } from '@kolonie-ai/db'
import type { ConsultationFunnel } from '@kolonie-ai/db'
import type { DoctorSource } from '../doctor.js'
import type { DiagnosesDesk } from '../diagnoses.js'

/**
 * A doctor source that answers from rows held in memory, per citizen (`#837`).
 *
 * **Keyed by citizen on purpose.** The constraint this surface is judged by is
 * that a citizen sees only its own data, and a fake that held one flat list
 * could not tell a passing test from a leaking one — the leak would be
 * invisible because there would be nothing to leak *from*. So the fixture takes
 * rows for two citizens and hands each of them only its own, which is what makes
 * the two-citizen rejection case a real test.
 */
export function fakeDoctorSource(
  rows: Readonly<Record<string, readonly CallHour[]>> = {},
  progress: Readonly<Record<string, AcademyProgress>> = {},
  deprecated: Readonly<Record<string, string>> = {},
  /**
   * The sentences a runner would have written (`#840`).
   *
   * **Empty by default**, which is the ordinary state: a deployment with no
   * gateway writes none, and a finding the runner has not reached yet has none
   * either. The tests that are *about* prose hand over their own.
   */
  prose: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  /**
   * What the one write does, where a test cares (`#1081`).
   *
   * **Absent by default, because absent is a state production supports**: a
   * deployment that wires no writer measures nothing and answers exactly as it
   * did before the column existed, and every test written before this one is
   * that deployment.
   */
  noteConsultation?: (agentId: AgentId, at: Date) => Promise<void>,
): DoctorSource {
  return {
    callHoursSince: async (agentId: AgentId, since: Date) =>
      (rows[agentId] ?? []).filter((hour) => Date.parse(hour.hourStartedAt) >= since.getTime()),
    progressOf: async (agentId: AgentId) => progress[agentId] ?? EMPTY_PROGRESS,
    deprecatedRoutes: async () => deprecated,
    proseFor: async (agentId: AgentId) => prose[agentId] ?? {},
    ...(noteConsultation === undefined ? {} : { noteConsultation }),
  }
}

/**
 * A citizen that registered and has done nothing else.
 *
 * The default rather than a fully-formed record, because it is the state most
 * tests are not about — and because a fixture that quietly gave every citizen a
 * pass would hide `stalled-arrival` from every test that did not ask for it.
 */
export const EMPTY_PROGRESS: AcademyProgress = {
  registeredAt: '2026-08-01T00:00:00.000Z',
  lastProgressAt: null,
  firstPassAt: null,
  skillsHeld: 0,
}

/** Nobody was told, so there is nothing to say about who came back (`#1081`). */
export const NOTHING_ANNOUNCED: ConsultationFunnel = {
  announced: 0,
  consulted: 0,
  medianHoursToConsult: null,
}

/**
 * A diagnoses desk that answers from rows held in memory (`#841`).
 *
 * **Empty by default, and that is a state the page has to render well.** An
 * empty Colony must produce a section saying there is nothing open rather than a
 * blank panel — the `available` lesson from the log seam, applied to a page — so
 * the default fixture is the one that would catch a renderer which only works
 * with rows.
 *
 * **It has four methods and no fifth**, mirroring `DiagnosesDesk`. A fake with a
 * `close` on it would be a fake that could pass a test the production seam
 * cannot — and the fourth, added for `#1081`, is a read like the other three, so
 * that stays true of it.
 */
export function fakeDiagnosesDesk(
  rows: readonly Diagnosis[] = [],
  /**
   * What the funnel counted, where a test cares (`#1081`).
   *
   * **Handed over rather than derived from `rows`**, because the rows are
   * {@link Diagnosis} and a diagnosis does not carry when its citizen looked:
   * the two timestamps the funnel divides live on the database row and stop at
   * the storage seam. A fixture that invented them would be testing arithmetic
   * this file had written rather than arithmetic PostgreSQL had.
   *
   * The default is *nobody was told*, which is the state the page has to render
   * by leaving the sentence out entirely.
   */
  funnel: ConsultationFunnel = NOTHING_ANNOUNCED,
): DiagnosesDesk {
  return {
    list: async (query) => {
      const matching = rows.filter(
        (row) =>
          (query.scope === undefined || row.scope === query.scope) &&
          (query.states ?? ['open']).includes(row.state),
      )
      const offset = query.offset ?? 0
      const limit = query.limit ?? DIAGNOSES_PAGE

      return {
        rows: matching.slice(offset, offset + limit),
        more: matching.length > offset + limit,
      }
    },
    byId: async (id) => rows.find((row) => row.id === id) ?? null,
    counts: async () =>
      rows.reduce<Record<string, number>>(
        (counts, row) => ({
          ...counts,
          [`${row.scope}.${row.state}`]: (counts[`${row.scope}.${row.state}`] ?? 0) + 1,
        }),
        {},
      ),
    funnel: async () => funnel,
  }
}
