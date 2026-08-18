/**
 * The quest paths, one file each (`#263`).
 *
 * `write.ts` is what a sponsor does to its own quest, `read.ts` is what it and
 * the runner read back, `steward.ts` is review, moderation and audit, and
 * `shared.ts` holds the two shapes and the one query more than one of them
 * needs. The barrel is here rather than in the parent so that a split changes
 * `storage/index.ts` by one line and two splits in the same week do not collide.
 *
 * This re-exports exactly what `quests.ts` exported and nothing more —
 * `ownQuestRow` is exported from `shared.ts` for its siblings and stays private
 * to this directory.
 */
export * from './write.js'
export * from './read.js'
export * from './steward.js'
export * from './moderation-history.js'
export type { OwnQuest, OwnQuestPlaybook, ScrubbedAnswer } from './shared.js'
