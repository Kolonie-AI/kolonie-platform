/**
 * Telling *the store was not there* apart from *the Colony is broken* (`#1086`).
 *
 * ## Why this is a module and not three lines in the error handler
 *
 * The knowledge here is the driver's, so it lives beside the driver. `app.ts`
 * knows that some failures deserve a 503; which failures those are is a fact
 * about `postgres` and about PostgreSQL's own SQLSTATE vocabulary, and a copy of
 * it in `apps/api` would be a copy nobody updated when the driver changed.
 *
 * ## Read off codes, never off message text
 *
 * `apps/api/src/reachability.ts` already argues this for the same class of
 * fault, and the argument is the same one here: *a message is a runtime's
 * wording and changes between releases, while `ECONNREFUSED` has meant one thing
 * for forty years.* A rule written against `"write CONNECTION_ENDED postgres"`
 * would break on a driver release that reworded it, and would break silently —
 * it would go on answering 500, which is the current behaviour, so no test that
 * did not name the string would notice.
 *
 * ## The cause chain is not optional
 *
 * **Drizzle wraps the driver's error** as `Failed query: …` and puts the
 * original on `cause` — measured in `connection-ended.test.ts`, which was
 * written for `#874` and found exactly this: *a rule that read `error.code`
 * would match nothing and silently never retry.* A recogniser that looked only
 * at the top-level error would recognise nothing and answer 500 forever, and the
 * test proving it worked would be the one thing it was easiest not to write.
 *
 * ## Deliberately not a retry
 *
 * `D-121` refused to reattempt a statement inside this package, and nothing here
 * reverses that. **The retry this enables is the caller's**, made by a citizen
 * that has been told plainly that repeating the identical call is the remedy —
 * which is a different act from the Colony quietly running a statement twice
 * without anybody being able to see that it did.
 */

/**
 * Socket-level failures, as Node names them.
 *
 * `postgres` passes these through untouched: `Errors.connection(x, …)` sets
 * `code` to the socket's own code, so what arrives is what Node raised. The
 * measured case (2026-08-16, an infra deploy recreating the database container)
 * is `ECONNREFUSED` — nothing was listening for 2.088 seconds.
 */
const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // The store's name did not resolve. A DNS answer that is briefly missing
  // during a deploy is the same two seconds as a refused socket, and neither is
  // anything the caller sent.
  'ENOTFOUND',
  'EAI_AGAIN',
])

/**
 * The driver's own vocabulary for a connection that is not there.
 *
 * `CONNECTION_ENDED` is in the set and is the one worth arguing. It does not
 * mean *the socket died* — `connection-ended.test.ts` pins it down as *this pool
 * has been shut down*, which is the API process going away. That is terminal to
 * this process and it is not terminal to the citizen: the next call reaches a
 * process that is up. So the caller has nothing to correct, which is the whole
 * of what the code says.
 */
const DRIVER_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_REFUSED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
])

/**
 * SQLSTATEs where the server answered and the answer was *not now*.
 *
 * Class `08` is PostgreSQL's own *connection exception*, taken whole. The three
 * named beside it are the shutdown sequence a container recreation produces from
 * the other end: the server terminating live connections, and then refusing new
 * ones while it comes back up.
 *
 * **`57014` is not here on purpose.** A cancelled statement is a query that ran
 * too long, which is a fact about the query — remapping it would tell a citizen
 * to repeat a call that will time out again for as long as the data is that
 * shape.
 */
const SQL_STATES: ReadonlySet<string> = new Set([
  // 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
  '57P01',
  '57P02',
  '57P03',
])

/** How deep to follow `cause` before giving up. Drizzle adds one layer; five is slack. */
const DEPTH = 5

const codesIn = (error: unknown): ReadonlySet<string> => {
  const found = new Set<string>()
  let current: unknown = error

  for (let depth = 0; depth < DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      found.add(current.code)
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : null
  }

  return found
}

/**
 * Whether this failure was the store being unreachable rather than a defect.
 *
 * **Unrecognised is `false`, and that direction is the one that matters.** A
 * mapping that swallowed a real defect into *try again* would be worse than
 * answering 500 for a restart: the citizen would retry a call that can never
 * succeed, and the Colony would have told it to. So this recognises a named list
 * and guesses at nothing — a fault it has not seen before stays `internal`, and
 * stays visible.
 */
export function isDatabaseOutage(error: unknown): boolean {
  const codes = codesIn(error)

  for (const code of codes) {
    if (SOCKET_CODES.has(code) || DRIVER_CODES.has(code) || SQL_STATES.has(code)) return true
    // Class 08 — connection exception — taken whole rather than enumerated: the
    // class is the standard's own statement that these are connection faults,
    // and a member of it added later means the same thing.
    if (code.length === 5 && code.startsWith('08')) return true
  }

  return false
}
