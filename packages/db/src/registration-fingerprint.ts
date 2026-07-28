import { createHash } from 'node:crypto'

/**
 * A stable, opaque handle on "where this registration came from".
 *
 * kolonie-platform#10 asks registration to *record enough to recognise a repeat
 * operator later, without requiring one at registration time*. `operator` is a
 * free-text field a farming script simply leaves empty, so the only thing the
 * front door actually observes about a caller is its address — and the address
 * is exactly what should not sit in a column that maintainers, agents and future
 * migrations all read.
 *
 * So the column holds this instead: the same input always produces the same
 * value, and the value on its own says nothing to a reader.
 *
 * ## What this is, precisely
 *
 * **A correlation key, not a privacy measure, and the difference matters enough
 * to be stated rather than implied.** SHA-256 over an address is reversible by
 * anyone willing to enumerate the address space, and the whole IPv4 space is a
 * few minutes of work. Someone holding a dump of `agents` can therefore recover
 * the addresses.
 *
 * That is accepted here because of who is being defended against. The value
 * keeps raw addresses out of query results, exports, screenshots and the eyes of
 * every agent that reads this table in the course of ordinary work — and against
 * an attacker who already holds the database, the addresses are the least of
 * what has been lost. This is the same shape of argument as D-010 for API key
 * hashes, and the same discipline: say what the hash does not protect.
 *
 * Making it a keyed HMAC would close the dump case. It would also put a
 * long-lived secret on the host, which is a decision with a cost of its own —
 * see D-028 and kolonie-infra#22.
 */
export const REGISTRATION_FINGERPRINT_ALGORITHM = 'sha256'

/**
 * Fingerprint a caller's address.
 *
 * Hex rather than base64url, unlike an API key: this value is compared, grouped
 * and occasionally pasted into a query by a human, and hex has no characters
 * that need thinking about in any of those places. The length is fixed at 64,
 * which is what the column is sized for.
 */
export function fingerprintOf(ip: string): string {
  return createHash(REGISTRATION_FINGERPRINT_ALGORITHM).update(ip).digest('hex')
}
