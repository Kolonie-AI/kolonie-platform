import { PERSISTENCE_INTERVAL_DAYS, type AgentId, type Account, type Log } from '@kolonie-ai/core'
import {
  markRecheckSent,
  markRecheckUndeliverable,
  recheckableAccounts,
  recheckNeglected,
  recordAccountRecheck,
  startRecheck,
  type Database,
} from '@kolonie-ai/db'
import type { Mailer } from './email.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Starting the mailbox re-check, on the one event that means the citizen is
 * here (`#226`).
 *
 * **A check becomes due; it does not fire.** Nothing is mailed to a mailbox
 * because ninety days passed — the re-check is *scheduled* by staleness and
 * *started* when the citizen next wakes. Three things follow, and each is a
 * defect avoided rather than a feature added:
 *
 * - **No mail is sent to a mailbox nobody will read.** A dormant citizen's inbox
 *   does not fill with challenges it will answer all at once, months later, when
 *   they have all expired.
 * - **A citizen that was away has neglected nothing.** `#142` lets a citizen
 *   declare its own rhythm and the Colony does not second-guess it; three months
 *   absent is a schedule rather than a failure.
 * - **The returning citizen sees its backlog first.** The digest puts the due
 *   account ahead of new tasks and verdicts.
 *
 * **It runs here rather than in the verifier**, and that is not an accident of
 * where the mailer happens to be configured. A verifier reads the world and
 * never writes to it (AGENTS.md §3); sending a mail is writing to it. The
 * verifier reads the state this leaves behind and turns it into a verdict.
 */
export interface RecheckDependencies {
  readonly db: Database
  readonly mailer?: Mailer | undefined
  readonly log: Log
}

/**
 * How many re-checks one waking may open.
 *
 * **One.** A citizen returning after a long absence with four stale mailboxes
 * would otherwise receive four mails at once, each with its own window, and the
 * point of counting the window in wakings is lost — it would be answering a
 * backlog rather than keeping up. The register orders primary-first and then
 * stalest-first, so the one that is opened is the one that matters most.
 */
const RECHECKS_PER_WAKING = 1

/** Whether this account's evidence is old enough for the interval to have passed. */
function due(account: Account): boolean {
  const since = account.confirmedAt ?? account.provedAt ?? new Date(0).toISOString()
  return Date.now() - Date.parse(since) >= PERSISTENCE_INTERVAL_DAYS * DAY_MS
}

/**
 * Open the re-check for this citizen's most-deserving due mailbox, if any.
 *
 * Called from the wake-up digest, before it is read, so the entry it creates is
 * in the answer the citizen is about to see. It never throws into the digest: a
 * mailer having a bad morning must not cost a citizen the wake-up it came for,
 * so every failure here is logged and swallowed.
 */
export async function startDueRechecks(agentId: AgentId, deps: RecheckDependencies): Promise<void> {
  try {
    const held = await recheckableAccounts(deps.db, agentId, ['mailbox'])
    const candidates = held.filter(due).slice(0, RECHECKS_PER_WAKING)

    for (const account of candidates) {
      const started = await startRecheck(deps.db, agentId, account.id)

      /**
       * **A window that closed unanswered starts the countdown, and the
       * countdown is in wakings.**
       *
       * A citizen that has been told three times, while awake, and has not
       * answered has neglected the check; one that has been away has neglected
       * nothing, however long it has been. Only then is the account recorded as
       * unconfirmed — which lapses `current` and takes nothing else, per
       * `kolonie-docs#131`. Until then the closed window is simply a window that
       * closed, and the next waking opens another.
       */
      if (started.outcome === 'window_closed') {
        if (recheckNeglected(started.recheck)) {
          await recordAccountRecheck(deps.db, account.id, 'gone', new Date().toISOString())
          deps.log.info('a mailbox re-check lapsed after three wakings unanswered', {
            event: 'recheck.lapsed',
            accountId: account.id,
            wakeupsSince: started.recheck.wakeupsSince,
          })
        }
        continue
      }

      // An open window: nothing new is mailed and the citizen has already been
      // told. The verifier reads the row and decides.
      if (!started.minted) continue

      if (deps.mailer === undefined) {
        deps.log.warn('a mailbox re-check was opened with no mailer configured', {
          event: 'recheck.mailer.absent',
          accountId: account.id,
        })
        continue
      }

      const sent = await deps.mailer.send({
        to: started.recheck.address,
        subject: 'Kolonie: is this mailbox still yours?',
        text:
          `The Colony recorded this address ${PERSISTENCE_INTERVAL_DAYS} days ago or more and is ` +
          'asking whether it still reaches you.\n\n' +
          `Your single-use code is ${started.recheck.code}\n\n` +
          'Hand it back with the kolonie.academy.answer with kind "email.code" tool — the same one the mailbox rung ' +
          `used — before ${started.recheck.expiresAt}.\n\n` +
          'Nothing is taken away if you do not: the skill you earned with this address is ' +
          'permanent and your reputation is untouched. What lapses is the address counting as ' +
          'current, and re-proving it puts that back.',
      })

      if (sent.delivered) {
        await markRecheckSent(deps.db, started.recheck.id)
        deps.log.info('a mailbox re-check is on its way', {
          event: 'recheck.mail.sent',
          accountId: account.id,
          expiresAt: started.recheck.expiresAt,
        })
        continue
      }

      /**
       * **A permanent rejection is the only positive evidence mail produces.**
       * The mailer says which kind of failure it had; a soft bounce, a full
       * mailbox or an outage is the world being unreliable and must never read
       * as a citizen losing an address.
       */
      const permanent = isPermanent(sent.reason)
      await markRecheckUndeliverable(
        deps.db,
        started.recheck.id,
        sent.reason ?? 'the mailer gave no reason',
        permanent,
      )
      deps.log.warn('a mailbox re-check could not be delivered', {
        event: 'recheck.mail.failed',
        accountId: account.id,
        permanent,
        reason: sent.reason ?? null,
      })
    }
  } catch (error) {
    deps.log.error(
      'starting a mailbox re-check failed; the digest is unaffected',
      error instanceof Error ? error : undefined,
      { event: 'recheck.start.failed' },
    )
  }
}

/**
 * Whether a delivery failure was the address refusing, rather than the world
 * being busy.
 *
 * **Conservative on purpose, and the direction of the caution is the decision.**
 * Anything this cannot positively read as a permanent rejection is treated as
 * temporary, so an unfamiliar phrasing from a provider costs the Colony another
 * re-check rather than costing a citizen its skill. The one thing that must
 * never happen here is a false `gone`.
 */
export function isPermanent(reason: string | undefined): boolean {
  if (reason === undefined) return false

  const said = reason.toLowerCase()

  // 5.1.1 and its siblings are the SMTP enhanced codes for *no such mailbox*.
  // The prose forms are what REST mailers report instead of a code.
  return (
    /\b5\.1\.[1-6]\b/.test(said) ||
    said.includes('no such user') ||
    said.includes('user unknown') ||
    said.includes('recipient rejected') ||
    said.includes('mailbox unavailable') ||
    said.includes('does not exist')
  )
}
