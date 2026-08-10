import {
  WalkNoteSchema,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  type AccountKind,
  type AccountWalk,
  type AgentId,
  type ApiError,
  type ProviderRecipe,
  type WalkOutcome,
  type WalkVerdict,
} from '@kolonie-ai/core'
import { z } from 'zod'
import {
  accountWalk as accountWalkById,
  divergentWalks,
  finishWalk,
  openWalkId,
  recordWalkStep,
  walkInProgress,
  type Database,
} from '@kolonie-ai/db'

/**
 * A walk, from the API's side (`#601`).
 *
 * **The port exists so that recording is something the call sites do and not
 * something they know how to do.** `accounts.handoff` records that an operator
 * was asked; `accounts.declare` records that the agent got an account. Neither
 * should have to know that there is a table, whether a walk is already open, or
 * what a finished one does to the catalogue — those are one decision each and
 * they live in `packages/db/src/storage/account-walks.ts` and in
 * `packages/core/src/account/walk.ts`.
 *
 * **Optional at every call site, deliberately.** A deployment with no walk
 * recording behaves exactly as it did before this issue: a handoff still opens,
 * a declaration still lands. Recording is a by-product of the walk and must
 * never be able to fail one.
 */
export interface WalkStore {
  /** The walk this agent is on for this provider, opening one if there is none. */
  open(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
  ): Promise<string>
  /** Record that something happened, at the moment it happens. */
  record(
    walkId: string,
    step: {
      readonly actor: 'agent' | 'operator'
      readonly secret?: boolean
      readonly ask?: string | null
    },
  ): Promise<void>
  /** Close it, and do to the catalogue whatever the walk earns. */
  finish(
    walkId: string,
    input: {
      readonly outcome: WalkOutcome
      readonly wall?: string | null
      readonly note?: string | null
      readonly takenStepPositions?: readonly number[] | null
    },
  ): Promise<{ readonly walk: AccountWalk; readonly verdict: WalkVerdict } | undefined>
  /** The walk this agent is on, if it is on one. */
  inProgress(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
  ): Promise<AccountWalk | undefined>
  /** What a steward's queue reads (`#549`). */
  divergences(): Promise<
    readonly {
      readonly walk: AccountWalk
      readonly entry: ProviderRecipe
      readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
    }[]
  >
}

/**
 * Record a step and never let the recording break the thing being recorded.
 *
 * **Every call site wraps its record in this.** A handoff that failed because
 * the Colony could not write down that it happened would be the record costing
 * the walk, which is the one way this feature could make the Colony worse. The
 * failure is swallowed and the walk is simply less complete — which a steward
 * reviewing it can see, because the shape will not match.
 */
export async function noteWalkStep(
  walks: WalkStore | undefined,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  step: { readonly actor: 'agent' | 'operator'; readonly secret?: boolean; readonly ask?: string },
): Promise<void> {
  if (walks === undefined) return

  try {
    const walkId = await walks.open(agentId, where)
    await walks.record(walkId, step)
  } catch {
    /** Deliberately silent — see above. */
  }
}

/**
 * What an agent hands in at the end, and the one question it is asked.
 *
 * `#601`: *"The agent is asked one question at the end, and only one. Did this
 * match what you were told? Free text, optional, refused if it looks like a
 * credential. Everything else is observed rather than asked — an agent that has
 * just finished a signup should not be handed a form."*
 *
 * The free-text note and published-step tick-list are two parts of that one
 * answer. The outcome is one word the agent already knows, and the wall is
 * required only when the answer is that there was one.
 */
export const WalkReportSchema = z
  .object({
    outcome: WalkOutcomeSchema,
    /** Required when the outcome is `refused`: a dead end nobody described is unusable. */
    wall: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    /** The one question. Optional, and refused if it looks like a credential. */
    note: WalkNoteSchema.optional(),
    /** The one question's tick-list answer, against the published recipe. */
    takenStepPositions: WalkTakenStepPositionsSchema.optional(),
  })
  .strict()
  .refine((report) => report.outcome !== 'refused' || report.wall !== undefined, {
    message:
      'a walk that ended at a wall has to say what the wall was. That sentence is the whole ' +
      'value of the finding — it is what stops the next agent spending a day on it.',
    path: ['wall'],
  })
  .refine((report) => report.outcome === 'refused' || report.wall === undefined, {
    message: 'only a walk that ended at a wall carries one.',
    path: ['wall'],
  })
export type WalkReport = z.infer<typeof WalkReportSchema>

/**
 * What the agent is told back, per verdict.
 *
 * **Written once, here, because the four sentences are the feature explaining
 * itself.** An agent that walked a provider and got *ok* back has no idea that
 * it just wrote a draft somebody will review, and the next thing it does is
 * file an issue about the provider — which is the behaviour `#601` exists to
 * replace.
 */
export function walkVerdictAsText(verdict: WalkVerdict): string {
  switch (verdict.kind) {
    case 'draft':
      return (
        `Recorded, and it wrote a draft entry for the Atlas: ${verdict.steps.length} step` +
        `${verdict.steps.length === 1 ? '' : 's'}, in the order they happened, with an operator ` +
        `step wherever your operator was asked for something.\n\n` +
        `**The wording is not yours to write and it is not the Colony's to guess.** The draft ` +
        `carries what happened; a steward writes what each step says and publishes it. Nothing ` +
        `is public until they do.`
      )
    case 'refusal':
      return (
        `Recorded as a refusal, with the wall you named. That entry is worth as much as a ` +
        `working recipe — it is what stops the next agent spending a day discovering the same ` +
        `thing. A steward reviews it before it is published.`
      )
    case 'confirms':
      return (
        `Recorded, and it matched the published recipe — so the entry now says it was confirmed ` +
        `today. A recipe nobody has walked lately is a guess with a date on it, and you have ` +
        `just moved that date.`
      )
    case 'diverges':
      return (
        `Recorded, and **it did not go the way the entry says it goes**: you marked ` +
        `${verdict.walked.length} of the entry's ${verdict.published.length} published step` +
        `${verdict.published.length === 1 ? '' : 's'} as taken. That is how a provider changing ` +
        `its signup form ` +
        `announces itself, so it has gone to a steward with both sequences side by side. ` +
        `Nothing about the entry has changed yet.`
      )
    case 'nothing':
      return `Recorded. It proposes nothing to the catalogue: ${verdict.why}.`
  }
}

/** The error an agent gets when it reports a walk that is not running. */
export const NO_WALK_IN_PROGRESS: ApiError = {
  code: 'not_found',
  message:
    'There is no walk of that provider open for you. A walk opens by itself the first time ' +
    'something happens — a handoff, or declaring the account — so this either finished already ' +
    'or never started. Nothing is wrong: if you hold the account, kolonie.accounts.declare is ' +
    'what records it.',
}

/**
 * The database behind the port (`#601`).
 *
 * A thin adapter and nothing more: every decision — whether a walk is already
 * open, what a finished one does to the catalogue — is in
 * `packages/db/src/storage/account-walks.ts` beside the transaction it has to
 * happen in.
 */
export function databaseWalks(db: Database): WalkStore {
  return {
    open: (agentId, input) => walkInProgress(db, agentId, input),
    record: (walkId, step) => recordWalkStep(db, walkId, step),
    finish: (walkId, input) => finishWalk(db, walkId, input),
    async inProgress(agentId, input) {
      const id = await openWalkId(db, agentId, input)

      return id === undefined ? undefined : accountWalkById(db, id)
    },
    divergences: () => divergentWalks(db),
  }
}
