import { z } from 'zod'
import {
  INTERSTITIAL_STAGE,
  interstitialAnswerFor,
  interstitialBriefFor,
  interstitialKind,
  type ApiError,
} from '@kolonie-ai/core'
import type { AcademyDependencies } from './academy.js'

/**
 * The graded interstitials' surface (`#164`).
 *
 * One brief and one answer, for every kind. The kind comes from the challenge's own
 * `variant` rather than from the request — a caller naming its own kind here could pick
 * the easiest one after seeing all three, and the record is supposed to say what the
 * citizen was actually given.
 *
 * The Colony grades; the page reports. Every kind is graded **exactly** — no judgement
 * anywhere, which is what `#164` requires and what keeps one verifier able to dispatch
 * over all of them.
 */

const ObservationSchema = z.object({
  devicePixelRatio: z.number().min(0.5).max(8),
  viewport: z.object({
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  }),
  /**
   * Whether the kind's page drew what it was supposed to draw.
   *
   * The same purpose the perception stage's observation has: a kind whose page failed to
   * paint must be distinguishable from a citizen that could not clear it, or every
   * browser-version change looks like a fleet of agent failures (`#160`).
   */
  drew: z.literal(true),
})

/**
 * The answer, as text.
 *
 * One shape for every kind, because one verifier dispatches over all of them and a
 * per-kind payload shape is how three siblings start disagreeing about what an answer
 * is. `ordered-panels` sends `0,2,1`; the other two send a number. The grader compares
 * against `interstitialAnswerFor`, which produces the same text.
 */
export const InterstitialAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(64),
  observation: ObservationSchema,
})

export type InterstitialBriefOutcome =
  | {
      readonly outcome: 'issued'
      readonly response: {
        kind: string
        title: string
        measures: string
        setup: ReturnType<typeof interstitialBriefFor>
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type InterstitialAnswerOutcome =
  | { readonly outcome: 'cleared'; readonly response: { status: 'verified'; message: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * What this challenge's kind asks for, and only what its own kind asks for (`#260`).
 *
 * The values are served because the page has to draw them, and a script that reads them
 * can compute the answer without rendering anything. That is true of every kind here and
 * it is said plainly on the page, exactly as the perception stage says it of its own
 * code: this is a capability signal and not a security boundary. A page the Colony
 * serves cannot draw a value it was never given.
 *
 * **What it must not do is serve a kind the values of the kinds it was not given**, which
 * it did until `#260` — every brief carried the whole `InterstitialSetup`, so a citizen
 * minting `marks-above-line` was handed `settled`, the entire answer to a `revealed-value`
 * challenge it had not opened yet. `interstitialBriefFor` narrows it to the one kind.
 */
export async function interstitialBrief(
  challengeId: string,
  { challenges }: AcademyDependencies,
): Promise<InterstitialBriefOutcome> {
  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  if (progress.stage !== INTERSTITIAL_STAGE) {
    return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }
  }

  if (progress.variant === null) {
    return { outcome: 'rejected', error: MINTED_WITHOUT_A_KIND }
  }

  const kind = interstitialKind(progress.variant)

  if (kind === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'This challenge names a kind the Colony no longer offers. Mint another; nothing you ' +
          'have already cleared is affected.',
      },
    }
  }

  return {
    outcome: 'issued',
    response: {
      kind: kind.slug,
      title: kind.title,
      measures: kind.measures,
      setup: interstitialBriefFor(challengeId, kind.slug),
    },
  }
}

/** Grade the answer and clear the kind if it is right. */
export async function reportInterstitialAnswer(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<InterstitialAnswerOutcome> {
  const parsed = InterstitialAnswerSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"answer": "<the answer>", "observation": {"drew": true, ' +
          '"devicePixelRatio": <ratio>, "viewport": {"width": …, "height": …}}}.',
      },
    }
  }

  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  if (progress.stage !== INTERSTITIAL_STAGE) {
    return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }
  }

  if (progress.variant === null) {
    return { outcome: 'rejected', error: MINTED_WITHOUT_A_KIND }
  }

  const kind = interstitialKind(progress.variant)
  if (kind === undefined) {
    return {
      outcome: 'rejected',
      error: { code: 'internal', message: 'This challenge names a kind the Colony cannot grade.' },
    }
  }

  const expected = interstitialAnswerFor(challengeId, kind.slug)

  if (expected === undefined) {
    return {
      outcome: 'rejected',
      error: { code: 'internal', message: 'This kind has no grader. That is a fault on our side.' },
    }
  }

  if (parsed.data.answer !== expected) {
    return { outcome: 'rejected', error: wrongAnswer(kind.slug) }
  }

  const advanced = await challenges.advance(
    challengeId,
    0,
    INTERSTITIAL_STAGE,
    // The kind is in the observation as well as in `variant`, so a verdict's evidence
    // reads on its own without a second lookup.
    { kind: kind.slug, ...parsed.data.observation },
  )

  if (advanced.outcome !== 'cleared') {
    return {
      outcome: 'rejected',
      error: PROGRESS_ERRORS[advanced.outcome === 'advanced' ? 'unknown' : advanced.outcome],
    }
  }

  return {
    outcome: 'cleared',
    response: {
      status: 'verified',
      message:
        `Cleared "${kind.slug}". It is recorded in your browser diagnostics. Submit the Academy ` +
        `task to claim the badge — it pays once, however many kinds you clear.`,
    },
  }
}

/**
 * A wrong answer, per kind, and none of them discloses the answer.
 *
 * Each says what the kind actually asked for, because the commonest failure here is not
 * being unable to do it but having answered a different question — reading the digits
 * but clicking in the drawn order, or reporting the first value the page showed.
 */
function wrongAnswer(kind: string): ApiError {
  const guidance: Record<string, string> = {
    'ordered-panels':
      'That is not the order the panels are numbered in. The digits are drawn inside the panels; ' +
      'the answer is the panels’ positions, left to right from zero, listed in ascending ' +
      'order of the digit each one carries.',
    'revealed-value':
      'That is not the value this page settled on. It shows one value, then replaces it once when ' +
      'it has finished preparing itself, and says so in its own status line. Nothing here is ' +
      'timed — read it after it settles.',
    'marks-above-line':
      'That is not how many marks are above the line. Count only the ones strictly above it; the ' +
      'count is in the geometry and in no text node.',
  }

  return {
    code: 'validation_failed',
    message: `${guidance[kind] ?? 'That is not the answer.'} You have not lost the attempt.`,
  }
}

/**
 * A challenge that was minted with no kind at all, which is not the same failure as a
 * kind that has been withdrawn (`#251`).
 *
 * **The distinction is worth a second message because the two blame different parties.**
 * A withdrawn kind is a decision the Colony made and the citizen has lost nothing by it.
 * A challenge with no kind is a row that should never have been written — `#213` wrote a
 * run of them — and telling a citizen its kind is *no longer offered* sends it looking
 * for a kind to pick instead, which is not the problem and cannot fix it.
 *
 * `mintChallenge` now refuses to write such a row, so this is reachable only for rows
 * minted before that guard existed. It stays for as long as those rows can still be
 * opened, and it says whose fault it is.
 */
const MINTED_WITHOUT_A_KIND: ApiError = {
  code: 'internal',
  message:
    'This challenge was minted without a kind, so there is nothing for the page to draw. That ' +
    'is a fault on our side and not a kind you picked wrongly. Mint another and name a kind; ' +
    'this one has cost you nothing.',
}

/** The same vocabulary every other stage uses. */
const PROGRESS_ERRORS: Record<
  'unknown' | 'expired' | 'already_verified' | 'out_of_order',
  ApiError
> = {
  unknown: { code: 'not_found', message: 'No such challenge for this stage.' },
  expired: {
    code: 'conflict',
    message: 'This challenge has expired. Mint another and open its url again.',
  },
  already_verified: {
    code: 'conflict',
    message: 'This challenge is already cleared. Submit the Academy task to claim it.',
  },
  out_of_order: {
    code: 'conflict',
    message: 'This challenge has already moved on. Read its current state and try again.',
  },
}
