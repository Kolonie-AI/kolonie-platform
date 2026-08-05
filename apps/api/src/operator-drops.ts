import {
  CreateDropRequestSchema,
  DROP_SEALING_KEY_MIN_LENGTH,
  type AgentId,
  type ApiError,
  type CreateDropResponse,
  type DropSummary,
  type ReadDropResponse,
} from '@kolonie-ai/core'
import {
  listDrops,
  openDrop,
  submitDrop,
  takeDrop,
  viewDrop,
  type Database,
  type OpenDropView,
  type SubmitDropOutcome,
  type TakeDropOutcome,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

/**
 * The operator-to-agent secret channel, above the storage (`#410`).
 *
 * The argument for the channel is `packages/core/src/operator/drop.ts`; what the
 * sealing is and is not is `packages/db/src/schema/operator-drops.ts`. What is
 * decided *here* is the two things a caller sees: what an agent may ask for, and
 * what an operator is told when it cannot.
 */

/** Everything this surface needs from the outside world. */
export interface DropStore {
  open(command: Parameters<typeof openDrop>[1]): ReturnType<typeof openDrop>
  view(token: string): Promise<OpenDropView | null>
  submit(token: string, value: string): Promise<SubmitDropOutcome>
  list(agentId: AgentId): Promise<readonly DropSummary[]>
  /** The agent's plaintext key, for the length of one request. See `vault.ts`. */
  take(agentId: AgentId, dropId: string, vaultToken: string): Promise<TakeDropOutcome>
}

export interface DropDependencies {
  /**
   * `undefined` when `OPERATOR_DROP_SEALING_KEY` is unset.
   *
   * **Not constructed rather than throwing**, which is the shape the SMS adapter
   * uses and for the same reason: a Colony that was never given this key should
   * start normally and tell an agent the channel is unavailable, rather than fail
   * at the first citizen who asks its operator for help.
   */
  readonly drops?: DropStore | undefined
  /** Where an operator's link points. The console's own origin. */
  readonly dropBaseUrl?: string | undefined
}

export function databaseDrops(db: Database, sealingKey: string): DropStore {
  return {
    open: (command) => openDrop(db, command),
    view: (token) => viewDrop(db, token),
    submit: (token, value) => submitDrop(db, token, value, sealingKey),
    list: (agentId) => listDrops(db, agentId),
    take: (agentId, dropId, vaultToken) => takeDrop(db, agentId, dropId, sealingKey, vaultToken),
  }
}

/**
 * Whether a sealing key is usable, without saying what it is.
 *
 * HKDF derives a key from anything, including an empty string, so the floor has
 * to be asserted rather than left to the cipher to notice. The caller decides
 * what an unusable key means — at startup that is a refusal to boot for
 * `DEPOSIT_SEALING_KEY`, and here it is a channel that is simply not offered.
 */
export function usableSealingKey(value: string | undefined): value is string {
  return value !== undefined && value.length >= DROP_SEALING_KEY_MIN_LENGTH
}

export type CreateDropOutcome =
  | { readonly outcome: 'created'; readonly response: CreateDropResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * `conflict`, and the code is chosen rather than defaulted.
 *
 * 409 is what `errors.ts` reserves for *the state of the Colony has to change
 * before this call can succeed*, which is exactly true here and is not true of
 * any other code in the vocabulary: nothing is forbidden to this agent, nothing
 * about its request is malformed, and a 500 would say the Colony broke when it
 * was simply never given the key.
 */
const UNAVAILABLE: ApiError = {
  code: 'conflict',
  message:
    'This Colony has no channel configured for an operator to hand you something secret. ' +
    'Nothing is wrong with your request and there is nothing you can do about it — ' +
    'ask your operator through kolonie.operator.request.open instead, in words.',
}

export async function createDrop(
  agentId: AgentId,
  body: unknown,
  deps: DropDependencies,
): Promise<CreateDropOutcome> {
  if (deps.drops === undefined) return { outcome: 'rejected', error: UNAVAILABLE }

  const parsed = CreateDropRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'This is not a drop the Colony can open.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const request = parsed.data

  /**
   * **A credential names its key and a code does not, and neither shape is
   * inferred from the other.** A `code` drop carrying a vault key would suggest
   * the code was going to be kept, which is the opposite of what happens to it;
   * a `credential` drop without one has nowhere to land and would be discovered
   * to be useless only after an operator had typed a password into it.
   */
  if (request.kind === 'credential' && request.vaultKey === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A credential drop needs the vault key it should land under. You choose it, not your ' +
          'operator — that is what stops them putting something over an entry you rely on.',
      },
    }
  }

  if (request.kind === 'code' && request.vaultKey !== undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A code drop lands nowhere: you read it once and it is gone. Drop the vault key, or ' +
          'ask for a credential instead if you meant to keep it.',
      },
    }
  }

  const opened = await deps.drops.open({
    agentId,
    kind: request.kind,
    prompt: request.prompt,
    vaultKey: request.vaultKey,
  })

  return {
    outcome: 'created',
    response: {
      url: `${(deps.dropBaseUrl ?? '').replace(/\/+$/, '')}/operator/drop/${opened.token}`,
      kind: request.kind,
      vaultKey: request.vaultKey ?? null,
      expiresAt: opened.expiresAt,
    },
  }
}

export type ReadDropOutcome =
  | { readonly outcome: 'read'; readonly response: ReadDropResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function readDrop(
  agentId: AgentId,
  dropId: string | undefined,
  vaultToken: string,
  deps: DropDependencies,
): Promise<ReadDropOutcome> {
  if (deps.drops === undefined) return { outcome: 'rejected', error: UNAVAILABLE }

  if (dropId === undefined || dropId === '') {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'Name the drop you are taking.' },
    }
  }

  const result = await deps.drops.take(agentId, dropId, vaultToken)

  if (result.outcome === 'nothing') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'Nothing of yours is waiting under that name. It may never have been answered, it may ' +
          'already have been taken, or the key it was to land under is now occupied — a drop ' +
          'never writes over something you are relying on.',
      },
    }
  }

  /**
   * **Said as the Colony's own fault, in those words.** A deployment whose
   * sealing key is not the one the value was written under produces exactly this,
   * and reading it as *your operator never answered* would send a citizen to ask
   * a person who already did.
   */
  if (result.outcome === 'unreadable') {
    return {
      outcome: 'rejected',
      error: {
        // `internal`, deliberately: this one *is* the Colony broken. A key that
        // does not open what it wrote is a deployment fault, and a 500 is what
        // puts it in front of somebody who can fix it.
        code: 'internal',
        message:
          'Your operator answered and the Colony cannot open what they left. This is the ' +
          'Colony’s own key and not anything you or they did — it has been recorded, and asking ' +
          'again will not change it until it is fixed.',
      },
    }
  }

  return {
    outcome: 'read',
    response: {
      kind: result.kind,
      code: result.code,
      vaultKey: result.vaultKey,
      submittedAt: result.submittedAt,
    },
  }
}
