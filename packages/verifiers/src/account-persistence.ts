import type {
  Account,
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { PERSISTENCE_INTERVAL_DAYS, TaskTypeSchema } from '@kolonie-ai/core'
import { CHALLENGE_LABEL, type DnsReader } from './dns.js'
import type { DomainChallenges } from './domain-verify.js'

export { PERSISTENCE_INTERVAL_DAYS }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a re-check of one kind of account found.
 *
 * `unavailable` is not `gone`, and the distinction is the same one every
 * verifier in this package draws: the Colony being unable to reach something is
 * not the citizen's failure, and a resolver problem must not spend a ninety-day
 * wait.
 */
export type RecheckOutcome =
  | { readonly outcome: 'held'; readonly evidence: string }
  | { readonly outcome: 'gone'; readonly evidence: string }
  | { readonly outcome: 'unavailable'; readonly evidence: string }

/**
 * How one kind of account is re-checked.
 *
 * **The per-kind check is a strategy, not a task** (`#152`). Re-proving a DNS
 * record and re-proving a mailbox share nothing mechanically, so each kind
 * supplies its own; what is shared is everything else — the interval, the
 * outcome, what a failure means, and what it pays. That is the half that was
 * about to be written five times, once per kind, each with its own phrasing of
 * *failing takes nothing away*.
 */
export interface AccountRecheck {
  /** The register's name for what this checks. */
  readonly kind: string
  recheck(agentId: AgentId, account: Account): Promise<RecheckOutcome>
}

/** What the badge reads about the citizen's register. */
export interface RecheckableAccounts {
  /**
   * The citizen's proved, in-use accounts of these kinds, staleest first.
   *
   * Retired and lost are excluded by the register, not by this verifier: the
   * citizen said so, and the exclusion belongs where the field lives.
   */
  recheckable(agentId: AgentId, kinds: readonly string[]): Promise<readonly Account[]>
}

export interface AccountPersistenceDependencies {
  readonly accounts: RecheckableAccounts
  /** One per kind the Colony can re-check. `domain` is the first (`#152`). */
  readonly checks: readonly AccountRecheck[]
}

/**
 * `account-persistence` — an account the citizen proved is still held (`#152`).
 *
 * **One badge over the register rather than one per kind.** `domain-persistence`
 * was the pattern and it was a good one; the risk was writing it five more
 * times — `mailbox-persistence`, `github-persistence`, `social-persistence`,
 * `website-persistence` — each with its own interval, its own reward argument
 * and its own phrasing of what a failure means. The moment two of them disagreed
 * about what a failed re-check costs, the model would have had a hole nobody
 * could see from any single file.
 *
 * **Nothing is ever revoked.** The skill stays held, the reward is paid once, a
 * failed re-check writes nothing to reputation and nothing to the ledger. What
 * changes is one field in the register: the account is *unconfirmed since* a
 * date. That is a fact, not a penalty, and it is the whole reason a badge is the
 * right form — D-015 pays once forever and a skill is held or not held, so a
 * measurement that is allowed to fail must not be able to take anything away.
 *
 * **Which account it asks about is the Colony's choice, not the citizen's**, and
 * it is the one whose evidence is oldest. A citizen that could name the account
 * would name the one it knows still works, and the badge would certify the
 * thing it was least worth asking.
 *
 * Three checks, in the order that spends least before refusing:
 *
 * 1. the citizen holds a re-checkable account at all;
 * 2. the interval has elapsed since that account was last confirmed — or proved,
 *    where it never has been;
 * 3. the kind's own strategy finds it still held.
 */
export class AccountPersistenceVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('account-persistence')

  constructor(private readonly deps: AccountPersistenceDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const kinds = this.deps.checks.map((check) => check.kind)
    const held = await this.deps.accounts.recheckable(context.agent.id, kinds)
    const candidate = held[0]

    if (candidate === undefined) {
      return {
        status: 'fail',
        evidence:
          'Check 1 (an account to ask about): the Colony holds no proved account of yours that ' +
          `it knows how to re-check. It can re-check: ${kinds.join(', ')}. An account you have ` +
          'retired or marked lost is deliberately not asked about — you said so, and the Colony ' +
          'does not argue with that.',
        metadata: { check: 'account-held', attempt: submission.attempt },
      }
    }

    // `provedAt` is non-null on a proved row — the check constraint says so —
    // and the fallback is a date rather than a throw because a badge must not be
    // the thing that discovers a broken invariant by failing a citizen.
    const since = candidate.confirmedAt ?? candidate.provedAt ?? new Date(0).toISOString()
    const elapsed = Date.now() - Date.parse(since)
    const required = PERSISTENCE_INTERVAL_DAYS * DAY_MS

    if (elapsed < required) {
      const daysLeft = Math.ceil((required - elapsed) / DAY_MS)

      return {
        status: 'fail',
        evidence:
          `Check 2 (the interval): the Colony last confirmed \`${candidate.identifier}\` at ` +
          `${since}, and this badge asks for ${PERSISTENCE_INTERVAL_DAYS} days. Come back in ` +
          `${daysLeft}. Nothing is lost by trying early — this costs you an attempt and no more.`,
        metadata: {
          check: 'interval-elapsed',
          accountId: candidate.id,
          kind: candidate.kind,
          daysLeft,
          attempt: submission.attempt,
        },
      }
    }

    const strategy = this.deps.checks.find((check) => check.kind === candidate.kind)

    if (strategy === undefined) {
      // Unreachable: the register was asked for exactly these kinds. Stated
      // rather than asserted, because the cost of being wrong is a citizen
      // failing a badge for a wiring mistake.
      return {
        status: 'pending',
        evidence: `The Colony cannot re-check a ${candidate.kind} account at the moment.`,
        metadata: { check: 'strategy', kind: candidate.kind, attempt: submission.attempt },
      }
    }

    const found = await strategy.recheck(context.agent.id, candidate)

    /**
     * **The account id and what was found travel in the metadata**, because a
     * verifier reads the world and never writes to it (AGENTS.md §3). What marks
     * the register is the transaction that records this verdict, which is also
     * the only place a failure can be recorded — a failed submission never
     * reaches the booking, and *unconfirmed since* has to be written on exactly
     * the path that does not pay.
     */
    const marker = { accountId: candidate.id, kind: candidate.kind, attempt: submission.attempt }

    if (found.outcome === 'unavailable') {
      return {
        status: 'pending',
        evidence: `Check 3 (the account): ${found.evidence}`,
        // No `recheck` key: nothing was found either way, so nothing is
        // recorded. A resolver that timed out is not evidence about a citizen.
        metadata: { ...marker, check: 'recheck' },
      }
    }

    if (found.outcome === 'gone') {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the account): ${found.evidence} Nothing is taken away by this — the skill ` +
          'you earned with it is permanent, the reward stays paid, and your reputation is ' +
          'untouched. What the Colony records is that this account is unconfirmed since today, ' +
          'which is a fact about the account rather than a judgement about you.',
        metadata: { ...marker, check: 'recheck', recheck: 'gone' },
      }
    }

    return {
      status: 'pass',
      evidence:
        `\`${candidate.identifier}\` is still yours: ${found.evidence} The Colony last confirmed ` +
        `it at ${since}, ${Math.floor(elapsed / DAY_MS)} days ago.`,
      metadata: { ...marker, recheck: 'held' },
    }
  }
}

/**
 * The `domain` strategy, and the first implementation of the port (`#152`).
 *
 * **`domain-persistence`'s logic, reused rather than copied.** Every argument
 * that badge made survives here unchanged: a fresh nonce rather than the record
 * that is already there, because a record nobody deleted proves only that nobody
 * deleted it — a citizen that lost its provider credentials, or whose free
 * subdomain quietly changed hands, passes that. Writing a *new* value is what
 * shows the citizen can still reach the zone.
 */
export function domainRecheck(deps: {
  readonly dns: DnsReader
  readonly challenges: DomainChallenges
}): AccountRecheck {
  return {
    kind: 'domain',

    async recheck(agentId, account) {
      const nonces = await deps.challenges.openNonces(agentId)

      if (nonces.length === 0) {
        return {
          outcome: 'gone',
          evidence:
            'you have no live challenge. Mint a fresh one with `kolonie.academy.domain.challenge`, ' +
            'publish it at `_kolonie-challenge.' +
            account.identifier +
            '` with your agent id, and submit again. It must be a new nonce — the record you ' +
            'published to earn the skill proves only that nobody deleted it.',
        }
      }

      const read = await deps.dns.readTxt(account.identifier, CHALLENGE_LABEL)

      if (read.outcome === 'unavailable') {
        return { outcome: 'unavailable', evidence: read.reason }
      }

      if (read.outcome === 'no-record') {
        return {
          outcome: 'gone',
          evidence: `${read.reason} \`${account.identifier}\` no longer serves the Colony's record.`,
        }
      }

      const id = String(agentId)
      const published = read.records.find(
        (record) => record.includes(id) && nonces.some((nonce) => record.includes(nonce)),
      )

      if (published === undefined) {
        return {
          outcome: 'gone',
          evidence:
            `no TXT record at \`${CHALLENGE_LABEL}.${account.identifier}\` carries a nonce the ` +
            'Colony issued you together with your agent id.',
        }
      }

      return {
        outcome: 'held',
        evidence:
          `its nameservers serve a freshly issued nonce at ` +
          `\`${CHALLENGE_LABEL}.${account.identifier}\` alongside \`${id}\`.`,
      }
    },
  }
}
