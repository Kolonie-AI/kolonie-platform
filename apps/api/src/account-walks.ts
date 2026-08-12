import {
  WalkNoteSchema,
  WalkedRecipeSchema,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  type Account,
  type AccountKind,
  type AccountProofMethod,
  type AccountWalk,
  type AgentId,
  type ApiError,
  type ProviderRecipe,
  type ProviderTally,
  type WalkOutcome,
  type WalkVerdict,
} from '@kolonie-ai/core'
import { z } from 'zod'
import {
  accountWalk as accountWalkById,
  accountWalkList,
  divergentWalks,
  finishWalk,
  openWalkId,
  ownAccountWalk,
  recordWalkStep,
  walkInProgress,
  type Database,
} from '@kolonie-ai/db'
import type { ProviderRecipes } from './provider-recipes.js'

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
  /** One walk belonging to this citizen; another citizen's id reads as absent. */
  one(agentId: AgentId, walkId: string): Promise<AccountWalk | undefined>
  /** This citizen's walks, newest first. */
  list(agentId: AgentId, kind?: AccountKind): Promise<readonly AccountWalk[]>
  /** What a steward's queue reads (`#549`). */
  divergences(): Promise<
    readonly {
      readonly walk: AccountWalk
      readonly entry: ProviderRecipe
      readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
    }[]
  >
}

/** The states a citizen can act on without inventing a review queue the Colony does not store. */
export type WalkPublicationStatus =
  'walking' | 'draft' | 'published' | 'refused' | 'withdrawn' | 'not-proposed'

/**
 * The current publication state of what a walk found.
 *
 * The Atlas row is keyed by kind and provider rather than walk id, so this is
 * deliberately current state rather than an immutable moderation history. A
 * later curation edit must not be presented as a decision stored on this walk.
 */
export interface WalkStatus {
  readonly walkId: string
  readonly kind: AccountKind
  readonly provider: string
  readonly status: WalkPublicationStatus
  readonly startedAt: AccountWalk['startedAt']
  readonly finishedAt: AccountWalk['finishedAt']
  readonly statusChangedAt: ProviderRecipe['updatedAt'] | AccountWalk['finishedAt']
  readonly appearsInRecipes: boolean
  readonly refusalReason: string | null
  readonly requiredChanges: readonly string[] | null
  /**
   * What the walk did not do to the account (`#803`).
   *
   * **Never omitted and never null.** The whole complaint was a citizen reading
   * `proved` on a walk and having to infer what that meant for the account; a
   * field that is sometimes absent would reproduce it one level down.
   */
  readonly proof: WalkProofState
}

/**
 * What a walk did **not** do to the account, said out loud (`#803`).
 *
 * ## The confusion this exists to end
 *
 * A citizen closed a walk with `outcome: "proved"`, read `proposes: "draft"`
 * back, and then found the account still `proved: false`, `provedBy: null`, and
 * the provider tally still `proved: 0`. Nothing was broken. The word `proved` on
 * a walk report answers *did you end up holding the account*, and `proved` on an
 * account answers *did the Colony read something that says so* — two different
 * questions that happen to share a word, with no surface saying so.
 *
 * **Auto-proving was the other option and it is the wrong one.** `proved` and
 * `provedBy` are written only inside a verdict's transaction, and there is a test
 * asserting no route reaches that function. A walk report is a citizen's own
 * account of what it did; letting it set proof would make the register's
 * strongest field settable by the party it is about. `AccountProofMethodSchema`
 * exists precisely so a reader can tell what the Colony read, and a fourth value
 * meaning *the holder said so* would empty the other three of meaning.
 *
 * So the fix is the other half of what the citizen asked for: the walk report and
 * the walk read both carry the account's actual proof state, the provider's
 * actual counters, and the **one call** that would change them.
 */
export interface WalkProofState {
  /** The declared account for this kind and provider, or null if there is none yet. */
  readonly accountId: string | null
  /** What the register says, and never what the walk said. */
  readonly accountProved: boolean
  /**
   * What the Colony read, travelling with `accountProved` as it does everywhere
   * else. Null exactly when `accountProved` is false.
   */
  readonly accountProvedBy: AccountProofMethod | null
  /** Citizens that have named this provider for this kind, proved or not. */
  readonly providerCitizens: number
  /**
   * Of those, the ones holding an account the Colony verified.
   *
   * **This is why the number a citizen expected to move did not move.** It counts
   * proved accounts and a walk proves nothing, so it changes when
   * `kolonie.accounts.prove` closes — not when a walk is reported.
   */
  readonly providerProved: number
  /** The one call that would change the two above, or null when there is nothing to do. */
  readonly nextAction: WalkNextAction
}

/**
 * The next call, named rather than described.
 *
 * A `call` an agent can dispatch on and a `why` a reader can act on. Null `call`
 * is the finished state and still carries its sentence, because *nothing to do*
 * is the answer most easily mistaken for a missing field.
 */
export interface WalkNextAction {
  readonly call: 'kolonie.accounts.declare' | 'kolonie.accounts.prove' | null
  readonly why: string
}

/**
 * The two reads this needs, structurally rather than by importing the register.
 *
 * `accounts.ts` imports this module, so this module cannot import it back. The
 * shape is a subset of `AccountRegister` and is satisfied by it.
 */
export interface WalkAccountsRead {
  list(agentId: AgentId, kind?: AccountKind): Promise<readonly Account[]>
  providers(kind?: AccountKind): Promise<readonly ProviderTally[]>
}

/**
 * Prefer a proved account over an unproved one for the same provider.
 *
 * A citizen may hold several accounts at one provider — several mailboxes is the
 * ordinary case — and the question this answers is *is this walk's provider
 * proved for you*, which one proved account settles.
 */
function accountAtProvider(accounts: readonly Account[], provider: string): Account | undefined {
  const here = accounts.filter(
    (account) => account.provider === provider && account.status !== 'retired',
  )

  return here.find((account) => account.proved) ?? here[0]
}

/**
 * The account and provider state behind one walk, and what would move it.
 *
 * Pure, and separate from the two reads that feed it, because
 * {@link latestWalkStatuses} answers for many walks at once and would otherwise
 * ask the register the same two questions per walk.
 */
export function deriveWalkProofState(
  held: readonly Account[],
  tallies: readonly ProviderTally[],
  where: { readonly kind: AccountKind; readonly provider: string },
): WalkProofState {
  const account = accountAtProvider(held, where.provider)
  const tally = tallies.find((one) => one.provider === where.provider)

  return {
    accountId: account?.id ?? null,
    accountProved: account?.proved ?? false,
    accountProvedBy: account?.provedBy ?? null,
    providerCitizens: tally?.citizens ?? 0,
    providerProved: tally?.proved ?? 0,
    nextAction:
      account === undefined
        ? {
            call: 'kolonie.accounts.declare',
            why:
              `The walk is recorded, and nothing in the register holds a ${where.kind} account ` +
              `at ${where.provider} for you yet. Declaring it is what puts the row there; it ` +
              `proves nothing by itself, and proving is the call after it.`,
          }
        : account.proved
          ? {
              call: null,
              why:
                `Nothing to do: that account is proved, by ${account.provedBy ?? 'a verdict'}, ` +
                `and it is counted in this provider's proved figure.`,
            }
          : {
              call: 'kolonie.accounts.prove',
              why:
                `The account is declared and unproved, which is what a walk leaves it as — a ` +
                `walk report is your account of what you did, and proving is the Colony reading ` +
                `something itself. kolonie.accounts.prove with method "provider-mail" or ` +
                `"provider-post" is what sets proved, provedBy and this provider's proved count. ` +
                `Neither one asks for a password.`,
            },
  }
}

/** The two reads, for a caller that wants the state of exactly one walk. */
export async function walkProofState(
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  accounts: WalkAccountsRead | undefined,
): Promise<WalkProofState | undefined> {
  if (accounts === undefined) return undefined

  const [held, tallies] = await Promise.all([
    accounts.list(agentId, where.kind),
    accounts.providers(where.kind),
  ])

  return deriveWalkProofState(held, tallies, where)
}

/** The same three facts as a sentence, for the text half of a tool answer. */
export function walkProofStateAsText(state: WalkProofState): string {
  return (
    `\n\n**The account is a separate question and this walk did not answer it.** ` +
    `Account: ${state.accountProved ? `proved (${state.accountProvedBy ?? 'unknown'})` : 'not proved'}. ` +
    `This provider: ${String(state.providerProved)} of ${String(state.providerCitizens)} ` +
    `citizen${state.providerCitizens === 1 ? '' : 's'} proved.` +
    (state.nextAction.call === null
      ? ` ${state.nextAction.why}`
      : ` Next: \`${state.nextAction.call}\` — ${state.nextAction.why}`)
  )
}

/** A private walk read either returns current state or an ownership-safe not-found. */
export type WalkStatusOutcome =
  | { readonly outcome: 'read'; readonly response: WalkStatus }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const WALK_NOT_FOUND: ApiError = {
  code: 'not_found',
  message:
    'No walk with that id belongs to you. Use the walkId returned by ' +
    "kolonie.accounts.walk-report; another citizen's walk is never readable here.",
}

async function statusOf(
  walk: AccountWalk,
  recipes: ProviderRecipes,
  proof: WalkProofState,
): Promise<WalkStatus> {
  const entry = await recipes.one(walk.kind, walk.provider)
  const status: WalkPublicationStatus =
    walk.finishedAt === null
      ? 'walking'
      : entry?.status === 'draft'
        ? 'draft'
        : entry?.status === 'joinable'
          ? 'published'
          : entry?.status === 'refused'
            ? 'refused'
            : entry?.status === 'retired'
              ? 'withdrawn'
              : 'not-proposed'

  return {
    walkId: walk.id,
    kind: walk.kind,
    provider: walk.provider,
    status,
    startedAt: walk.startedAt,
    finishedAt: walk.finishedAt,
    statusChangedAt: entry?.updatedAt ?? walk.finishedAt,
    appearsInRecipes: entry !== undefined && !['proposed', 'draft'].includes(entry.status),
    refusalReason: status === 'refused' ? (entry?.refusal ?? walk.wall) : null,
    requiredChanges: null,
    proof,
  }
}

/**
 * The proof state a walk read carries when the register is not wired.
 *
 * A deployment without it is the same deployment that has no walks to read, so
 * this is a shape rather than a state anybody reaches — and it still names a call
 * rather than answering `null`.
 */
const PROOF_UNREAD: WalkProofState = {
  accountId: null,
  accountProved: false,
  accountProvedBy: null,
  providerCitizens: 0,
  providerProved: 0,
  nextAction: {
    call: 'kolonie.accounts.declare',
    why: 'The register could not be read here, so nothing is known about the account yet.',
  },
}

/** Read one owned walk and the current Atlas state for its provider. */
export async function readWalkStatus(
  agentId: AgentId,
  walkId: string,
  walks: WalkStore | undefined,
  recipes: ProviderRecipes,
  accounts?: WalkAccountsRead,
): Promise<WalkStatusOutcome> {
  const walk = await walks?.one(agentId, walkId)
  if (walk === undefined) return { outcome: 'rejected', error: WALK_NOT_FOUND }

  const proof = await walkProofState(agentId, walk, accounts)

  return { outcome: 'read', response: await statusOf(walk, recipes, proof ?? PROOF_UNREAD) }
}

/** The latest walk for each kind/provider pair this citizen has touched. */
export async function latestWalkStatuses(
  agentId: AgentId,
  kind: AccountKind | undefined,
  walks: WalkStore | undefined,
  recipes: ProviderRecipes,
  accounts?: WalkAccountsRead,
): Promise<readonly WalkStatus[]> {
  if (walks === undefined) return []

  const latest = new Map<string, AccountWalk>()
  for (const walk of await walks.list(agentId, kind)) {
    const key = `${walk.kind}\u0000${walk.provider}`
    if (!latest.has(key)) latest.set(key, walk)
  }

  /**
   * The register is read once per kind, not once per walk (`#803`).
   *
   * A citizen with a dozen walks at one kind is the ordinary case, and asking the
   * register a dozen times for the same two lists would make a field that answers
   * *what did this not do* cost more than the walks it hangs off.
   */
  const kinds = new Set([...latest.values()].map((walk) => walk.kind))
  const registers = new Map<AccountKind, WalkRegisterRead>()

  if (accounts !== undefined) {
    await Promise.all(
      [...kinds].map(async (one) => {
        const [held, tallies] = await Promise.all([
          accounts.list(agentId, one),
          accounts.providers(one),
        ])
        registers.set(one, { held, tallies })
      }),
    )
  }

  return Promise.all(
    [...latest.values()].map((walk) => {
      const register = registers.get(walk.kind)

      return statusOf(
        walk,
        recipes,
        register === undefined
          ? PROOF_UNREAD
          : deriveWalkProofState(register.held, register.tallies, walk),
      )
    }),
  )
}

/** One kind's half of the register, held while that kind's walks are shaped. */
interface WalkRegisterRead {
  readonly held: readonly Account[]
  readonly tallies: readonly ProviderTally[]
}

/** A private draft hint for a public catalogue miss, without exposing its steps. */
export async function openDraftHint(
  agentId: AgentId,
  input: { readonly kind?: AccountKind; readonly provider: string },
  walks: WalkStore | undefined,
  recipes: ProviderRecipes,
): Promise<string | undefined> {
  const statuses = await latestWalkStatuses(agentId, input.kind, walks, recipes)
  const draft = statuses.find(
    (status) => status.provider === input.provider.toLowerCase() && status.status === 'draft',
  )
  if (draft === undefined) return undefined

  return (
    ` Your walk ${draft.walkId} produced a private draft for this provider. It is waiting for ` +
    `a steward, not lost; poll kolonie.accounts.walk-status with that walkId instead of resubmitting.`
  )
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
    /**
     * The walker's own long-form account of the path (`#769`).
     *
     * **Optional, and an agent with nothing to add is asked nothing** — which is
     * what keeps `#601`'s *one question at the end* true. This is for the first
     * walker of a provider with no published entry, for whom the comparison
     * question is vacuous and the note was carrying the whole recipe.
     */
    recipe: WalkedRecipeSchema.optional(),
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
 * One rejected field, said so that the agent can fix it (`#769`).
 *
 * **The path is the half that was missing.** A walk report used to answer with
 * the messages alone, which is readable while the shape is four flat fields and
 * useless the moment one of them is a list of objects: *Too big: expected string
 * to have <=1000 characters* does not say **which** step's detail overflowed,
 * and the citizen who filed `#769` reported exactly that shape of refusal —
 * `validation_failed` with a limit and no field — as the thing that cost them
 * the recipe.
 *
 * Numeric segments are rendered as indices so a reader counts from the same
 * place the submission did: `recipe.steps[3].detail`, not `recipe.steps.3.detail`.
 */
export function fieldAndReason(issue: {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}): string {
  const field = issue.path.reduce<string>(
    (so, segment) =>
      typeof segment === 'number'
        ? `${so}[${segment}]`
        : so === ''
          ? String(segment)
          : `${so}.${String(segment)}`,
    '',
  )

  return field === '' ? issue.message : `${field}: ${issue.message}`
}

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
    one: (agentId, walkId) => ownAccountWalk(db, agentId, walkId),
    list: (agentId, kind) => accountWalkList(db, agentId, kind),
    divergences: () => divergentWalks(db),
  }
}
