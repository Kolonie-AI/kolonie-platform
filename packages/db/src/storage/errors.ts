/**
 * Postgres reports a unique index violation as SQLSTATE 23505. Matched on the
 * code rather than on the message, which is localised and has changed between
 * major versions.
 *
 * **The chain has to be walked.** Drizzle wraps the driver's error in its own
 * "Failed query: …" error, and the SQLSTATE lives on the `cause`, not on what is
 * thrown. Reading `error.code` alone finds nothing, the violation escapes as an
 * unhandled error, and an agent whose only mistake was racing another agent to
 * the same mailbox gets a 500 instead of being told the address is taken. The
 * race test is what exposed it.
 *
 * Shared rather than duplicated: the mailbox rung and the `key-signature` rung
 * both enforce a one-per-citizen rule with a partial unique index, and both have
 * to turn its violation into an answer rather than a crash. A second copy of a
 * cause-chain walk is a second place to get the chain wrong.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current != null; current = causeOf(current)) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === '23505'
    ) {
      return true
    }
  }
  return false
}

/**
 * Whether a string is shaped like a uuid, asked **before** it reaches a query.
 *
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so a `where id = $1` against a `uuid` column turns a wrong id into a 500
 * instead of a not-found. Every id this repository compares that way arrives
 * from outside — a form field, a path segment, a tool argument — which means it
 * arrives from anywhere.
 *
 * Shared rather than duplicated, for the reason {@link isUniqueViolation} is:
 * the challenge lookups and the browser-share console page both promise a
 * caller that a bad id is indistinguishable from an id that does not exist, and
 * a second copy of the shape is a second place for that promise to come apart.
 * `#768` is what it looks like when one of them has no copy at all — a citizen's
 * operator pasted the share **token** where the share **id** goes and the
 * console answered with its "something went wrong" page.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined
}

/**
 * Whether a unique violation names **this** index (`#571`).
 *
 * `isUniqueViolation` answers *something was already taken*, which is enough
 * when a table has one uniqueness rule. `solana_wallet_challenges` has two, and
 * they mean opposite things to the citizen that hit one: *another citizen holds
 * that wallet* and *you already hold one*. Reporting the first for the second
 * would tell an agent its own wallet belongs to somebody else.
 *
 * `postgres` puts the index name on `constraint_name`; the chain is walked for
 * the reason above — Drizzle wraps the driver's error and the detail lives on
 * the `cause`.
 */
export function violatesConstraint(error: unknown, name: string): boolean {
  for (let current: unknown = error; current != null; current = causeOf(current)) {
    if (
      typeof current === 'object' &&
      'constraint_name' in current &&
      (current as { constraint_name?: unknown }).constraint_name === name
    ) {
      return true
    }
  }
  return false
}
