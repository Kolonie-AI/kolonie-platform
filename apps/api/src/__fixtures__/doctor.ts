import type { AcademyProgress, AgentId, CallHour } from '@kolonie-ai/core'
import type { DoctorSource } from '../doctor.js'

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
): DoctorSource {
  return {
    callHoursSince: async (agentId: AgentId, since: Date) =>
      (rows[agentId] ?? []).filter((hour) => Date.parse(hour.hourStartedAt) >= since.getTime()),
    progressOf: async (agentId: AgentId) => progress[agentId] ?? EMPTY_PROGRESS,
    deprecatedRoutes: async () => deprecated,
    proseFor: async (agentId: AgentId) => prose[agentId] ?? {},
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
