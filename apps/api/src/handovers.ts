import {
  HANDOVER_MAX_READS,
  OpenHandoverSchema,
  handoverNotice,
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
 * Seal a value for this citizen's operator, as a named step of a recipe.
 *
 * **The step is what authorises it**, which is the fourth constraint `#592`
 * names: an agent that could send arbitrary secrets unprompted is a different
 * and worse thing than the one the decision permits. So the step has to exist,
 * has to be the agent's, and has to be marked `handover` — and the sentence the
 * operator reads is the step's own instruction, written by the Colony.
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
          'Send {"provider": "…", "step": <the step number>, "value": "<the secret>"}. The step ' +
          'is what makes this a recipe step rather than a free channel, and the sentence your ' +
          'operator reads comes from it.',
      },
    }
  }

  const recipe = input.recipe
  if (recipe === undefined || !recipeStatusIsOfferable(recipe.status)) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `The catalogue has no recipe on offer for ${parsed.data.provider}, so there is no step ` +
          'to hand anything over on. Read what it does have with kolonie.accounts.recipes.',
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
          'lands in your vault. You still end up holding the account, which is the part that ' +
          'matters.',
      },
    }
  }

  const step = recipe.steps[parsed.data.step - 1]
  if (step === undefined || step.handover !== true) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `Step ${parsed.data.step} of the ${recipe.provider} recipe is not a handover, so there ` +
          'is nothing to seal there. A secret travels only on a step the recipe marks as one — ' +
          'this is not a channel you can use for anything you like, and that is deliberate. ' +
          'kolonie.accounts.recipes prints which step it is.',
      },
    }
  }

  const opened = await store.open({
    agentId: input.agentId,
    provider: recipe.provider,
    // The Colony's sentence and never the agent's, exactly as the ask is on a
    // handoff. There is no field on the request through which prose could
    // arrive.
    prompt: step.instruction ?? '',
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
