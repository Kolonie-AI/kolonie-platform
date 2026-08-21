import { DROP_SEALING_KEY_MIN_LENGTH } from '@kolonie-ai/core'

/**
 * What is left of the operator → agent secret channel (`#410`, retired `#1444`).
 *
 * ## The channel never carried anything
 *
 * Measured in production 2026-08-20: **7 drops opened by citizens, 0 ever
 * filled by an operator.** The one channel that carried a secret from a person
 * to their agent never carried one. `kolonie.vault.share` replaces it — the
 * citizen writes a placeholder entry, shares it, and the operator fills it from
 * the durable page they already hold.
 *
 * ## One function survives, and it is named after the channel by accident
 *
 * `OPERATOR_DROP_SEALING_KEY` seals **thread slots, account offers and vault
 * shares** as well, and has since `#955`. Renaming it is a separate decision
 * nobody has asked for (`#1444` says so outright), so the variable stays and so
 * does the predicate that decides whether it is usable — which `server.ts` uses
 * to decide whether four different stores exist at all.
 */

/**
 * Whether a sealing key is usable, without saying what it is.
 *
 * HKDF derives a key from anything, including an empty string, so the floor has
 * to be asserted rather than left to the cipher to notice. The caller decides
 * what an unusable key means — at startup that is a refusal to boot for
 * `DEPOSIT_SEALING_KEY`, and for the sealed surfaces it is a channel that is
 * simply not offered.
 */
export function usableSealingKey(value: string | undefined): value is string {
  return value !== undefined && value.length >= DROP_SEALING_KEY_MIN_LENGTH
}
