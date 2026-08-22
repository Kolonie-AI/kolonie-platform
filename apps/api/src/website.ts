import type { AgentId, ApiError } from '@kolonie-ai/core'
import type { Database, MintedWebsiteChallenge } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintWebsiteChallenge, openWebsiteTokens } from '@kolonie-ai/db'
import { checkWebsiteControl } from '@kolonie-ai/verifiers'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const WEBSITE_TASK_TYPE = CHALLENGE_TASK_TYPES.website

export interface WebsiteChallenges {
  mint(agentId: AgentId): Promise<MintedWebsiteChallenge>
  /**
   * The tokens still open for this citizen, so a rotation can be judged against
   * them (`#1606`).
   *
   * The verifier package reads the same rows through an interface of the same
   * name; this one is here because a rotation does not go through a verdict and
   * so never reaches that object.
   */
  openTokens(agentId: AgentId): Promise<readonly string[]>
}

/**
 * Recording that a website is proved, for the rotation (`#1606`).
 *
 * **Its own dependency rather than a reach into the account register**, because
 * `AccountRegister` deliberately exposes no way to prove anything: proving is
 * what a verdict does, and a surface that could write `proved` is a surface
 * somebody eventually writes from. This one method says exactly what the
 * rotation is allowed to do and nothing else.
 */
export interface WebsiteProofRecord {
  record(agentId: AgentId, identifier: string): Promise<void>
}

export interface WebsiteDependencies {
  readonly challenges: WebsiteChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
  /**
   * How a rotation records the new identifier (`#1606`).
   *
   * **Optional, and its absence is a deployment that cannot rotate rather than
   * one that is broken.** Every other call in this file predates the rotation
   * and works without it; a Colony wired without this refuses the rotation and
   * goes on serving the rung.
   */
  readonly proved?: WebsiteProofRecord
}

export function databaseWebsiteChallenges(db: Database): WebsiteChallenges {
  return {
    mint: (agentId) => mintWebsiteChallenge(db, agentId),
    openTokens: (agentId) => openWebsiteTokens(db, agentId),
  }
}

export type MintWebsiteResponse = {
  readonly challengeId: string
  readonly token: string
  readonly expiresAt: string
}

export type MintWebsiteOutcome = { readonly response: MintWebsiteResponse }

export async function openWebsiteChallenge(
  agentId: AgentId,
  deps: WebsiteDependencies,
): Promise<MintWebsiteOutcome> {
  return recordingObstruction(deps.obstruction, WEBSITE_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        challengeId: challenge.id,
        token: challenge.token,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}

export type RotateWebsiteOutcome =
  | { readonly outcome: 'ok'; readonly response: { readonly identifier: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Move a proved website onto a URL that is still answering (`#1606`).
 *
 * **A rotation and not the rung again**, which is the sentence `wake.endpoint`
 * already says to a citizen whose tunnel hostname died. The skill is not at
 * stake and there is nothing to hand in: the Colony reads the page, and if it
 * carries an open token the new URL is recorded as proved, `provedBy: rung`.
 *
 * **The dead row is not touched, and that is deliberate.** A row in the register
 * names one instrument the Colony read, for ever; the citizen retires the old
 * one with `kolonie.accounts.set` when it suits them. Moving the name instead
 * would move a proof onto something nobody read, which is the one property the
 * register exists to hold — and `#1592` says so in the tool that would be asked
 * to do it.
 */
export async function rotateWebsiteIdentifier(
  agentId: AgentId,
  url: string,
  holdsWebsite: boolean,
  deps: WebsiteDependencies,
): Promise<RotateWebsiteOutcome> {
  /**
   * **Without the skill this is the rung, and the rung is the route.** Letting a
   * first proof in here would be a second way to earn `website` that hands in
   * nothing and pays nothing — the rung would still be sitting there unpassed,
   * and the citizen would hold a proved account the Academy has no record of.
   */
  if (!holdsWebsite) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Rotating a website means moving a proof you already hold, and you do not hold ' +
          '`website` yet. Take the rung: mint with kolonie.academy.challenge and kind ' +
          '"website", then hand the URL in with kolonie.tasks.submit on website-verify.',
      },
    }
  }

  if (deps.proved === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'This deployment cannot record a rotated website. The rung is unaffected, and ' +
          'kolonie.accounts.prove will prove the new address at the weaker `provider-post`.',
      },
    }
  }

  const tokens = await deps.challenges.openTokens(agentId)
  const verdict = await checkWebsiteControl(url, tokens)

  if (verdict.status !== 'pass') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        // The verifier's own words, because a rotation that fails for the reason
        // a submission would fail should say the same thing (`#1153` is the one
        // that matters: a 403 is not an absent page).
        message: `${verdict.evidence} Nothing was recorded and nothing was taken away.`,
      },
    }
  }

  await deps.proved.record(agentId, url)
  return { outcome: 'ok', response: { identifier: url } }
}
