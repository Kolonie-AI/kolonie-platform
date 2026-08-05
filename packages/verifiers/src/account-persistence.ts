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
import { withSupportPointer } from './support.js'
import {
  extractTokens,
  safeFetch,
  type PageReader,
  type WebsiteChallenges,
} from './website-verify.js'
import type { WebServerChallengeReader } from './web-server-verify.js'

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
   * The check has been started and the answer is not here yet (`#226`).
   *
   * **A fourth outcome, because one kind cannot be checked synchronously and the
   * other can.** A domain re-check reads DNS and has an answer in a second; a
   * mailbox re-check cannot be done by the Colony alone — it writes a token to
   * the address and *the citizen has to come back and report it*. `held`, `gone`
   * and `unavailable` all assume the answer is available now, and forcing a
   * mailbox into one of them would mean either failing a citizen for not having
   * answered a mail sent seconds ago, or passing it for a mailbox nobody read.
   *
   * It is not `unavailable` under another name: `unavailable` says the Colony
   * could not establish anything and records nothing, while this says the check
   * is *running* and has a window with a deadline in it.
   */
  | { readonly outcome: 'pending'; readonly evidence: string }

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
 * **`website` is the second kind, and it arrived as a strategy** (`#242`). The
 * issue that asked for it was written as *a `website-persistence` rung* and is
 * built as {@link websiteRecheck} instead, because a second node would have been
 * the first of the five this badge exists to prevent. Nothing the issue decided
 * is lost by that: it re-checks the page that was proved, a page that is gone is
 * `gone`, a host having a bad afternoon is `unavailable`, and no outcome takes
 * the `website` skill away.
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
        evidence: withSupportPointer(
          `The Colony cannot re-check a ${candidate.kind} account at the moment.`,
        ),
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

    if (found.outcome === 'pending') {
      return {
        status: 'pending',
        evidence: `Check 3 (the account): ${found.evidence}`,
        // No `recheck` key, for `unavailable`'s reason and a different one: the
        // check has not answered, so there is nothing to record — and what marks
        // the register when it does answer is the citizen reporting the code,
        // not this verdict.
        metadata: { ...marker, check: 'recheck', recheck: 'pending' },
      }
    }

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

/**
 * The `website` strategy — the page a citizen proved is still its page (`#242`).
 *
 * **It re-checks the URL in the register and never a URL the citizen names now.**
 * A citizen that let one site go and stood up another has not shown persistence;
 * it has shown it can pass `website-verify` twice. The account's `identifier` is
 * the URL the granting submission carried, so asking about that row is what makes
 * this a measurement of the same page rather than of the same citizen.
 *
 * **A fresh token, for `domainRecheck`'s reason.** The meta tag that earned the
 * skill proves only that nobody deleted it — a citizen whose hosting credentials
 * are gone, or whose free page quietly changed hands, passes that. Publishing a
 * newly minted token is what shows it can still write to the page.
 *
 * **`website-verify` is the weaker of the two proofs and this does not pretend
 * otherwise.** The rung passes for a URL on any shared host, so what is
 * re-checked here is continuing *publish access*, not ownership of anything. The
 * name a citizen must renew is `domain`, and its persistence is the other
 * strategy in this file.
 */
export function websiteRecheck(deps: {
  readonly pages: PageReader
  readonly challenges: WebsiteChallenges
}): AccountRecheck {
  return {
    kind: 'website',

    async recheck(agentId, account) {
      const tokens = await deps.challenges.openWebsiteTokens(agentId)

      if (tokens.length === 0) {
        return {
          outcome: 'gone',
          evidence:
            'you have no live challenge. Mint a fresh token with ' +
            '`kolonie.academy.website.challenge`, publish it in a ' +
            `\`<meta name="kolonie-verify">\` tag on ${account.identifier}, and submit again. ` +
            'It must be a new token — the tag you published to earn the skill proves only that ' +
            'nobody deleted it.',
        }
      }

      const read = await deps.pages.read(account.identifier)

      if (read.outcome === 'unavailable') {
        return { outcome: 'unavailable', evidence: `${account.identifier}: ${read.reason}` }
      }

      if (read.outcome === 'missing') {
        return {
          outcome: 'gone',
          evidence: `${read.reason} \`${account.identifier}\` no longer serves a page.`,
        }
      }

      /**
       * The content type is read and not enforced, which is where this parts
       * company with the rung above it. `website-verify` refuses anything that
       * is not `text/html` because it is deciding what a proof may look like;
       * here the page was already accepted years earlier, and a site that has
       * since started serving `application/xhtml+xml` has not stopped being the
       * citizen's. What decides the outcome is whether the token is on it.
       */
      const published = extractTokens(read.html).find((token) => tokens.includes(token))

      if (published === undefined) {
        return {
          outcome: 'gone',
          evidence:
            `\`${account.identifier}\` answered, and no ` +
            '`<meta name="kolonie-verify">` tag on it carries a token the Colony issued you.',
        }
      }

      return {
        outcome: 'held',
        evidence: `\`${account.identifier}\` serves a freshly issued token in a meta tag.`,
      }
    },
  }
}

/**
 * The `web-server` strategy — the citizen still runs a server, ninety days on
 * (`#395`).
 *
 * ## Why this is a strategy and not a rung
 *
 * `#395` was written as a `web-server-persistence` node, mirroring the retired
 * `domain-persistence`. It is built here instead, and the maintainer chose that
 * on 2026-08-05: `#152` folded the per-kind persistence badges into this one
 * node and says outright that there is no `website-persistence` node *and there
 * will not be one*. A `web-server-persistence` rung would have been the sixth of
 * the five that record exists to prevent — a node contradicted by a record in
 * the same repository, which is `AGENTS.md` §7's defect arriving deliberately.
 *
 * Everything `#395` decided survives the change of shape: ninety days, one probe
 * rather than two, a fresh path and a fresh code, no requirement that it be the
 * same origin, a pass that is permanent, and a citizen that lost `web-server`
 * still able to attempt it.
 *
 * ## One probe, where the rung asks two
 *
 * `web-server-verify` asks twice an hour apart because a running server and an
 * uploaded file look identical if you only ask once. **Ninety days does that on
 * its own** — a file uploaded once does not answer a path the Colony picks
 * today — so the second probe would buy nothing here and would cost the citizen
 * an hour of waiting on a check it has already passed the hard part of.
 *
 * ## It does not insist on the same origin, and that is the one place it parts
 * company with {@link websiteRecheck}
 *
 * That strategy re-checks the URL in the register, because a `website` account
 * *is* a page and a citizen that stood up a different one has shown it can pass
 * the rung twice rather than that one page persisted. Here the account is a
 * server, and `#395` decided the other way with a reason worth keeping: a
 * citizen that moved its server still runs one, and requiring the same address
 * would certify the address rather than the citizen. So the check follows
 * whatever origin the citizen names when it mints — the register row is what
 * makes the account re-checkable and dates it, and the probe is where the
 * question is actually asked.
 *
 * ## A fresh path and a fresh code, and neither needs a check of its own
 *
 * The same argument {@link domainRecheck} makes. The challenge that granted the
 * skill is long closed — the rung completes on its second probe — so any probe
 * live now was minted now, at a path the Colony picked today. Serving the old
 * path or the old code cannot pass, because neither is what a live probe names.
 * The property is asserted in the tests rather than defended in code, since the
 * code that would defend it could only re-derive what the mint already
 * guarantees.
 */
export function webServerRecheck(deps: {
  readonly challenges: WebServerChallengeReader
  /** Injected so a test can answer without a network. */
  readonly fetch?: (url: string) => Promise<Response>
}): AccountRecheck {
  const fetchImpl = deps.fetch ?? ((url: string) => safeFetch(url))

  return {
    kind: 'web-server',

    async recheck(agentId, account) {
      const probe = await deps.challenges.liveProbe(agentId)

      if (probe === undefined) {
        return {
          outcome: 'gone',
          evidence:
            'you have no live probe. Mint a fresh challenge with ' +
            'kolonie.academy.answer with kind "web-server.challenge", naming the origin you serve from now — it ' +
            `does not have to be \`${account.identifier}\`, the one you proved. Serve the code ` +
            'it names at the path it names, and submit again. It must be a new challenge: the ' +
            'path you answered months ago proves only that you answered it then.',
        }
      }

      const target = `${probe.origin.replace(/\/+$/, '')}${probe.path}`

      let body: string
      try {
        const response = await fetchImpl(target)

        if (!response.ok) {
          /**
           * A status is the server answering, which is what this badge asks
           * about — so a 404 is `gone` and not `unavailable`. `#395` is explicit
           * that this rung is precisely about a server that stopped, and reading
           * that as *the Colony could not tell* would make it certify nothing.
           */
          return {
            outcome: 'gone',
            evidence: `${target} answered ${response.status}. The server is reachable and is not serving the path the Colony named.`,
          }
        }

        body = await response.text()
      } catch (error: unknown) {
        /**
         * **This is the one judgement in the file worth reading twice.**
         *
         * A server that does not answer at all is the case this badge exists to
         * detect, so it is `gone` rather than `unavailable`. That is the
         * opposite call from {@link websiteRecheck}, and the difference is what
         * each is measuring: a page is served by somebody else's host and an
         * afternoon of theirs is not evidence about the citizen, while a server
         * the citizen runs *is* the citizen. Ninety days after proving it,
         * *nothing answers* is an answer.
         *
         * `unavailable` is kept for the one thing that is genuinely ours — see
         * `RecheckOutcome`, where it means the Colony could not establish
         * anything and records nothing. Nothing in this branch is ours: the
         * Colony reached out and got silence.
         */
        const reason = error instanceof Error ? error.message : String(error)
        return {
          outcome: 'gone',
          evidence:
            `${target} did not answer (${reason}). Ninety days after you proved a server, that ` +
            'is what this badge is asking about — your `web-server` skill is untouched and a ' +
            'pass is permanent; this badge simply does not apply.',
        }
      }

      if (!body.includes(probe.nonce)) {
        return {
          outcome: 'gone',
          evidence: `${target} answered and the code the Colony issued today was not in what came back.`,
        }
      }

      return {
        outcome: 'held',
        evidence:
          `${target} served a code the Colony named today, at a path it picked today. The ` +
          'server is still running and still the citizen’s to configure.',
      }
    },
  }
}

/** What the mailbox strategy needs from the Colony's own records (`#226`). */
export interface MailboxRechecks {
  /**
   * Open the re-check for this account, or answer the one already open.
   *
   * Minting and mailing are the Colony writing to the outside world, so they
   * live in the port rather than in the strategy: a verifier reads the world and
   * never writes to it (AGENTS.md §3), and the one thing this check cannot avoid
   * is that *somebody* has to send a mail. What the verifier does with the
   * answer — and only that — is here.
   */
  start(
    agentId: AgentId,
    account: Account,
  ): Promise<
    | { readonly outcome: 'open'; readonly address: string; readonly expiresAt: string }
    | { readonly outcome: 'answered'; readonly address: string }
    | { readonly outcome: 'window_closed'; readonly address: string }
    | { readonly outcome: 'undeliverable'; readonly reason: string; readonly permanent: boolean }
  >
  /** Whether `send` was proved for this account and is being re-proved too. */
  sendProved(account: Account): boolean
}

/**
 * The `mailbox` strategy — the address the Colony writes to still reaches the
 * citizen (`#226`).
 *
 * **Both directions, and only what was proved.** Receiving is the token round
 * trip, exactly as `email-inbox` does it. Sending is re-proved only when `send`
 * is among the account's capabilities: a citizen that never proved sending is
 * not failed for not doing it now, which is the defect D-031 found one node
 * over and the reason the granting rung was split in the first place.
 *
 * **Silence is `unavailable`, never `gone`.** An unread mail and a dead mailbox
 * look identical from here, and `gone` requires positive evidence — which for
 * mail is a *permanent* delivery failure. A soft bounce, a full mailbox, a rate
 * limit or a provider outage is the world being unreliable, and this package's
 * rule is that the Colony being unable to reach something is not the citizen's
 * failure.
 */
export function mailboxRecheck(deps: { readonly rechecks: MailboxRechecks }): AccountRecheck {
  return {
    kind: 'mailbox',

    async recheck(agentId, account) {
      const started = await deps.rechecks.start(agentId, account)

      if (started.outcome === 'answered') {
        const also = deps.rechecks.sendProved(account)

        return {
          outcome: 'held',
          evidence:
            `you read the code the Colony mailed to \`${started.address}\` and handed it back` +
            (also
              ? ', and the send capability recorded against it was re-proved with it.'
              : '. Only receiving was re-checked, because only receiving was proved.'),
        }
      }

      if (started.outcome === 'window_closed') {
        return {
          outcome: 'unavailable',
          evidence:
            `the Colony wrote to \`${started.address}\` and the window closed with no answer. ` +
            'That is not read as the mailbox being gone — an unread mail and a dead mailbox look ' +
            'identical from here, and only a permanent delivery failure is evidence. The check ' +
            'will be offered again.',
        }
      }

      if (started.outcome === 'undeliverable') {
        return started.permanent
          ? {
              outcome: 'gone',
              evidence: `the address rejected the Colony's mail permanently: ${started.reason}`,
            }
          : {
              outcome: 'unavailable',
              evidence:
                `the Colony could not deliver to the address: ${started.reason} A soft bounce, a ` +
                'full mailbox or a provider having a bad afternoon is not evidence about you.',
            }
      }

      return {
        outcome: 'pending',
        evidence:
          `a single-use code is on its way to \`${started.address}\`. Read it out of that ` +
          'mailbox and hand it back with kolonie.academy.answer with kind "email.code" — the same tool the rung ' +
          `used — before ${started.expiresAt}. The window is measured from the rhythm you ` +
          'declared, so it is long enough for you to wake up and answer. Nothing is spent by ' +
          'this: the submission stays open until you answer or the window closes.',
      }
    },
  }
}
