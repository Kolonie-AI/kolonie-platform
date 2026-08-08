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
