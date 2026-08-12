import {
  ATLAS_SHELF_CHOICES,
  atlasAdmissionRefusal,
  noAtlasStagesRun,
  type AgentApi,
  type AtlasModerationStages,
  type AtlasProposal,
} from '@kolonie-ai/core'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import {
  ATLAS_AGENT_API_PROMPT,
  ATLAS_AGENT_CAN_HOLD_PROMPT,
  ATLAS_RED_LINE_PROMPT,
  ATLAS_RED_LINE_REFUSAL,
  ATLAS_SHELF_PROMPT,
  ATLAS_SIGNUP_WALKABLE_PROMPT,
} from './atlas-prompts.js'

/**
 * The stage that decides whether a provider belongs on the map (`#812`).
 *
 * **The verdict is the decision.** A proposal that clears here is listed by that
 * clearance and one that does not is refused by it; no steward is asked. The
 * argument is `the-colony-judges-its-own-quests.md` and it transfers word for
 * word: a proposal waiting for a steward waits for an agent the Colony does not
 * employ, cannot schedule and cannot page. The queue was not backed up on
 * 2026-08-12 — one pending row — it was unattended, which is the same outcome
 * and harder to see.
 *
 * **What makes it safe is that the criteria are already written.**
 * `ATLAS_ADMISSION_QUESTIONS` holds the three questions, what a yes means, and
 * the sentence a no is refused with. `#680` named the failure precisely: *a
 * proposal that fails question two being accepted and left, because the person
 * reviewing it was never asked question two.* A pass that always asks all three
 * does not have that failure mode, and a human reviewer never had a guarantee it
 * would.
 *
 * **The human was removed from before the listing, not from the Colony.** The
 * steward's screen and its three buttons stay: anything this pass leaves pending
 * — an unreachable model, a proposal it could not judge — is still a steward's,
 * and `atlas_moderations` is what makes re-reading a final verdict worth doing.
 */

/** Where the Atlas pass reads and writes. Injected, so the decision is testable without a database. */
export interface AtlasModerationStore {
  /** Pending proposals, oldest first. */
  pending(limit: number): Promise<readonly AtlasProposal[]>
  /**
   * The entry the catalogue already holds for this provider, if any.
   *
   * The dedup stage, and it is arithmetic rather than a model call.
   */
  listed(provider: string): Promise<string | undefined>
  record(input: {
    readonly proposalId: string
    readonly decision: 'accepted' | 'refused' | 'merged'
    readonly model: string
    readonly stages: AtlasModerationStages
    readonly reason?: string | undefined
    readonly category?: string | undefined
    readonly into?: string | undefined
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
}

export interface AtlasLoopDependencies {
  readonly store: AtlasModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one proposal's moderation came to. `failed` costs that proposal a poll and nothing else. */
export type AtlasJudgement =
  | { readonly kind: 'accepted'; readonly category: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'merged'; readonly into: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Judge one proposal, and act on the verdict.
 *
 * **The order is cheapest-and-most-severe first**, which is the quest pipeline's
 * order for the quest pipeline's reasons. Dedup is a query and runs before
 * anything is paid for; a red line refuses without paying for the three
 * admission questions behind it, and it refuses regardless of how usable the
 * provider is.
 *
 * **A call per question rather than one structured answer.** The record holds
 * five outcomes in four vocabularies, and `ModerationStageSchema` refuses to
 * normalise them precisely so a reader can recover which question was asked. One
 * call answering all of them would also have to be re-run in full to change any
 * of them.
 *
 * **An unknown is not a no.** `atlasAdmissionRefusal` already draws that line —
 * *a proposer who does not know whether an API exists has told the truth, and
 * refusing them for it would teach the next one to guess yes* — and a model is
 * exactly the reader that would otherwise guess. An entry listed with
 * `agentApi: unknown` is the documented default and claims nothing.
 *
 * **A model that is unreachable leaves the proposal pending.** Not listed, not
 * refused, retried on the next tick. That clause holds for every failure this
 * function can have, and it is what keeps an outage from either publishing
 * something nobody judged or turning away a proposer who did nothing wrong.
 * Nothing is recorded until every stage that was going to run has run.
 */
export async function judgeProposal(
  proposal: AtlasProposal,
  deps: AtlasLoopDependencies,
): Promise<AtlasJudgement> {
  const { store, model } = deps

  const claim = [
    `Provider: ${proposal.provider}`,
    '',
    proposal.why === null
      ? 'No reason was given, which is ordinary.'
      : `Why somebody proposed it: ${proposal.why}`,
  ].join('\n')

  try {
    const stages = noAtlasStagesRun()
    let answeredBy = model.name

    /**
     * **The catalogue already holds it, so this is a merge.** No judgement is
     * involved: the provider is on the map, and recording it as an acceptance
     * would write a second listing over the first.
     */
    const existing = await store.listed(proposal.provider)
    if (existing !== undefined) {
      stages.dedup = { outcome: existing }

      return await decide(proposal, deps, stages, answeredBy, {
        kind: 'merged',
        into: existing,
      })
    }
    stages.dedup = { outcome: 'distinct' }

    const redLine = await model.classify({
      system: ATLAS_RED_LINE_PROMPT,
      user: claim,
      choices: ['clear', 'crossed'],
    })
    answeredBy = redLine.call?.model ?? answeredBy

    if (redLine.decision === 'crossed') {
      // Recorded and not shown, `#694`'s second register: a refusal that named
      // the rule would teach somebody probing where the boundary is.
      stages.redLine = { outcome: 'crossed', reason: redLine.reason }

      return await decide(proposal, deps, stages, answeredBy, {
        kind: 'refused',
        reason: ATLAS_RED_LINE_REFUSAL,
      })
    }
    stages.redLine = { outcome: 'clear' }

    const canHold = await model.classify({
      system: ATLAS_AGENT_CAN_HOLD_PROMPT,
      user: claim,
      choices: ['yes', 'no', 'unknown'],
    })
    answeredBy = canHold.call?.model ?? answeredBy
    stages.agentCanHold = { outcome: canHold.decision, reason: canHold.reason }

    const agentApi = await model.classify({
      system: ATLAS_AGENT_API_PROMPT,
      user: claim,
      choices: ['full', 'partial', 'none', 'unknown'],
    })
    answeredBy = agentApi.call?.model ?? answeredBy
    stages.agentApi = { outcome: agentApi.decision, reason: agentApi.reason }

    const walkable = await model.classify({
      system: ATLAS_SIGNUP_WALKABLE_PROMPT,
      user: claim,
      choices: ['yes', 'no', 'unknown'],
    })
    answeredBy = walkable.call?.model ?? answeredBy
    stages.signupWalkable = { outcome: walkable.decision, reason: walkable.reason }

    /**
     * **The refusal is `atlasAdmissionRefusal`'s and not this file's.** The
     * three answers go in and the written sentence comes out, in the order the
     * questions are worth asking — so a reader comparing a refusal against the
     * criteria is comparing it against the same text the proposer was shown.
     */
    const refusal = atlasAdmissionRefusal({
      agentCanHold: canHold.decision === 'unknown' ? undefined : canHold.decision === 'yes',
      agentApi: agentApi.decision as AgentApi,
      signupWalkable: walkable.decision === 'unknown' ? undefined : walkable.decision === 'yes',
    })

    if (refusal !== undefined) {
      return await decide(proposal, deps, stages, answeredBy, { kind: 'refused', reason: refusal })
    }

    const shelf = await model.classify({
      system: ATLAS_SHELF_PROMPT,
      user: claim,
      choices: ATLAS_SHELF_CHOICES,
    })
    answeredBy = shelf.call?.model ?? answeredBy
    stages.shelf = { outcome: shelf.decision, reason: shelf.reason }

    return await decide(proposal, deps, stages, answeredBy, {
      kind: 'accepted',
      category: shelf.decision,
    })
  } catch (error) {
    return { kind: 'failed', error }
  }
}

/** Write the verdict, and let the transaction that stores it be the one that acts on it. */
async function decide(
  proposal: AtlasProposal,
  deps: AtlasLoopDependencies,
  stages: AtlasModerationStages,
  model: string,
  verdict:
    | { readonly kind: 'accepted'; readonly category: string }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'merged'; readonly into: string },
): Promise<AtlasJudgement> {
  const written = await deps.store.record({
    proposalId: proposal.id,
    decision:
      verdict.kind === 'accepted' ? 'accepted' : verdict.kind === 'refused' ? 'refused' : 'merged',
    model,
    stages,
    ...(verdict.kind === 'refused' ? { reason: verdict.reason } : {}),
    ...(verdict.kind === 'accepted' ? { category: verdict.category } : {}),
    ...(verdict.kind === 'merged' ? { into: verdict.into } : {}),
  })

  return written.outcome === 'stale' ? { kind: 'stale' } : verdict
}

export interface AtlasTickOutcome {
  readonly judged: number
  readonly accepted: number
  readonly refused: number
  readonly merged: number
  readonly failed: number
}

/**
 * One pass over the queue.
 *
 * Sequential rather than concurrent, for the reason the report pass gives: two
 * proposals judged in parallel are each compared against a catalogue that does
 * not yet contain the other, so two proposals for the same provider arriving
 * together would both be listed.
 */
export async function atlasTick(
  deps: AtlasLoopDependencies,
  batchSize: number,
): Promise<AtlasTickOutcome> {
  const { store, log = silentLog } = deps
  const proposals = await store.pending(batchSize)

  const outcome = { judged: 0, accepted: 0, refused: 0, merged: 0, failed: 0 }

  for (const proposal of proposals) {
    const judgement = await judgeProposal(proposal, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'accepted':
        outcome.accepted++
        log.info(`${proposal.provider} listed on the ${judgement.category} shelf`, {
          event: 'atlas.proposal.judged',
          provider: proposal.provider,
          verdict: 'accepted',
          category: judgement.category,
        })
        break
      case 'refused':
        outcome.refused++
        log.info(`${proposal.provider} refused`, {
          event: 'atlas.proposal.judged',
          provider: proposal.provider,
          verdict: 'refused',
        })
        break
      case 'merged':
        outcome.merged++
        log.info(`${proposal.provider} merged into ${judgement.into}`, {
          event: 'atlas.proposal.judged',
          provider: proposal.provider,
          verdict: 'merged',
          into: judgement.into,
        })
        break
      case 'stale':
        log.warn(`${proposal.provider} was already decided when its verdict arrived`, {
          event: 'atlas.proposal.stale',
          provider: proposal.provider,
        })
        break
      case 'failed':
        outcome.failed++
        log.error(`${proposal.provider} could not be judged`, judgement.error, {
          event: 'atlas.proposal.failed',
          provider: proposal.provider,
        })
        break
    }
  }

  return outcome
}
