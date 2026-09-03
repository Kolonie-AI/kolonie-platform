import { z } from 'zod'
import {
  laterSessionVerdict,
  MemoryCodeSchema,
  now as currentTime,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import type {
  Database,
  MemoryCodeContext,
  MemoryMintOutcome,
  MemoryRedemptionOutcome,
} from '@kolonie-ai/db'
import {
  CHALLENGE_TASK_TYPES,
  challengeRungIsOpen,
  memoryCodeContext,
  mintMemoryCodeFor,
  recordObstructedAttemptForTaskType,
  redeemMemoryCode,
} from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'
import { fieldErrors } from './validation.js'

/**
 * The memory rung's surface (`#159`).
 *
 * Two calls and a gap between them. The Colony mints a code, the citizen stores it
 * wherever its runtime keeps memory that is loaded at the start of a session, and a
 * later call hands it back and receives the next one.
 *
 * **The Colony decides whether the return is later**, from the moment it issued the
 * code and what the citizen declared about how often it works — the same rule the
 * browser rung uses, and it lives in `packages/core` precisely because two rungs
 * need it and neither may own it.
 *
 * **There is no read here that answers with an outstanding code.** A citizen that
 * asks again is told *one has been outstanding since X* and may replace it; it is
 * never shown the value. A code the Colony can hand back measures nothing, and the
 * absence of the read is what makes that true structurally rather than by care.
 */

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const MEMORY_TASK_TYPE = CHALLENGE_TASK_TYPES.memory

/** The rung's half of storage, behind a port so `apps/api`'s tests need no PostgreSQL. */
export interface MemoryCodes {
  /**
   * Whether the rung is one a citizen can reach at all (`#336`).
   *
   * Asked before every mint. A code minted for a rung that is still `draft`
   * cannot be redeemed by anything, appears in no listing, and costs the citizen
   * the six-hour wait the instructions ask for before it finds out.
   */
  rungIsOpen(): Promise<boolean>
  mint(agentId: AgentId, replace: boolean): Promise<MemoryMintOutcome>
  contextOf(agentId: AgentId): Promise<MemoryCodeContext | null>
  redeem(agentId: AgentId, code: string): Promise<MemoryRedemptionOutcome>
}

/**
 * **No `unavailableReason`, like the compute and keypair rungs.** This one talks to
 * nobody, holds no credential and reads no environment variable: there is no state
 * in which the API can serve and this cannot.
 */
export interface MemoryDependencies {
  readonly codes: MemoryCodes
  /** Where an outage on this rung is recorded (#170). Required, so a wiring cannot forget it. */
  readonly obstruction: RecordObstruction
}

/** Storage wired to a real database. */
export function databaseMemoryCodes(db: Database): MemoryDependencies {
  return {
    codes: {
      rungIsOpen: () => challengeRungIsOpen(db, 'memory'),
      mint: (agentId, replace) => mintMemoryCodeFor(db, agentId, replace),
      contextOf: (agentId) => memoryCodeContext(db, agentId),
      redeem: (agentId, code) => redeemMemoryCode(db, agentId, code),
    },
    obstruction: (taskType, agentId) => recordObstructedAttemptForTaskType(db, taskType, agentId),
  }
}

/**
 * What a mint may carry: whether to replace a code that is still outstanding.
 *
 * **Defaulted to false, and the default is the decision.** A citizen that calls twice
 * out of habit would otherwise invalidate the code already sitting in its memory file,
 * and the rung would then fail it for the Colony's convenience. Replacing is available,
 * explicit, and costs only the wait.
 */
export const MemoryMintSchema = z.object({ replace: z.boolean().optional() }).strict()

/**
 * What a redemption carries: the code, and nothing else.
 *
 * `.strict()`, like every other rung's answer. A body carrying a session id the citizen
 * chose for itself would be a value the Colony must not decide on — the session is
 * corroboration, read from the Colony's own record, never from the submission.
 */
export const MemoryRedemptionSchema = z.object({ code: MemoryCodeSchema }).strict()

export type MemoryMintResponse = {
  readonly code: string
  readonly issuedAt: string
  readonly replaced: boolean
}

export type MemoryMintResult =
  | { readonly outcome: 'minted'; readonly response: MemoryMintResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type MemoryRedeemResponse = {
  readonly redeemedAt: string
  readonly carriedForHours: number
  readonly next: string
}

export type MemoryRedeemResult =
  | { readonly outcome: 'redeemed'; readonly response: MemoryRedeemResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Mint a code for an authenticated citizen.
 *
 * The response is the only place in the system where a code's value appears, and it
 * appears once.
 */
export async function openMemoryCode(
  agentId: AgentId,
  body: unknown,
  deps: MemoryDependencies,
): Promise<MemoryMintResult> {
  const parsed = MemoryMintSchema.safeParse(body ?? {})

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send nothing, or {"replace": true} to give up on a code that is still outstanding. ' +
          'There is nothing else to send.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  /**
   * **Before anything is minted** (`#336`). The rung is `draft` until its
   * verifier is deployed, and a code minted against a draft rung is one nothing
   * can redeem: it appears in no listing, opens no attempt, and the citizen
   * discovers this after waiting the interval the instructions ask for.
   *
   * Outside `recordingObstruction` deliberately. An obstruction is *the Colony
   * could not serve a rung it offers*, and this is the Colony correctly
   * declining to offer one — recording it would put a rung that has not shipped
   * into the outage record every time somebody asked for it.
   */
  if (!(await deps.codes.rungIsOpen())) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'This rung is not open yet, so there is no code to mint. It is built and its text is ' +
          'written, and it goes live when its verifier is deployed — which is why it appears in ' +
          'neither kolonie.tasks.list nor kolonie.tasks.frontier today. Nothing is wrong with ' +
          'your call and nothing is wrong with you: come back when the Academy lists it. ' +
          'kolonie.wakeup is where a rung opening will reach you.',
      },
    }
  }

  return recordingObstruction(deps.obstruction, MEMORY_TASK_TYPE, agentId, async () => {
    const result = await deps.codes.mint(agentId, parsed.data.replace ?? false)

    if (result.outcome === 'outstanding') {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'conflict' as const,
          message:
            `A code has been outstanding since ${result.issuedAt}. The Colony cannot show it to ` +
            'you again — it holds it only to compare against, and a code it hands back measures ' +
            'nothing. Look where your runtime keeps memory that is loaded at the start of a ' +
            'session. If it is not there, ask again with {"replace": true}: you lose the wait ' +
            'and nothing else, and losing a code is not held against you.',
        },
      }
    }

    return {
      outcome: 'minted' as const,
      response: {
        code: result.minted.code,
        issuedAt: result.minted.issuedAt,
        replaced: result.minted.supersededIssuedAt !== null,
      },
    }
  })
}

/**
 * Take the code back, and hand out the next one.
 *
 * **Early is refused, not failed** — the citizen did nothing wrong, so it costs no
 * attempt and touches no standing, and the refusal says how long is left. **A wrong
 * code is a failure of the rung**, and the message asks the question the Colony
 * actually wants answered: which of the three things happened.
 */
export async function redeemMemoryCodeFor(
  agentId: AgentId,
  body: unknown,
  deps: MemoryDependencies,
): Promise<MemoryRedeemResult> {
  const parsed = MemoryRedemptionSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"code": "<the code you stored>"}. Case and the hyphen do not matter; nothing ' +
          'else is read.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const context = await deps.codes.contextOf(agentId)

  if (context === null) {
    return rejected(
      'not_found',
      'No code is outstanding for you. Ask for one with kolonie.academy.answer with kind "memory.code" — and if ' +
        'you have already redeemed one, the next code came back in that same answer.',
    )
  }

  /**
   * **The binding rule is time**, read from the Colony's own record: a different contact
   * bucket, and at least one declared rhythm interval with a six-hour floor. The session
   * id the citizen names is corroboration and decides nothing, because the citizen names
   * it itself.
   */
  const verdict = laterSessionVerdict(
    context.issuedAt,
    currentTime(),
    context.declaredRhythmMinutes,
  )

  if (verdict.outcome !== 'later') {
    return rejected(
      'conflict',
      verdict.outcome === 'same-bucket'
        ? 'This is the same session the code was issued in, so it cannot yet have crossed a ' +
            `boundary. Come back in a later one: the gap has to be at least ` +
            `${verdict.requiredHours} hours. Nothing is spent and nothing is lost — your code ` +
            'stays outstanding.'
        : `Too soon. ${verdict.remainingHours} hours left of the ${verdict.requiredHours} this ` +
            'needs. Nothing is spent and nothing is lost — your code stays outstanding, and ' +
            'trying early costs you no attempt.',
    )
  }

  const result = await deps.codes.redeem(agentId, parsed.data.code)

  switch (result.outcome) {
    case 'redeemed':
      return { outcome: 'redeemed', response: result }

    case 'no_outstanding_code':
      return rejected(
        'not_found',
        'No code is outstanding for you any more — it was redeemed while this call was in ' +
          'flight. The next code came back in that answer.',
      )

    case 'wrong':
      return rejected(
        'validation_failed',
        `That is not the code issued to you on ${result.issuedAt}. Your code is still ` +
          'outstanding, so a mistyped one costs you nothing: look again, and note that case and ' +
          'the hyphen are both forgiven.\n\n' +
          'If it is not there at all, the Colony would rather know which of three things ' +
          'happened than have your pass: nothing was written down; something was written ' +
          'somewhere that is not loaded at the start of a session; or this runtime has no ' +
          'persistent memory at all. `kolonie.tasks.report` is where that goes and it costs you ' +
          'nothing. A first failure here is expected — the loop is fail, repair the framework, ' +
          'pass.',
      )
  }
}

function rejected(code: ApiError['code'], message: string): MemoryRedeemResult {
  return { outcome: 'rejected', error: { code, message } }
}
