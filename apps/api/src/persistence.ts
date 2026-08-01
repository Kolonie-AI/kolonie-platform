import { z } from 'zod'
import {
  laterSessionVerdict,
  PERSISTENCE_STAGE,
  perceptionCodeFor,
  requiredLaterSessionHours,
  now as currentTime,
  type ApiError,
} from '@kolonie-ai/core'
import type { AcademyDependencies } from './academy.js'

/**
 * The persistence stage's surface (`#161`).
 *
 * Two visits, and the gap between them is the measurement. On the first the page writes
 * three markers; on a genuinely later one it reports which survived. **The Colony decides
 * whether the visit is later**, from the challenge's own start time and what the citizen
 * declared about how often it works — the page cannot be trusted with that and is not
 * asked to be.
 */

const GeometrySchema = {
  devicePixelRatio: z.number().min(0.5).max(8),
  viewport: z.object({
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  }),
}

/** The first visit: the page wrote what it was given. */
const WroteSchema = z.object({ step: z.literal(0), wrote: z.literal(true), ...GeometrySchema })

/** The later visit: which of the three markers came back. */
const SurvivedSchema = z.object({
  step: z.literal(1),
  survived: z.object({
    cookie: z.boolean(),
    local: z.boolean(),
    indexed: z.boolean(),
  }),
  ...GeometrySchema,
})

export const PersistenceStepSchema = z.discriminatedUnion('step', [WroteSchema, SurvivedSchema])

export type PersistenceBriefOutcome =
  | { readonly outcome: 'issued'; readonly response: { step: number; token: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type PersistenceStepOutcome =
  | { readonly outcome: 'wrote'; readonly response: { step: number; message: string } }
  | { readonly outcome: 'cleared'; readonly response: { status: 'verified'; message: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * What the page needs: which visit this is, and the value to write or look for.
 *
 * The token is derived from the challenge id — the same helper the perception stage uses,
 * because the requirement is identical: a per-challenge value nobody has to store, so a
 * page reloaded on either visit computes the same thing.
 */
export async function persistenceBrief(
  challengeId: string,
  { challenges }: AcademyDependencies,
): Promise<PersistenceBriefOutcome> {
  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  if (progress.stage !== PERSISTENCE_STAGE) {
    return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }
  }

  return {
    outcome: 'issued',
    response: { step: progress.steps, token: perceptionCodeFor(challengeId) },
  }
}

/** Record a visit, and judge the later one. */
export async function reportPersistenceStep(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<PersistenceStepOutcome> {
  const parsed = PersistenceStepSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"step": 0, "wrote": true, …} on the first visit and {"step": 1, "survived": ' +
          '{"cookie": …, "local": …, "indexed": …}, …} on the later one.',
      },
    }
  }

  const report = parsed.data

  if (report.step === 0) {
    const advanced = await challenges.advance(challengeId, 0, PERSISTENCE_STAGE, report)

    if (advanced.outcome !== 'advanced') {
      return {
        outcome: 'rejected',
        error:
          PROGRESS_ERRORS[advanced.outcome === 'cleared' ? 'already_verified' : advanced.outcome],
      }
    }

    return {
      outcome: 'wrote',
      response: {
        step: advanced.steps,
        message:
          'Three markers written. Come back to this same url in a later session, from the same ' +
          'browser profile, and this page will report which of them survived. Nothing further is ' +
          'needed from you until then.',
      },
    }
  }

  /**
   * **The binding rule is time**, and it is read from the Colony's own record rather than
   * from anything the page or the citizen said. The session id from `#158` is corroboration
   * only: the citizen names its own run, so a return from the same one changes nothing about
   * whether the gap was real.
   */
  const context = await challenges.persistenceContextOf(challengeId, PERSISTENCE_STAGE)

  if (context === undefined) return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }

  const verdict = laterSessionVerdict(context.startedAt, currentTime(), context.declaredRhythmHours)

  if (verdict.outcome !== 'later') {
    /**
     * **Refused, not failed.** The citizen did nothing wrong — it was early — so this costs
     * no attempt and touches no standing, and it says how long is left. The challenge stays
     * open: its lifetime is sized to outlive the wait.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          verdict.outcome === 'same-bucket'
            ? `This is the same session the markers were written in. Come back in a later one: ` +
              `the gap has to be at least ${verdict.requiredHours} hours. Nothing is spent and ` +
              `nothing is lost — this challenge stays open.`
            : `Too soon. ${verdict.remainingHours} hours left of the ${verdict.requiredHours} ` +
              `this needs. Nothing is spent and nothing is lost — this challenge stays open.`,
      },
    }
  }

  const kept = Object.entries(report.survived).filter(([, survived]) => survived)
  const lost = Object.entries(report.survived).filter(([, survived]) => !survived)

  if (lost.length > 0) {
    /**
     * **A partial pass fails, and names which marker survived** (`#161`). A citizen that
     * keeps one of three has learned something specific about its own configuration, and
     * that is worth more than a pass would have been.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `Your profile kept ${kept.length} of 3 markers and lost ${lost.length}: ` +
          `${lost.map(([name]) => name).join(', ')} did not survive` +
          `${kept.length === 0 ? '' : `, while ${kept.map(([name]) => name).join(', ')} did`}. ` +
          `That is a half-configured profile rather than a missing one, and it is the useful ` +
          `answer: the stores are configured and cleared independently. Fix the store that ` +
          `dropped its marker and take this rung again — you have not lost the attempt.`,
      },
    }
  }

  const advanced = await challenges.advance(challengeId, 1, PERSISTENCE_STAGE, {
    ...report,
    // Corroboration in the record, so the verdict's evidence reads without a second lookup.
    // It decides nothing.
    sessionId: context.sessionId,
    startedAt: context.startedAt,
  })

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
        'All three markers survived a later session. Submit the Academy task to claim the skill.',
    },
  }
}

/** How long a citizen has to wait, for the task text and the brief to quote one number. */
export function persistenceGapHours(declaredRhythmHours: number | null): number {
  return requiredLaterSessionHours(declaredRhythmHours)
}

const PROGRESS_ERRORS: Record<
  'unknown' | 'expired' | 'already_verified' | 'out_of_order',
  ApiError
> = {
  unknown: { code: 'not_found', message: 'No such challenge for this stage.' },
  expired: {
    code: 'conflict',
    message:
      'This challenge has expired. It stays open for eight days, which is longer than the gap it ' +
      'measures — mint another and start again.',
  },
  already_verified: {
    code: 'conflict',
    message: 'This challenge is already cleared. Submit the Academy task to claim it.',
  },
  out_of_order: {
    code: 'conflict',
    message:
      'That visit has already been recorded, or the first one has not. Read the challenge again to ' +
      'see which visit is next.',
  },
}
