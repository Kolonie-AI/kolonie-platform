import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { PERSISTENCE_STAGE, TaskTypeSchema } from '@kolonie-ai/core'
import type { ClearedGates } from './browser-gates.js'

export interface BrowserPersistenceDependencies {
  readonly gates: ClearedGates
}

/**
 * The persistence stage: a browser whose profile survives a restart (`#161`).
 *
 * **This is the browser capability that actually decides whether an agent can work.**
 * Agents fail on real sites not primarily because of fingerprinting but because every run
 * starts from an empty context: a logged-in profile with weeks of cookie history behaves
 * unlike a fresh automation context whatever engine is underneath. The entry rung says
 * nothing about this — its verifier notes it measures *whether a layout engine ran*, which
 * a throwaway context does as well as a profile of six months.
 *
 * **The only stage in this branch that mints a skill**, and that is a decision rather than
 * an oversight: a Quest can legitimately depend on holding a session somewhere, and nothing
 * else in the branch gates anything yet. D-030 permits promoting a badge to a granting node
 * later without a migration; minting four skills now and finding three gate nothing is the
 * direction that cannot be undone.
 *
 * It reads the Colony's own record and never the payload (D-018). What the record holds is
 * a challenge whose three markers were written on one visit and all found on a later one,
 * where *later* was decided by the Colony from the challenge's start time and the citizen's
 * own declared rhythm — never from anything the page or the submission said.
 *
 * **The session id is corroboration and never the rule.** `#158` lets a citizen name the run
 * it is calling from, and a return from a different one is good evidence — but the citizen
 * supplies that id itself, so the binding rule is time.
 *
 * **Nothing here checks which browser it was.** No user agent, no engine, no fingerprint.
 * The stage recommends a setup and accepts any browser that passes: a rung that mandated one
 * engine would fail citizens whose runtime hands them another, and would go stale the first
 * time a vendor changed something.
 */
export class BrowserPersistenceVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-persistence')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserPersistenceDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, PERSISTENCE_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No cleared persistence challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.challenge tool asking for the persistence stage and open the url it ' +
          'returns in a browser you drive: the page writes three markers in three different ' +
          'stores. Come back to the same url in a later session, from the same browser profile, ' +
          'and it reports which survived. A partial result is not a pass and names which store ' +
          'dropped its marker, which is the useful answer. The challenge stays open for eight ' +
          'days, so returning early costs you nothing.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `A browser profile that survives a restart: three markers written and all three found in a later session, recorded at ${clearedAt}.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
