import {
  HANDOVER_MAX_READS,
  OpenHandoverSchema,
  handoverNotice,
  handoverPrompt,
  recipeStatusIsOfferable,
  type AgentId,
  type ApiError,
  type HandoverSummary,
  type HumanId,
  type ProviderRecipe,
} from '@kolonie-ai/core'
import {
  handoversFor,
  openHandover as openHandoverInDatabase,
  operatorOf,
  readHandoverAsOperator,
  type Database,
} from '@kolonie-ai/db'

/**
 * The agent-to-operator secret channel, from the API's side (`#592`).
 *
 * A sibling of `operator-drops.ts` and deliberately not a generalisation of it.
 * The two look alike and differ in the one place that matters: **who may read
 * the value out.** A drop is written through a mailed bearer link and read by
 * the agent; a handover is written by the agent and read by a person, and a
 * person reading a secret has to be signed in. There is no token path here at
 * all — the absence is the guarantee, not a check.
 *
 * The decision this rests on is `kolonie-docs/state/decisions/
 * who-owns-an-agents-account-credentials.md`, and it is not restated here.
 */
export interface HandoverStore {
  open(command: {
    readonly agentId: AgentId
    readonly provider: string
    readonly prompt: string
    readonly value: string
  }): ReturnType<typeof openHandoverInDatabase>
  waiting(humanId: HumanId): Promise<readonly HandoverSummary[]>
  read(handoverId: string, humanId: HumanId): ReturnType<typeof readHandoverAsOperator>
  /**
   * Whether anybody can ever read what this agent seals (`#918`).
   *
   * **The precondition that had no check.** Reading a handover requires a signed-in
   * console session, and a console session belongs to a `humans` row linked to this
   * agent. With no link there is no reader — the value is sealed, the expiry runs,
   * and it is destroyed unread. A citizen measured exactly that on 2026-08-12: it
   * sealed a password, told its operator, and the seal expired four hours later
   * having never been renderable anywhere its operator could reach.
   *
   * Checked here rather than left to the operator to discover, because the two
   * failures are indistinguishable from the agent's side and only one of them is
   * fixable: *nobody read it yet* and *nobody could ever read it* both look like
   * silence, and the second costs six days.
   */
  hasOperator(agentId: AgentId): Promise<boolean>
}

export function databaseHandovers(db: Database, sealingKey: string): HandoverStore {
  return {
    open: (command) => openHandoverInDatabase(db, command, sealingKey),
    waiting: (humanId) => handoversFor(db, String(humanId)),
    read: (handoverId, humanId) =>
      readHandoverAsOperator(db, handoverId, String(humanId), sealingKey),
    hasOperator: async (agentId) => (await operatorOf(db, agentId)) !== undefined,
  }
}

export type HandoverResult =
  | {
      readonly outcome: 'ok'
      readonly response: {
        readonly id: string
        readonly expiresAt: string
        readonly reads: number
        readonly notice: string
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Seal a value for this citizen's operator, at any provider (`#926`).
 *
 * **What authorises it is that somebody can read it**, and that is the one check
 * left below. The recipe step used to be the gate — it had to exist, be the
 * agent's, and be marked `handover` — and removing it is `#926`'s whole content.
 *
 * The fourth constraint `#592` names survives the removal, because it was never
 * the step: an agent still cannot compose the sentence that arrives beside its
 * secret. `handoverPrompt` writes it, from the step's instruction where there is
 * one and from the Colony's own words where there is not, and `OpenHandoverSchema`
 * still has no field prose could arrive through.
 *
 * What the gate cost is measurable. On 2026-08-13 the `telephony` shelf held
 * three entries, all `unwritten`, all with `steps: []` — so the channel was
 * closed for every phone provider, and for every provider nobody had walked,
 * which is the normal state of anything new.
 */
export async function openHandover(
  input: {
    readonly agentId: AgentId
    readonly body: unknown
    readonly recipe: ProviderRecipe | undefined
  },
  store: HandoverStore | undefined,
): Promise<HandoverResult> {
  if (store === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'rung_unavailable',
        message:
          'This Colony has no sealing key configured, so it cannot carry a secret in either ' +
          'direction. Nothing is wrong with your request — tell your operator directly, ' +
          'through whatever channel you already share, and carry on.',
      },
    }
  }

  const parsed = OpenHandoverSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"provider": "…", "value": "<the secret>"}, and "step": <the step number> if you ' +
          'are on a recipe step. The step is optional and records where you were; the sentence ' +
          'your operator reads is the Colony’s either way, and there is no field here to ' +
          'write it with.',
      },
    }
  }

  /**
   * **Refused before it is sealed, and not after it has expired** (`#918`).
   *
   * This is the whole of the citizen's report: the recipe told it to seal a
   * password into a console its operator was never signed in to, and nothing
   * anywhere said so. From where the agent stands, *nobody has read it yet* and
   * *nobody can ever read it* are the same silence — so the first is worth
   * waiting through and the second is worth six days, which is what it cost.
   *
   * **The refusal names both ways on**, because they are genuinely different
   * choices and neither is the Colony's to make. Linking gives the operator a
   * console and keeps the direction the 2026-08-08 decision chose — the agent
   * picks the password and the operator keeps no copy. A credential drop reverses
   * the direction, and the operator that will not hold a Colony account is
   * exactly the case that reversal is for: the agent still ends up holding the
   * credential, which is the half of the decision that was load-bearing.
   */
  if (!(await store.hasOperator(input.agentId))) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Nobody could read this. A handover is read from a signed-in console, and no person ' +
          'is linked to you — so sealing it would spend the step and destroy the value unread ' +
          'when it expires. Two ways on, and they are different choices rather than a ' +
          'preference. **Link your operator** with kolonie.operator.link: it gets a console, ' +
          'this step works as written, and you go on choosing the password. **Or open a ' +
          'credential drop** with kolonie.operator.drop.open — that page needs no login, so ' +
          'your operator can set the password at the signup form and put it there, and it ' +
          'lands in your vault. Say that in the prompt, in those words: a drop carries a ' +
          'secret being made for you, and one that asks for a password already in use is ' +
          'refused (`#938`). You still end up holding the account, which is the part that ' +
          'matters.',
      },
    }
  }

  /**
   * **The recipe is read for its wording, not for permission** (`#926`).
   *
   * An offerable recipe whose numbered step is marked `handover` has a sentence
   * written for this exact moment, and it is better than the general one. Every
   * other case — no recipe, a recipe not on offer, a step out of range, a step
   * that is not a handover — falls through to `handoverPrompt`, which is also
   * the Colony's words. None of them refuses.
   *
   * **The provider is the caller's own string** where no recipe answers for it.
   * It cannot be `recipe.provider` any more: at a provider the Atlas has never
   * heard of there is no row to take a canonical spelling from, and the whole
   * point of `#926` is that this is the ordinary case.
   */
  const recipe = input.recipe
  const offerable = recipe !== undefined && recipeStatusIsOfferable(recipe.status)
  const step =
    offerable && parsed.data.step !== undefined ? recipe.steps[parsed.data.step - 1] : undefined
  const instruction = step?.handover === true ? step.instruction : undefined

  const opened = await store.open({
    agentId: input.agentId,
    provider: offerable ? recipe.provider : parsed.data.provider,
    // The Colony's sentence and never the agent's, exactly as the ask is on a
    // handoff. There is no field on the request through which prose could
    // arrive — which is what `#592`'s fourth constraint was actually protecting,
    // and it is untouched by the step no longer gating.
    prompt: handoverPrompt(offerable ? recipe.provider : parsed.data.provider, instruction),
    value: parsed.data.value,
  })

  if (opened.outcome !== 'opened') {
    return {
      outcome: 'rejected',
      error: { code: 'internal', message: 'the handover could not be sealed' },
    }
  }

  return {
    outcome: 'ok',
    response: {
      id: opened.id,
      expiresAt: opened.expiresAt,
      reads: HANDOVER_MAX_READS,
      notice: handoverNotice(HANDOVER_MAX_READS),
    },
  }
}
