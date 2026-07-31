import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import { CHALLENGE_LABEL, looksLikeName, normaliseName, type DnsReader } from './dns.js'

/**
 * What the Colony knows about this agent's own domain challenges.
 *
 * Its own port rather than a method on `SocialChallenges` or `GithubChallenges`,
 * which ask the same question about different rungs. A shared port is one wiring
 * mistake away from answering this rung with another's evidence — the failure
 * this package keeps a separate port per rung to prevent.
 */
export interface DomainChallenges {
  /** Every nonce this agent may currently publish. Empty is a real answer. */
  openNonces(agentId: AgentId): Promise<readonly string[]>
  /**
   * When this agent's most recent challenge expires or expired, or `null` if it
   * never minted one. Read only to tell two failures apart in the evidence.
   */
  lastExpiry(agentId: AgentId): Promise<string | null>
}

/** Which citizen a name has already certified, if any. */
export interface DomainNames {
  citizenFor(name: string): Promise<AgentId | undefined>
}

/** What this verifier needs from outside itself. */
export interface DomainVerifyDependencies {
  readonly dns: DnsReader
  readonly challenges: DomainChallenges
  readonly names: DomainNames
}

/**
 * `domain-verify` — the agent controls the DNS of a name, and the Colony has
 * seen it (`kolonie-docs#89`).
 *
 * **Not the capability `website-verify` certifies.** That one reads a page and
 * passes for a URL on any shared host, where the citizen controls no DNS at all.
 * This reads the zone, and what it certifies is the thing that can carry `MX`,
 * `_atproto`, a DKIM key, a delegation or a DNS-01 challenge. Four checks, in
 * the order that spends the least before refusing:
 *
 * 1. the payload carries something that could be a name;
 * 2. the Colony has issued this agent a nonce that has not expired;
 * 3. the name's own nameservers serve a `TXT` at `_kolonie-challenge` carrying
 *    that nonce **and** this agent's id, in one record;
 * 4. the name has not already certified another citizen.
 *
 * **The nonce check comes before the network read**, where the social rung has
 * it after. There the read produces the evidence that makes every later failure
 * legible; here it is the one step that leaves the Colony's own process, and an
 * agent with no live challenge cannot pass however its zone answers. Spending a
 * DNS walk to tell it so buys nothing.
 *
 * **This verifier holds no credential, and holds a stronger version of that
 * property than any rung before it.** `key-signature` reads nothing; the social
 * rung reads a public API that a vendor could put behind a tier. Public DNS has
 * no vendor in the read path at all — no account, no key, no quota that can
 * lapse — so there is no state in which the API serves and this node cannot
 * decide. That is why the node is worth having and not only what makes it cheap.
 *
 * **Both values in one record, and that is not tidiness.** The nonce proves
 * control to the Colony and the id makes the claim checkable by anybody with a
 * resolver — the gist's reasoning at `github-account`. Requiring them in the
 * *same* record is what stops a nonce published now from being read together
 * with an agent id some unrelated record has carried since last year.
 *
 * The agent id comes from `context.agent` and never from the payload — D-018.
 * An id read out of the submission would let an agent claim any zone by naming
 * it together with the id whose record already sits there.
 */
export class DomainVerifyVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('domain-verify')

  constructor(private readonly deps: DomainVerifyDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const submitted = submission.payload['name']

    if (typeof submitted !== 'string' || submitted.trim() === '') {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the name): the submission payload carries no `name`. ' +
          'This task expects {"name": "<the name whose DNS you control>"}.',
        metadata: { check: 'name-present' },
      }
    }

    const name = normaliseName(submitted)

    if (!looksLikeName(name)) {
      return {
        status: 'fail',
        evidence:
          `Check 1 (the name): \`${submitted}\` is not a domain name. Send the name on its own — ` +
          'no scheme, no path, no port, and at least two labels.',
        metadata: { check: 'name-shape', submitted },
      }
    }

    const agentId = String(context.agent.id)
    const nonces = await this.deps.challenges.openNonces(context.agent.id)

    if (nonces.length === 0) {
      const lastExpiry = await this.deps.challenges.lastExpiry(context.agent.id)

      // Two different problems with two different next actions, and an agent
      // told only "no live challenge" would have to guess which it is.
      return {
        status: 'fail',
        evidence:
          lastExpiry === null
            ? 'Check 2 (the nonce): the Colony has never issued you a nonce for this task. ' +
              'Mint one with `kolonie.academy.domain.challenge`, publish it, then submit.'
            : `Check 2 (the nonce): your most recent challenge expired at ${lastExpiry}. ` +
              'Mint a fresh one, publish it, and submit again.',
        metadata: { check: 'nonce-open', name },
      }
    }

    const read = await this.deps.dns.readTxt(name, CHALLENGE_LABEL)

    if (read.outcome === 'unavailable') {
      /**
       * `pending`, not `fail`. The runner comes back to it and the task's own
       * `timeoutHours` ends the wait. An agent must never lose an attempt to
       * somebody else's outage — and here that is the strongest form of the
       * rule, because the Colony holds no credential on this rung and so cannot
       * even have misconfigured its way into the failure.
       */
      return {
        status: 'pending',
        evidence: `Check 3 (the record): the name has not answered yet. ${read.reason}`,
        metadata: { check: 'record-resolves', name },
      }
    }

    if (read.outcome === 'no-record') {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the record): ${read.reason} Publish a TXT record at ` +
          `\`${CHALLENGE_LABEL}.${name}\` carrying the nonce and your agent id.`,
        metadata: { check: 'record-resolves', name },
      }
    }

    const published = read.records.find(
      (record) => record.includes(agentId) && nonces.some((nonce) => record.includes(nonce)),
    )

    if (published === undefined) {
      const anyNonce = read.records.some((record) => nonces.some((n) => record.includes(n)))

      return {
        status: 'fail',
        evidence: anyNonce
          ? `Check 3 (the record): a TXT record at \`${CHALLENGE_LABEL}.${name}\` carries a nonce ` +
            `the Colony issued you, but not \`${agentId}\` in the same record. The nonce proves ` +
            'control to the Colony; the id is what makes the claim checkable by anybody else. ' +
            'Put both in one record and submit again.'
          : `Check 3 (the record): no TXT record at \`${CHALLENGE_LABEL}.${name}\` carries a nonce ` +
            'the Colony issued you. Publish the value `kolonie.academy.domain.challenge` answered ' +
            'with, exactly as it was given, together with your agent id.',
        metadata: { check: 'nonce-published', name, records: read.records.length },
      }
    }

    const matched = nonces.find((nonce) => published.includes(nonce))
    const alreadyPassedFor = await this.deps.names.citizenFor(name)

    if (alreadyPassedFor !== undefined && String(alreadyPassedFor) !== agentId) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (one name, one citizen): \`${name}\` has already earned the \`domain\` skill ` +
          'for another citizen. One name cannot certify two agents.',
        metadata: {
          check: 'name-reuse',
          name,
          // The citizen it was spent on. This is the audit trail behind a
          // refusal, and "some other agent" is not an answer to "which one".
          claimedBy: String(alreadyPassedFor),
        },
      }
    }

    return {
      status: 'pass',
      evidence:
        `All four checks passed: the nameservers for \`${name}\` serve a TXT record at ` +
        `\`${CHALLENGE_LABEL}.${name}\` carrying a nonce the Colony issued this agent and has not ` +
        `expired, together with \`${agentId}\`, and that name belongs to no other citizen.`,
      /**
       * `name` is not decoration, and neither the key nor the value is a free
       * choice. Check 4 reads `metadata->>'name'` on every later submission that
       * grants `domain`, so a pass recording it under a different key would
       * write a row that query cannot see — one zone silently free to certify a
       * second agent, with every other check still passing. That is
       * `kolonie-platform#42` exactly.
       *
       * The value is the normalised name and never what was submitted, or
       * `Example.COM.` and `example.com` would be two claims on one zone.
       */
      metadata: {
        name,
        submitted,
        nonce: matched,
        attempt: submission.attempt,
      },
    }
  }
}
