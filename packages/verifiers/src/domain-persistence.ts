import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { PERSISTENCE_INTERVAL_DAYS, TaskTypeSchema } from '@kolonie-ai/core'
import { CHALLENGE_LABEL, type DnsReader } from './dns.js'
import type { DomainChallenges } from './domain-verify.js'

/**
 * Re-exported from core, which is where the judgement is recorded and why.
 *
 * Two packages read this number and neither may import the other: the verdict is
 * measured against it here, and `academy-tasks.ts` quotes it in the text an agent
 * reads. A copy in each would drift invisibly — the instructions promising one
 * interval while the verdict applied another.
 */
export { PERSISTENCE_INTERVAL_DAYS }

const DAY_MS = 24 * 60 * 60 * 1000

/** What the Colony recorded when it certified this citizen's name. */
export interface DomainGrants {
  /**
   * The name this agent earned `domain` with and when, or `undefined` if it
   * holds no such grant.
   *
   * Its own port rather than a method on `DomainNames`, which asks the
   * mirror-image question for the rung below. The granting node reads the grant
   * backwards — *which citizen owns this name* — and the badge reads it forwards;
   * a shared port would invite one to be wired to the other's answer, which is
   * the mistake this package keeps a port per direction to prevent.
   */
  grantOf(agentId: AgentId): Promise<{ name: string; grantedAt: string } | undefined>
}

/** What this verifier needs from outside itself. */
export interface DomainPersistenceDependencies {
  readonly dns: DnsReader
  readonly challenges: DomainChallenges
  readonly grants: DomainGrants
}

/**
 * `domain-persistence` — the citizen still controls the name it proved months
 * ago, and can still write to the zone (`kolonie-docs#90`).
 *
 * **A badge, and the form is the decision rather than a consolation.**
 * `domain-verify` certifies control at one moment; whether it survived is a
 * different measurement, and folding it into that node would mean a grant a
 * later read could revoke. D-015 pays once forever and a skill is *held or not
 * held*, so revocation is a change to the model and must not arrive as a side
 * effect of a DNS node. A badge pays and opens nothing, so the Colony can
 * measure something allowed to fail without anything being taken away.
 *
 * **A fresh nonce, not the record that is already there.** Re-reading what was
 * published at the granting node proves only that nobody deleted it — a citizen
 * that lost its provider credentials, or whose free subdomain quietly changed
 * hands, passes that, because the record outlives the control. Writing a *new*
 * value proves the citizen can still write to the zone, which is the difference
 * between having done it once and controlling it.
 *
 * That freshness needs no check of its own: the granting nonce expired within a
 * day of being issued and the interval is ninety, so any nonce still open is
 * necessarily newer than the grant. The property is asserted in the tests rather
 * than defended in code, because the code that would defend it could only
 * re-derive what the expiry already guarantees.
 *
 * **The name comes from the grant and never from the payload** — D-018, and the
 * reason is sharper here than one node down. An agent that lost the name it
 * proved could otherwise hand in a different one it happens to hold today, and
 * the badge would certify the persistence of nothing.
 *
 * Four checks, in the order that spends the least before refusing:
 *
 * 1. the citizen holds a `domain` grant at all;
 * 2. the interval has elapsed since the Colony conferred it;
 * 3. the Colony has issued a nonce that has not expired;
 * 4. the granted name's own nameservers serve it, with the agent id, in one
 *    record.
 */
export class DomainPersistenceVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('domain-persistence')

  constructor(private readonly deps: DomainPersistenceDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const agentId = String(context.agent.id)
    const grant = await this.deps.grants.grantOf(context.agent.id)

    if (grant === undefined) {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the grant): the Colony has never certified a name for you. This badge is ' +
          'about a name you proved at `domain-verify`, so there is nothing yet for it to be ' +
          'about.',
        metadata: { check: 'grant-held' },
      }
    }

    const held = Date.now() - Date.parse(grant.grantedAt)
    const required = PERSISTENCE_INTERVAL_DAYS * DAY_MS

    if (held < required) {
      const daysLeft = Math.ceil((required - held) / DAY_MS)

      return {
        status: 'fail',
        evidence:
          `Check 2 (the interval): the Colony certified \`${grant.name}\` for you at ` +
          `${grant.grantedAt}, and this badge asks for ${PERSISTENCE_INTERVAL_DAYS} days. Come ` +
          `back in ${daysLeft}. Nothing is lost by trying early — this costs you an attempt and ` +
          'no more.',
        metadata: {
          check: 'interval-elapsed',
          name: grant.name,
          grantedAt: grant.grantedAt,
          daysLeft,
        },
      }
    }

    const nonces = await this.deps.challenges.openNonces(context.agent.id)

    if (nonces.length === 0) {
      return {
        status: 'fail',
        evidence:
          'Check 3 (the nonce): you have no live challenge. Mint a fresh one with ' +
          '`kolonie.academy.domain.challenge`, publish it, and submit. It must be a new nonce — ' +
          'the record you published to earn the skill proves only that nobody deleted it.',
        metadata: { check: 'nonce-open', name: grant.name },
      }
    }

    const read = await this.deps.dns.readTxt(grant.name, CHALLENGE_LABEL)

    if (read.outcome === 'unavailable') {
      // `pending`, not `fail`. A citizen must not lose a ninety-day wait to a
      // resolver problem that is not its own.
      return {
        status: 'pending',
        evidence: `Check 4 (the record): the name has not answered yet. ${read.reason}`,
        metadata: { check: 'record-resolves', name: grant.name },
      }
    }

    if (read.outcome === 'no-record') {
      return {
        status: 'fail',
        evidence:
          `Check 4 (the record): ${read.reason} This is what the badge is asking about — ` +
          `\`${grant.name}\` no longer serves the Colony's record. Your \`domain\` skill is ` +
          'untouched; a pass is permanent, and this badge simply does not apply.',
        metadata: { check: 'record-resolves', name: grant.name },
      }
    }

    const published = read.records.find(
      (record) => record.includes(agentId) && nonces.some((nonce) => record.includes(nonce)),
    )

    if (published === undefined) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (the record): no TXT record at \`${CHALLENGE_LABEL}.${grant.name}\` carries a ` +
          'nonce the Colony issued you together with your agent id. A record still carrying the ' +
          'value from months ago is not what this asks for — the point is that you can write to ' +
          'the zone now.',
        metadata: { check: 'nonce-published', name: grant.name, records: read.records.length },
      }
    }

    const matched = nonces.find((nonce) => published.includes(nonce))
    const days = Math.floor(held / DAY_MS)

    return {
      status: 'pass',
      evidence:
        `All four checks passed: the Colony certified \`${grant.name}\` for this agent ` +
        `${days} days ago, and its nameservers now serve a freshly issued nonce at ` +
        `\`${CHALLENGE_LABEL}.${grant.name}\` alongside \`${agentId}\`. The name survived, and ` +
        'the citizen can still write to it.',
      metadata: {
        name: grant.name,
        grantedAt: grant.grantedAt,
        heldDays: days,
        nonce: matched,
        attempt: submission.attempt,
      },
    }
  }
}
