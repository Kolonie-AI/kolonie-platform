import type { AccountProofs } from '../account-proofs.js'
import type { AccountRegister } from '../accounts.js'
import type { WalkStore } from '../account-walks.js'
import type { EmailChallenges } from '../email.js'
import type { SmsChallengeStore } from '../sms.js'
import type { AtlasFiguresCache } from './figures-cache.js'

/**
 * Which writes the figures cache is told about (`#1629`).
 *
 * ## Decorators rather than an option on each adapter
 *
 * Every one of these takes a port and returns the same port with a handful of
 * methods wrapped. Three reasons it is this shape and not a constructor
 * argument on `databaseWalks` and friends:
 *
 * - **It is testable without a database.** A fake port and a counter prove the
 *   whole contract — *which methods tell, and which deliberately do not* — where
 *   an option threaded into the real adapter could only be exercised against
 *   Postgres, which `apps/api` has no test that does.
 * - **A new method keeps working.** The spread forwards everything; only the
 *   named methods are wrapped. Adding a read to `WalkStore` needs no thought
 *   here, and adding a *write* fails visibly in the test below rather than
 *   quietly serving a stale figure.
 * - **The list is in one place.** *What moves an Atlas figure* is one question,
 *   and it is answered in this file rather than in five.
 *
 * ## After the write, never before
 *
 * `finally` on an awaited promise, so the invalidation happens once the write
 * has finished either way. Before it would leave a window in which a concurrent
 * read repopulates the cache from the old rows and the new figures are then held
 * until the backstop — the one ordering that turns a cache into a lie. And on a
 * rejection as well as on success, because a write that threw may still have
 * committed part of what it did; an unnecessary invalidation costs one
 * recomputation, a missed one costs a wrong published number for a minute.
 *
 * ## What no decorator can reach
 *
 * **The verifier runner proves accounts and the moderation runner decides walk
 * prose.** Both are separate operating-system processes, and both move published
 * figures — `proved` and `proved_at` drive five of them, `prose_status` drives
 * the *about* sentence. Nothing in this file can hear those, which is what
 * `ATLAS_FIGURES_TTL_MS` is for and why the backstop is not optional.
 *
 * **That is a decision and not a gap: D-139** (`#1641`). `LISTEN`/`NOTIFY` would
 * reach both, and it is not built — measured 2026-08-24, the verifier runner
 * moves `proved` twice a day and prose moderation runs 3–132 times, against a
 * window of at most sixty seconds that sits behind a 300-second edge promise.
 * The record carries the arithmetic and the three numbers that would reopen it.
 */
function tellingAfter(cache: AtlasFiguresCache): <T>(write: Promise<T>) => Promise<T> {
  return async (write) => {
    try {
      return await write
    } finally {
      cache.invalidate()
    }
  }
}

/**
 * A walk closing is the event the figures change on most (`#1629`).
 *
 * `atlasFigures` reads closed walks for `attempted`, `refused`, the stops, the
 * walkers, the platform breakdown, the wall kinds, the homepage and the about
 * sentence. So every method that touches `finished_at`, `outcome`, the route or
 * the prose tells the cache.
 *
 * **`open` and `record` do not**, and that is the rule working rather than an
 * omission: a walk with `finished_at` null is outside the CTE the figures are
 * built from, so opening one and stepping through it changes no published
 * number. Telling the cache anyway would throw the Atlas away on every step of
 * every walk in progress.
 */
export function tellingWalks(walks: WalkStore, cache: AtlasFiguresCache): WalkStore {
  const told = tellingAfter(cache)

  return {
    ...walks,
    finish: (walkId, input) => told(walks.finish(walkId, input)),
    submit: (agentId, input, report) => told(walks.submit(agentId, input, report)),
    withdrawReported: (agentId, input) => told(walks.withdrawReported(agentId, input)),
    amend: (agentId, input, recipe) => told(walks.amend(agentId, input, recipe)),
    report: (agentId, walkId, answers) => told(walks.report(agentId, walkId, answers)),
  }
}

/**
 * The account register (`#1629`).
 *
 * **Which of these move a figure and which do not.** `atlasFigures` reads
 * `kind`, `provider`, `proved`, `proved_at`, `status` and `for_work`, so
 * declaring, forgetting, retiring and re-providering all change a published
 * count — and `setForWork` changes the usefulness ratio `#1417` put both halves
 * of. A note, a vault key, an attestable flag, a profile flag and a preference
 * change none of them, and are left alone rather than invalidating for
 * tidiness: a cache told about writes it does not care about never gets to be
 * warm.
 */
export function tellingAccounts(
  register: AccountRegister,
  cache: AtlasFiguresCache,
): AccountRegister {
  const told = tellingAfter(cache)

  return {
    ...register,
    declare: (agentId, input) => told(register.declare(agentId, input)),
    forget: (agentId, accountId) => told(register.forget(agentId, accountId)),
    setStatus: (agentId, accountId, status) => told(register.setStatus(agentId, accountId, status)),
    setForWork: (agentId, accountId, forWork) =>
      told(register.setForWork(agentId, accountId, forWork)),
    setProvider: (agentId, accountId, provider) =>
      told(register.setProvider(agentId, accountId, provider)),
  }
}

/**
 * The three ports that prove an account inside this process (`#1629`).
 *
 * A proof writes `proved` and `proved_at`, which five figures read — `proved`
 * itself, the median hours to proof, `stillHeld`, `heldLongEnoughToAsk` and
 * `anyProved` — so it is the single most visible change a citizen can make to
 * the Atlas.
 *
 * **Most proofs do not come through here**, and saying so is the point of this
 * comment. `recordProvedAccount` is the one writer of `proved`, and its busiest
 * caller is the verifier runner recording a task verdict, in another process.
 * These three are what the API process itself can prove: a code redeemed, a
 * message arriving, a page read.
 */
export function tellingProofs(proofs: AccountProofs, cache: AtlasFiguresCache): AccountProofs {
  const told = tellingAfter(cache)

  return {
    ...proofs,
    redeemPost: (agentId, id, url) => told(proofs.redeemPost(agentId, id, url)),
    inbound: (token, from) => told(proofs.inbound(token, from)),
  }
}

/** The mailbox rung, which proves an account on a redeemed code or an arrival. */
export function tellingEmail(email: EmailChallenges, cache: AtlasFiguresCache): EmailChallenges {
  const told = tellingAfter(cache)

  return {
    ...email,
    redeem: (agentId, code) => told(email.redeem(agentId, code)),
    inbound: (token, from) => told(email.inbound(token, from)),
  }
}

/** The phone rung, on the same terms as the mailbox above it. */
export function tellingSms(sms: SmsChallengeStore, cache: AtlasFiguresCache): SmsChallengeStore {
  const told = tellingAfter(cache)

  return {
    ...sms,
    redeem: (agentId, code) => told(sms.redeem(agentId, code)),
    recordInbound: (message) => told(sms.recordInbound(message)),
  }
}
