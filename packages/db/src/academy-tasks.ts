/**
 * The Academy, as one importable name.
 *
 * **This file is the seam and not the surface.** Every rung lives in
 * `academy-tasks/`, one file per rung named for its `type`, with the shared
 * builders in `academy-tasks/shared.ts` and the assembly and the seed in
 * `academy-tasks/index.ts`.
 *
 * It exists so that splitting three thousand lines into a directory did not make
 * six importing files name a path inside it — the same seam `apps/api/src/mcp.ts`
 * is, for the same reason. What is exported here is what was exported before,
 * under the same names.
 */
export { ACADEMY_TASKS, seedAcademyTasks } from './academy-tasks/index.js'
export { POW_DIFFICULTY_BITS } from './academy-tasks/shared.js'
export type { SeedResult } from './academy-tasks/index.js'
export type { AcademyTask } from './academy-tasks/shared.js'
