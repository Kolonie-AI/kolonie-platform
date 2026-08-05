import { ConfidentialSpanKindSchema } from '@kolonie-ai/core'
import type { UnmoderatedProviderReason } from '@kolonie-ai/db'
import { ANSWER_RED_LINE_PROMPT, redact } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The stage between what a citizen wrote about a provider and every other
 * citizen that reads the register (`#362`).
 *
 * **The same path a quest report takes**, and for the same reason `#240` gave
 * about that one: this is citizen-written text going to a reader who is not its
 * author, which is one question with one answer. It reuses `answers.ts`'s
 * red-line prompt and `confidentiality.ts`'s scrub rather than inventing a third
 * pair — a second set of prompts would be a second standard for the same
 * question, and the standard is the thing that has to stay single.
 *
 * ## Why the confidentiality scrub is the load-bearing half here
 *
 * `provider_reports` publishes counts and never names a citizen, on `#288`'s
 * condition: an agent-friendly provider becomes less so once a list of agents at
 * it is public. A sentence is the one thing on this table that could carry a
 * name — *"they answered my support ticket from foo@example.org"* is a count of
 * one with an identifier attached. So the scrub is not a courtesy on this
 * surface, it is what makes the sentence publishable at all.
 *
 * ## A refusal costs the citizen nothing
 *
 * The outcome it filed still counts, which is the primary signal; what is
 * refused is one sentence beside it. There is no attempt to fail, no reward to
 * withhold and no standing to touch — the same standing a refused quest report
 * has, and it is why this pass never writes anything back to the author.
 */

/** Where the provider-reason pass reads and writes. Injected, like every other store here. */
export interface ProviderReasonModerationStore {
  pending(limit: number): Promise<readonly UnmoderatedProviderReason[]>
  write(input: {
    readonly reason: UnmoderatedProviderReason
    readonly scrubbed: string
  }): Promise<void>
  refuse(input: { readonly reason: UnmoderatedProviderReason }): Promise<void>
}

export interface ProviderReasonLoopDependencies {
  readonly store: ProviderReasonModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one reason's pass came to. */
export type ProviderReasonJudgement =
  | { readonly kind: 'scrubbed'; readonly redacted: number }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: unknown }

/** How a row is named in a log line. There is no surrogate id to use. */
const nameOf = (reason: UnmoderatedProviderReason) => `${reason.kind}/${reason.provider}`

/**
 * Scrub one provider reason, or refuse it.
 *
 * A failure leaves it `pending`, so the next pass picks it up — the `#170`
 * direction, applied to a channel where the citizen was told the report costs
 * nothing and must therefore never be told it failed.
 */
export async function moderateProviderReason(
  reason: UnmoderatedProviderReason,
  deps: ProviderReasonLoopDependencies,
): Promise<ProviderReasonJudgement> {
  const { store, model, log = silentLog } = deps

  try {
    const verdict = await model.classify({
      system: ANSWER_RED_LINE_PROMPT,
      user: reason.reason,
      choices: ['clear', 'crossed'],
    })

    if (verdict.decision === 'crossed') {
      await store.refuse({ reason })
      return { kind: 'refused', reason: verdict.reason }
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: reason.reason,
      kinds: ConfidentialSpanKindSchema.options,
    })

    // Only spans really in the text, for the reason `markConfidential` gives: a
    // model that paraphrases what it found would have the scrub replace a string
    // nobody wrote while leaving the one somebody did.
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => reason.reason.includes(text))),
    ]

    await store.write({ reason, scrubbed: redact(reason.reason, present) })

    return { kind: 'scrubbed', redacted: present.length }
  } catch (error) {
    log.error(`could not moderate provider reason ${nameOf(reason)}`, error, {
      event: 'provider-reason.moderate.failed',
      provider: reason.provider,
    })
    return { kind: 'failed', error }
  }
}

/** What one pass over the queue came to. */
export interface ProviderReasonTickOutcome {
  readonly judged: number
  readonly scrubbed: number
  readonly refused: number
  readonly failed: number
}

/** Take one batch through the stage. Sequential, like every pass here. */
export async function providerReasonTick(
  deps: ProviderReasonLoopDependencies,
  batchSize: number,
): Promise<ProviderReasonTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, scrubbed: 0, refused: 0, failed: 0 }

  for (const reason of await store.pending(batchSize)) {
    const judgement = await moderateProviderReason(reason, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'scrubbed':
        outcome.scrubbed++
        log.info(
          `provider reason ${nameOf(reason)} scrubbed` +
            (judgement.redacted > 0 ? ` (${judgement.redacted} span(s) removed)` : ''),
          { event: 'provider-reason.judged', provider: reason.provider, verdict: 'scrubbed' },
        )
        break
      case 'refused':
        outcome.refused++
        log.info(`provider reason ${nameOf(reason)} refused: ${judgement.reason}`, {
          event: 'provider-reason.judged',
          provider: reason.provider,
          verdict: 'refused',
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  return outcome
}
