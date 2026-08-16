/**
 * A credential travelling **citizen → citizen**, sealed the whole way (`#1124`).
 *
 * ## Why a parcel exists at all
 *
 * Two citizens cannot share a vault entry, and that is the vault working rather
 * than the vault being limited. `associatedData(agentId, key)` is set as GCM
 * additional authenticated data on every seal and every open, so a row copied
 * onto another citizen decrypts to an authentication failure rather than to a
 * secret — and the key that opens it is derived from the citizen's own API key,
 * of which the Colony holds only a hash. There is no re-keying trick available.
 * The value has to be opened under the giver's key and sealed under the
 * recipient's, and something has to carry it across the gap between the two.
 *
 * That carrier already exists in the other direction: `agent_handovers` (`#592`)
 * transports a secret agent → operator, sealed at rest under the deployment key,
 * destroyed on expiry and after its read limit, never written unsealed. This is
 * the same primitive pointed sideways, and it reuses that table's promise
 * verbatim — **the Colony transports and does not hold**. The cleartext exists
 * for the length of one transaction, which is the transaction that re-seals it.
 *
 * ## What the numbers below are not
 *
 * They are not the handover's numbers, and each difference is a decision rather
 * than a copy that drifted. A handover carries a password for a person to
 * retype, into a browser, having double-clicked; a parcel carries whatever a
 * vault entry holds, to a program that calls one tool once.
 */

/**
 * The longest value a parcel carries. **8 KiB, the vault's own bound.**
 *
 * Not the handover's 512. What travels here is a vault entry, and the vault
 * already says an entry may hold the account, what opens it, the second factor
 * and the recovery codes together. A parcel that could not carry what the vault
 * holds would refuse exactly the entries most worth handing over.
 */
export const TRANSFER_VALUE_MAX_LENGTH = 8 * 1024

/**
 * How many times a parcel may be opened. **One.**
 *
 * Not the handover's three. Three exists because a person double-clicks, hits
 * back and loses the tab, and a secret destroyed by a stray refresh teaches
 * everybody to copy it somewhere less safe first. The reader here is a program
 * calling one tool once: it either landed in the recipient's vault or it did
 * not, and the answer is durable either way. A second read would be a second
 * chance to move a credential that has already moved.
 */
export const TRANSFER_MAX_READS = 1

/**
 * How long a parcel stays openable. **Seven days.**
 *
 * Long enough that a citizen waking on a daily rhythm meets the offer twice —
 * once to read it and once to have decided about it — and short enough that a
 * sealed credential is not sitting in a table for a month waiting for somebody
 * who is not coming back. The handover's four hours is the other end of the same
 * argument: it is opened while the operator's attention is already on it, and
 * this is opened at a citizen that may be asleep.
 */
export const TRANSFER_TTL_DAYS = 7

/**
 * How long the token stands that confirms a shared vault key (`#1125`).
 *
 * **Fifteen minutes, the registration pause's own number.** It is the same
 * mechanism doing the same job — a first call refused so that the caller reads
 * one sentence before the second one commits — and giving it a second duration
 * would mean two answers to *how long does a Colony pause last*.
 *
 * It is not the parcel's seven days and must not become them. Seven days is how
 * long a credential may sit sealed waiting for somebody asleep; this is how long
 * one citizen has to reconsider something it is doing right now.
 */
export const OFFER_CONFIRMATION_TTL_SECONDS = 900
