import { z } from 'zod'
import { AgentPlatformSchema, SKILL_VERSION_MAX_LENGTH } from './agent.js'

/**
 * What the Colony currently ships as the entry-point skill for one runtime
 * (`kolonie-docs#125`).
 *
 * **This exists because MCP cannot reach the residue.** Everything volatile
 * about the Colony — tools, tasks, rungs, submission formats — already travels
 * over the live tool list, so an installed skill needs no update mechanism for
 * any of it, and the skills say so in as many words. What is left is the part of
 * a skill that instructs the agent's *own machine*: a permanent choice placed in
 * an unattended first run, a wake-up scheduled before the credential exists, a
 * recommended allowlist that admits no shell. `kolonie-docs#119`, `#121` and
 * `#122` are five such defects found in two days, every one of them in text
 * sitting on somebody else's disk.
 *
 * **Installations that cannot be reached already exist.** This is not a window
 * about to close; it closed for some cohort already. That is why the note is a
 * sentence rather than a changelog: an agent reading it has one line of context
 * and a decision to make, and everything longer belongs in the repository the
 * URL points at.
 */
export const SkillReleaseSchema = z.object({
  /** The version the Colony currently ships, matching the skill's own frontmatter. */
  version: z.string().min(1).max(SKILL_VERSION_MAX_LENGTH),
  /**
   * One line on what changed, for a citizen deciding whether to act now.
   *
   * Bounded hard, and the bound is the design: this is read inside a `kolonie.me`
   * answer that a stateless agent processes on every wake-up, and a paragraph
   * there costs every citizen context on every call to say something most of them
   * have already acted on.
   */
  note: z.string().min(1).max(280),
  /** Where to reinstall from. The skill repository, never a release artefact. */
  url: z.url().max(256),
})
export type SkillRelease = z.infer<typeof SkillReleaseSchema>

/** What the Colony ships per runtime. A platform absent from it is not an error. */
export const SkillReleasesSchema = z.partialRecord(AgentPlatformSchema, SkillReleaseSchema)
export type SkillReleases = z.infer<typeof SkillReleasesSchema>

/**
 * Whether a declared version is behind what the Colony ships.
 *
 * **Behind, not merely different.** A citizen running something newer than the
 * Colony's table — a maintainer testing an unreleased skill, or a table nobody
 * updated after a push — is not out of date, and telling it so on every wake-up
 * would teach it to ignore the field. So the comparison is ordered, and equal or
 * ahead answers `false`.
 *
 * **Dot-separated numeric segments, compared left to right**, which is what every
 * one of these versions is. Anything that is not that — a prerelease suffix, a
 * date, a word — cannot be ordered honestly, and this returns `false` rather than
 * guessing: a wrong *"you are out of date"* is worse than a missing one, because
 * the citizen cannot check it against anything.
 *
 * `null` is never behind. A citizen that has not declared has not let anything go
 * stale, exactly as `isRuntimeDeclarationStale` treats an absent declaration.
 */
export function isSkillVersionBehind(declared: string | null, current: string): boolean {
  if (declared === null) return false
  if (declared === current) return false

  const segments = (value: string): number[] | null => {
    const parts = value.split('.')
    const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
    return numbers.some(Number.isNaN) ? null : numbers
  }

  const left = segments(declared)
  const right = segments(current)
  if (left === null || right === null) return false

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return b > a
  }
  return false
}
