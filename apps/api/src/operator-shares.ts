import {
  VAULT_VALUE_MAX_LENGTH,
  looksLikeCredential,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import {
  handBackShare,
  recordShareRead,
  sharesForOperator,
  sharesForPageToken,
  writeShareAddition,
  type Database,
  type OperatorShareOutcome,
  type SharedEntryForOperator,
} from '@kolonie-ai/db'

/**
 * The operator's half of a shared vault entry (`#1440`, epic `#1437`).
 *
 * ## Why the durable page may read a value here, when nothing else may
 *
 * `#1437` frozen decision 1, and it is a reversal rather than an oversight. The
 * rule it overturns — *a secret only in a signed-in console, never through the
 * mailed link* — is stated in `packages/core/src/operator/handover.ts` as the
 * first of four constraints, and it has a measured record: 42 handovers opened
 * and **0 ever read**, 7 drops opened and **0 ever filled**, over the whole
 * lifetime of both channels. Not one value reached a person. The most likely
 * reason is the rule, so the rule goes, and the cost is stated on the page
 * rather than hidden: a link that does not expire can show a password while a
 * share is open.
 *
 * The three constraints that are *not* reversed stay: the window is bounded, the
 * copy is destroyed when it ends, and the citizen can revoke the page.
 *
 * ## Both doors, one store
 *
 * A durable page token and a signed-in console session reach the same rows
 * through the same functions. What differs is how the caller is identified —
 * which is the arrangement `fillDropAsOperator` already has one channel over,
 * and the reason it is worth copying is that two ways to reach a secret drift
 * into having two sets of rules.
 */
export interface OperatorShareStore {
  /** Everything shared with the person holding this durable page. */
  forPageToken(token: string): Promise<readonly SharedEntryForOperator[]>
  /** The same, for a signed-in operator; narrowed to one citizen where asked. */
  forOperator(humanId: HumanId, agentId?: AgentId): Promise<readonly SharedEntryForOperator[]>
  /**
   * Count that a person opened one.
   *
   * **Called where the value is disclosed** — which on these pages is the render
   * itself, because the value is printed rather than put behind a click. That is
   * the honest place for it: what the citizen is being told is *somebody had
   * this in front of them*, and a counter that waited for a second interaction
   * would report zero for an operator who read it and walked away satisfied.
   */
  recordRead(shareId: string): Promise<boolean>
  write(
    reach: { readonly pageToken?: string; readonly humanId?: HumanId },
    shareId: string,
    value: string,
  ): Promise<OperatorShareOutcome>
  handBack(
    reach: { readonly pageToken?: string; readonly humanId?: HumanId },
    shareId: string,
  ): Promise<OperatorShareOutcome>
}

export function databaseOperatorShares(db: Database, sealingKey: string): OperatorShareStore {
  return {
    forPageToken: async (token) => {
      const shares = await sharesForPageToken(db, token, sealingKey)
      // Counted as they are handed to the renderer, once each. See `recordRead`.
      for (const share of shares) await recordShareRead(db, share.id)
      return shares
    },
    forOperator: async (humanId, agentId) => {
      const shares = await sharesForOperator(db, humanId, sealingKey, agentId)
      for (const share of shares) await recordShareRead(db, share.id)
      return shares
    },
    recordRead: (shareId) => recordShareRead(db, shareId),
    write: (reach, shareId, value) => writeShareAddition(db, reach, shareId, value, sealingKey),
    handBack: (reach, shareId) => handBackShare(db, reach, shareId),
  }
}

/**
 * What an operator's addition may be, checked before it is sealed.
 *
 * **A credential is exactly what belongs here**, which is the opposite of every
 * other free box on this page — `looksLikeCredential` guards those precisely so
 * that the place secrets *do* go is a different surface. This is that surface,
 * so the guard is deliberately not applied, and saying so here is what stops
 * somebody adding it later for consistency.
 *
 * What is checked is the bound and the emptiness: the same
 * {@link VAULT_VALUE_MAX_LENGTH} the entry itself is bounded by, because the
 * citizen may end up storing this under that entry's name.
 */
export function shareAdditionError(value: string): string | undefined {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return 'Write something into the box before saving it, or use “Hand it back now” if you are finished.'
  }

  if (trimmed.length > VAULT_VALUE_MAX_LENGTH) {
    return `That is longer than ${VAULT_VALUE_MAX_LENGTH} characters, which is the most one vault entry holds.`
  }

  return undefined
}

/** Re-exported so a caller need not reach into core for the one bound it checks. */
export { looksLikeCredential }
