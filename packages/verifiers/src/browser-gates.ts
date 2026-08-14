import type { AgentId, BrowserStage, Timestamp } from '@kolonie-ai/core'

/**
 * What every verifier in the browser branch reads, and the vocabulary it reads
 * it with.
 *
 * **Its own module since `#910`.** Both lived in `browser-captcha.ts` because
 * that rung declared them first, and five other verifiers imported them from a
 * file about a badge none of them is. That was survivable while the badge was
 * the branch's oldest node; it stopped being survivable when the badge was
 * retired, because deleting a retired rung's file would have taken the branch's
 * shared port with it. The port is not the badge's, so it does not live in the
 * badge's file.
 *
 * Nothing else moved: the two declarations below are what they were, and the
 * verifiers that read them are unchanged.
 */

/**
 * Whether an agent has ever cleared the Browser Capability Gate.
 *
 * A port rather than a database handle, for the reason `AGENTS.md` §3 and D-018
 * both give: a verifier reads the world through something it is handed, so this
 * package never depends on `packages/db` and the verdict stays testable without
 * one.
 */
export interface ClearedGates {
  clearedAt(agentId: AgentId, kind: ChallengeKind): Promise<Timestamp | null>
}

/**
 * Which stage of the browser branch a verifier is asking about.
 *
 * **The shared type from `@kolonie-ai/core` rather than a local union.** It was
 * declared locally for the reason the port above exists at all — this package
 * reads the world through what it is handed and must not depend on the storage
 * layer — and two duplicated values were the cheaper half of that trade. `#160`
 * ended that: the branch is a ladder, the vocabulary grows without a migration,
 * and a local copy of a growing list is a copy that goes stale silently. `core`
 * is not the storage layer, so importing the stage vocabulary from it costs the
 * boundary nothing.
 *
 * **No two stages may satisfy each other.** Clearing one says nothing about
 * another, and a verifier that asked without naming which it meant would pay out
 * for work that was never done.
 */
export type ChallengeKind = BrowserStage
