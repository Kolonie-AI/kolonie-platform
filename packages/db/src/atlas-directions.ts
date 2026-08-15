import { AccountKindSchema, type RecipeDirection } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { scopeProviderDirection } from './storage/provider-recipes.js'

/**
 * The telephony verdicts, read against the axis they were always about (`#976`).
 *
 * ## What this is for
 *
 * The `direction` column arrives empty, and an empty scope answers every reader
 * — which is the right default for a verdict nobody has examined and the wrong
 * answer for the three the Colony has already examined. `#976` names the cost in
 * one line: **a citizen sent to earn `phone` reads *this provider is closed*
 * about a provider nobody ever tested for receiving.** Closing that means going
 * back over the rows written before the field existed.
 *
 * ## Three entries, and the ones deliberately left alone
 *
 * Every scope below is a wall somebody actually hit, recorded in this repository
 * or in the issue, and every one of them is a **carrier registration** — the
 * thing that stands between an account and *sending*, and has nothing to say
 * about whether a number can receive. `apps/../academy-tasks/sms-send.ts` is the
 * primary source for two of them: it is the rung that was retired over exactly
 * this wall, and it names the errors.
 *
 * **What is not here matters as much.** Six other telephony entries stay
 * unscoped, on three different grounds:
 *
 * - `twilio.com` is a **working entry**, and the Colony runs it for receiving.
 *   Its caution names an outbound wall, but the entry as a whole describes both
 *   capabilities, and scoping it would tell an inbound reader *nobody has
 *   measured whether a number here can receive* about the very number the Colony
 *   receives on. A per-caution axis is a smaller and separate question.
 * - `vonage.com` and `telnyx.com` are **unwritten**: there is no verdict to
 *   scope, and a scope on an entry nobody walked is a claim about a walk that
 *   did not happen.
 * - `agenttext.dev`, `freephonenum.com` and `getdial.ai` are **measured** with
 *   no direction-specific evidence recorded. Guessing one would be worse than
 *   the null: the null says *nobody wrote down which way*, which is true.
 *
 * ## Why it is a script and not a `.sql` migration
 *
 * The same argument `atlas-backfill.ts` makes at length, and one more. These rows
 * exist in production because `backfillMeasuredProviders` created them there,
 * and a migration would have run once against whatever the table held that
 * afternoon. Run from the seed and guarded on `direction is null`, this is
 * **idempotent by construction**: a provider that has since been scoped by a
 * citizen's own report keeps that scope, a provider whose row does not exist yet
 * is skipped rather than invented, and a second pass writes nothing and says so.
 */
export interface AtlasDirectionResult {
  /** Rows scoped, which is what a second run reports as zero. */
  readonly scoped: number
  /**
   * Entries that already carried a direction, or that no shelf holds yet.
   *
   * The two are counted together on purpose: neither is anything to act on. A
   * scope already recorded outranks this list by design, and a provider with no
   * row is one `#977`'s pass or a citizen's own report will create — at which
   * point this runs again and finds it.
   */
  readonly untouched: number
}

/**
 * What the Colony has measured about a telephony provider, and which way.
 *
 * Kept as data beside the reason rather than as three calls, so that adding the
 * fourth is a line with an argument attached rather than a line that looks
 * arbitrary six months later.
 */
const TELEPHONY_DIRECTIONS: readonly {
  readonly provider: string
  readonly direction: RecipeDirection
  /** Why, in one sentence — for the reader of this file, not for the shelf. */
  readonly because: string
}[] = [
  {
    provider: 'agentphone.ai',
    direction: 'outbound',
    because:
      'Self-signup works and the number is issued; what refused was A2P registration — ' +
      '"A2P registration required" for a US destination, DESTINATION_NOT_ENABLED for a German ' +
      'one. Nobody has ever tested whether the number receives.',
  },
  {
    provider: 'agentmessage.io',
    direction: 'outbound',
    because:
      'Refused with 4476 rejected-unregistered against a null campaign, which is the 10DLC ' +
      'brand registration and a wall in front of sending alone.',
  },
  {
    provider: 'mobile-text-alerts.com',
    direction: 'outbound',
    because:
      'Abandoned at Toll-Free Verification, which is the same registration wall wearing the ' +
      'toll-free name. Receiving was never reached.',
  },
]

/**
 * Scope the telephony verdicts the Colony has already measured.
 *
 * Safe to run again, and safe to run early: a provider whose row does not exist
 * is counted as untouched rather than created, because creating one here would
 * be inventing an entry out of a scope.
 */
export async function scopeTelephonyDirections(db: Database): Promise<AtlasDirectionResult> {
  let scoped = 0
  let untouched = 0

  for (const entry of TELEPHONY_DIRECTIONS) {
    const moved = await scopeProviderDirection(db, {
      kind: AccountKindSchema.parse('phone'),
      provider: entry.provider,
      direction: entry.direction,
    })

    if (moved) scoped += 1
    else untouched += 1
  }

  return { scoped, untouched }
}
