import type { AcademyProgress, AgentId, CallHour, Diagnosis } from '@kolonie-ai/core'
import { DIAGNOSES_PAGE } from '@kolonie-ai/db'
import type { ConsultationFunnel, DoctorFeedbackInput, RuleHealthRow } from '@kolonie-ai/db'
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
  /**
   * Where the verdicts land, for a test that wants to read them back (`#1082`).
   *
   * **Handed over rather than defaulted away**, because unlike the write above
   * it this one is not optional on the seam: a source that could not record a
   * verdict is a state production does not have, so the fixture does not have it
   * either. What a caller may choose is whether it keeps the rows.
   */
  feedback?: DoctorFeedbackInput[],
): DoctorSource {
  const kept = feedback ?? []

  return {
    callHoursSince: async (agentId: AgentId, since: Date) =>
      (rows[agentId] ?? []).filter((hour) => Date.parse(hour.hourStartedAt) >= since.getTime()),
    progressOf: async (agentId: AgentId) => progress[agentId] ?? EMPTY_PROGRESS,
    deprecatedRoutes: async () => deprecated,
    proseFor: async (agentId: AgentId) => prose[agentId] ?? {},
    /**
     * One standing verdict per citizen per rule, which is the table's own shape
     * (`#1082`).
     *
     * Reproduced here rather than appended to, because `replaced` is the one
     * field of the receipt a test can get wrong without noticing: a fixture that
     * always answered `false` would let a broken replacement pass.
     */
    recordFeedback: async (input: DoctorFeedbackInput) => {
      const at = kept.findIndex(
        (held) => held.agentId === input.agentId && held.kind === input.kind,
      )
      if (at === -1) kept.push(input)
      else kept[at] = input

      return {
        kind: input.kind,
        verdict: input.verdict,
        replaced: at !== -1,
        diagnosisId: null,
      }
    },
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
 * **It has six methods and no seventh**, mirroring `DiagnosesDesk`. A fake with a
 * `close` on it would be a fake that could pass a test the production seam
 * cannot — and the fourth (`#1081`), the fifth (`#1083`) and the sixth (`#1080`)
 * are reads like the three before them, so that stays true of it.
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
  /**
   * What each rule has done, where a test cares (`#1083`).
   *
   * Handed over for the same reason the funnel is, and more so: half of every
   * row is what citizens said about the rule, which is a table {@link Diagnosis}
   * has no reference to at all. Deriving it from `rows` would produce a page
   * that renders one source and silently drops the other.
   *
   * The default is *no rule has fired and nobody has said anything*, which is
   * the empty table the page has to render as a sentence.
   */
  ruleHealth: readonly RuleHealthRow[] = [],
  /**
   * Which citizens have a handle, where a test cares (`#1080`).
   *
   * **Handed over rather than derived from `rows`**, and this one carries the
   * rejection case: an id absent from the map is a citizen the Colony can no
   * longer name, which the page has to render as the bare id rather than as a
   * broken link. A fixture that answered a handle for every id it was given
   * could not produce that state at all.
   *
   * The default is *nobody resolves*, so a test that says nothing about handles
   * asserts the unlinked rendering the column had before this existed.
   */
  handles: ReadonlyMap<string, string> = new Map(),
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
    ruleHealth: async () => ruleHealth,
    // Only the ids that were asked for, so a test can tell an over-broad lookup
    // from a correct one by what comes back (`#1080`).
    handles: async (agentIds) =>
      new Map(
        agentIds.flatMap((id) => {
          const handle = handles.get(id)
          return handle === undefined ? [] : [[id, handle] as const]
        }),
      ),
  }
}
