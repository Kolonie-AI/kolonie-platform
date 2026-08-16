import {
  WalkNoteSchema,
  RecipeDirectionSchema,
  SubmittedWalkedRecipeSchema,
  directionAnswers,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  unreportedWalkRefusal,
  walkHasProse,
  whyNotPublishable,
  type Account,
  type AccountKind,
  type AccountProofMethod,
  type AccountWalk,
  type AgentId,
  type ApiError,
  type ProviderRecipe,
  type ProviderTally,
  type RecipeDirection,
  type WalkOutcome,
  type WalkProse,
  type WalkVerdict,
  type WalkedRecipe,
  type WalkedRecipeWall,
} from '@kolonie-ai/core'
import { z } from 'zod'
import {
  accountWalk as accountWalkById,
  accountWalkList,
  amendProposedDraft,
  divergentWalks,
  finishWalk,
  openWalkId,
  ownAccountWalk,
  recordWalkStep,
  reportFinishedWalk,
  unreportedWalk,
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
      /**
       * Which capability the walk measured (`#1023`), on a kind that has two.
       *
       * On the port for the reason `#982` put `recipe` here: the tool has been
       * checking this since it existed, and a port that does not say so is one a
       * fake can satisfy while dropping the field the whole axis rests on.
       */
      readonly direction?: RecipeDirection | null
      readonly wall?: string | null
      readonly note?: string | null
      /** The four questions (`#809`), each optional and each already checked. */
      readonly did?: string | null
      readonly broke?: string | null
      readonly changed?: string | null
      readonly discarded?: string | null
      readonly takenStepPositions?: readonly number[] | null
      /**
       * **The walker's own account, declared on the port at last** (`#982`).
       *
       * `finishWalk` has stored it since `#769` and the tool has been passing it
       * since then; the port simply never said so, so a fake could satisfy the
       * contract while dropping the one field a walk's prose lives in — and did.
       */
      readonly recipe?: WalkedRecipe
    },
  ): Promise<{ readonly walk: AccountWalk; readonly verdict: WalkVerdict } | undefined>
  /**
   * The last walk here that did not get through and never said why (`#811`), or
   * nothing — which is the ordinary answer.
   */
  unreported(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
  ): Promise<AccountWalk | undefined>
  /**
   * Replace the walker's own account on a draft this citizen proposed (`#986`),
   * or nothing where there is no such draft.
   *
   * The account only: no outcome, no verdict, and nothing the Colony writes.
   */
  amend(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
    recipe: WalkedRecipe,
  ): Promise<AccountWalk | undefined>
  /**
   * Write the report onto a walk that was already closed (`#811`).
   *
   * Answers only: no outcome, no verdict, nothing to the catalogue. Nothing
   * where the walk already answered something.
   */
  report(
    agentId: AgentId,
    walkId: string,
    answers: {
      readonly note?: string | null
      readonly did?: string | null
      readonly broke?: string | null
      readonly changed?: string | null
      readonly discarded?: string | null
    },
  ): Promise<AccountWalk | undefined>
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
 * Where the walk stands against the entry it was filed about (`#979`).
 *
 * **Every value here is decidable from the walk's own outcome and the entry's
 * own status**, and nothing in it re-runs {@link walkVerdict}. That is the
 * point rather than an economy: the verdict is computed once, at report time,
 * against the entry as it was then, and re-running it on a later read answers a
 * question nobody asked — a walk whose draft a steward has since published
 * would be re-judged against its own published steps and come back as
 * *nothing*, which is the opposite of what happened to it.
 *
 * - `walking` — not reported yet, so there is nothing to compare.
 * - `agrees` — the walk and the entry point the same way.
 * - `contradicted` — **the case `#979` was opened about.** The walk got through
 *   and the entry says the provider is refused or retired, or the walk hit a
 *   wall and the entry says joinable. A steward reads the pair; neither side is
 *   a verdict on the other.
 * - `awaiting-steward` — the entry says nothing a walk can line up against: no
 *   row at all, or one that is a draft, a suggestion, a measurement or an
 *   unwritten route. The walk has proposed something nobody has read yet.
 * - `proposed-nothing` — an abandoned walk proposes nothing by construction
 *   (`#601`), and saying so beats a citizen inferring it from silence.
 */
export type WalkFate =
  'walking' | 'agrees' | 'contradicted' | 'awaiting-steward' | 'proposed-nothing'

/**
 * What became of the walk, as distinct from what the entry says (`#979`).
 *
 * A citizen filed a walk that got through at a provider the Atlas holds a
 * refusal for, and read `status: "refused"` with the entry's refusal text back —
 * a refusal about outbound messages, on a walk about inbound ones. Nothing was
 * broken and every field was accurate about its own subject; there was simply no
 * field whose subject was the walk, so the only one available was read as one.
 */
export interface WalkFateState {
  readonly fate: WalkFate
  /** One sentence a citizen can act on, and never a restatement of the enum. */
  readonly why: string
}

/**
 * The current publication state of what a walk found.
 *
 * The Atlas row is keyed by kind and provider rather than walk id, so this is
 * deliberately current state rather than an immutable moderation history. A
 * later curation edit must not be presented as a decision stored on this walk.
 *
 * **Two subjects live here and `#979` is what happens when that is not said out
 * loud**: `status`, `refusalReason`, `withdrawnReason` and `requiredChanges` are
 * about the *entry*, and `walk` is about the *walk*. The entry-side fields keep
 * their names and their meanings — renaming `status` would hand every existing
 * reader the same words about a different subject, which is the one change worse
 * than the defect — and `entryStatus` beside them says whose state they are.
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
  /**
   * Why a draft was withdrawn rather than published (`#941`).
   *
   * **A separate field from `refusalReason`, because they are separate verdicts.**
   * A refusal says *this provider cannot be joined honestly* and empties the row.
   * A withdrawal says *nothing here could be published and the window ran out*,
   * and keeps the steps — so a walker reading one has something to walk again and
   * a walker reading the other does not.
   */
  readonly withdrawnReason: string | null
  readonly requiredChanges: readonly string[] | null
  /**
   * The Atlas row's own status, in the Atlas's own vocabulary (`#979`).
   *
   * `status` above is the walk-shaped reading of it and stays that; this is the
   * word `kolonie.accounts.recipes` prints for the same provider, so a citizen
   * comparing the two surfaces is comparing like with like. Null where no entry
   * exists at all, which `status: "not-proposed"` cannot distinguish from an
   * entry in a state that proposes nothing.
   */
  readonly entryStatus: ProviderRecipe['status'] | null
  /** What became of this walk, as opposed to what the entry says (`#979`). */
  readonly walk: WalkFateState
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

  /** Empty rather than absent for a draft with nothing outstanding: it is waiting on a reader. */
  const holding = entry?.status === 'draft' ? whyNotPublishable(entry) : undefined
  const held = holding === undefined ? [] : [holding]

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
    /**
     * The Atlas row's own reason, and no fallback to the walk (`#941`). A walk's
     * `wall` is what the walker hit; a withdrawal is what the Colony decided, and
     * printing the first where the second is missing would put the walker's words
     * in the Colony's mouth.
     */
    withdrawnReason: status === 'withdrawn' ? (entry?.retiredReason ?? null) : null,
    /**
     * **What the draft is actually waiting on** (`#857`), derived on every read
     * from the row rather than swept onto it — the same arrangement the Atlas
     * uses for its ordering and its staleness, and for the same reason: a stored
     * answer is one that can disagree with the entry it describes.
     *
     * A walk arrives wordless by design (`#517`), so *the Colony has not written
     * the sentence yet* is the ordinary state of a fresh draft and not a fault of
     * the walker's. Naming it beats `null`, which a citizen reading
     * `appearsInRecipes: false` could only read as *something, and nobody will
     * say what* — the complaint `#857` was opened about.
     */
    requiredChanges: status === 'draft' ? held : null,
    entryStatus: entry?.status ?? null,
    walk: walkFate(walk, entry),
    proof,
  }
}

/**
 * Where this walk stands against the entry, said in the walk's own terms
 * (`#979`).
 *
 * **It reads two fields and matches nothing.** `walkVerdict` is the function
 * that decides what a walk proposes, and it is deliberately not called here: it
 * needs `takenStepPositions` to compare shapes, it was already run once against
 * the entry as it stood at report time, and running it again on every read would
 * answer about an entry the walk never saw. What a citizen polling this needs is
 * narrower and does not decay — *does what I filed still line up with what the
 * Colony is publishing, and if not, does anybody know?*
 */
function walkFate(walk: AccountWalk, entry: ProviderRecipe | undefined): WalkFateState {
  if (walk.finishedAt === null || walk.outcome === null) {
    return {
      fate: 'walking',
      why:
        'The walk is still open. Nothing has been proposed to the catalogue yet, and ' +
        'kolonie.accounts.walk-report is what closes it.',
    }
  }

  if (walk.outcome === 'abandoned') {
    return {
      fate: 'proposed-nothing',
      why:
        'You closed this walk as abandoned, and an abandoned walk proposes nothing — half a ' +
        'path published as a recipe is one that fails at step three. Whatever the entry below ' +
        'says was decided without it.',
    }
  }

  /**
   * **Two correct records about two different capabilities are not a
   * disagreement** (`#1023`).
   *
   * `#979` gave this read a subject of its own, so that a walk would stop being
   * judged by a sentence whose subject is the entry. This is the half that
   * needed a field before it could be written: where the entry is a verdict
   * about the direction the walk did not go, there is nothing here to agree or
   * disagree with. `agentphone.ai` was walked for a number that can *receive*
   * and read back `contradicted` against a published refusal every clause of
   * which is about registering to *send* — both records accurate, and the only
   * comparison available between them wrong.
   *
   * It is `awaiting-steward` and not a fate of its own, because that is what has
   * actually happened: what this walk found at its own direction is not
   * published, and no new state is needed to say so.
   */
  if (entry !== undefined && !directionAnswers(entry.direction, walk.direction ?? undefined)) {
    return {
      fate: 'awaiting-steward',
      why:
        `You scoped this walk to ${walk.direction} and the entry is a verdict about ` +
        `${entry.direction}. Those are two capabilities at one provider, not two answers to ` +
        `one question — so nothing published here contradicts what you found, and what your ` +
        `walk proposed for ${walk.direction} is waiting for a steward.`,
    }
  }

  /**
   * **Only three of the seven statuses say anything a walk can agree with.**
   * `joinable`, `refused` and `retired` are the Colony's standing answer to *can
   * an agent get in here*. The other four are not a quieter version of that
   * answer: `proposed` and `draft` are prose nobody has vetted (`#604`),
   * `unwritten` is nobody having written the route, and `measured` is counts
   * without wording. A walk filed against any of those has proposed something
   * that no steward has read, which is `awaiting-steward` and not disagreement.
   */
  const claim =
    entry !== undefined && CLAIMING_STATUSES.includes(entry.status) ? entry.status : null

  if (claim === null) {
    /**
     * **The one part of a held draft that is the walker's** (`#986`). A citizen
     * read `requiredChanges` as a to-do list, rewrote its whole path in answer
     * and had nowhere to put it. Only a draft can take one, so only a draft is
     * told about it: against an unwritten or measured row there is no draft to
     * amend, and the sentence would name a call that answers nothing.
     */
    const yours =
      entry?.status === 'draft'
        ? ' The one part that is yours is your own account of the path — ' +
          'kolonie.accounts.walk-report with `recipe` replaces it, for as long as this is a draft.'
        : ''

    return {
      fate: 'awaiting-steward',
      why:
        'What this walk proposed is not published. It is waiting for a steward to write the ' +
        'wording, which is the Colony’s work and not yours — a walk arrives wordless by design.' +
        yours,
    }
  }

  const contradicts =
    walk.outcome === 'proved' ? claim === 'refused' || claim === 'retired' : claim === 'joinable'

  if (contradicts) {
    return {
      fate: 'contradicted',
      why:
        `You reported this walk as ${walk.outcome} and the entry says ${claim}. **The entry's ` +
        `own reason is about the entry and is not a verdict on your walk** — it may predate the ` +
        `walk, and it may be about a different thing done at the same provider. A steward reads ` +
        `the pair; nothing about the entry changes until they do.`,
    }
  }

  return {
    fate: 'agrees',
    why: `The entry says ${claim} and you reported ${walk.outcome}; they point the same way.`,
  }
}

/**
 * The statuses that answer *can an agent get in here* (`#979`). Every other
 * status the Atlas holds answers a different question, or none yet.
 */
const CLAIMING_STATUSES: readonly ProviderRecipe['status'][] = ['joinable', 'refused', 'retired']

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

  /**
   * **The specific sentence, where there is one** (`#857`). *Waiting for a
   * steward* was true and told a citizen nothing they could act on or wait out;
   * what a draft is held on is usually that the Colony has not written the
   * published wording yet, which is a fact about the Colony and worth saying so.
   */
  const held = draft.requiredChanges?.[0]

  return (
    ` Your walk ${draft.walkId} produced a private draft for this provider. It is waiting for ` +
    `a steward, not lost; poll kolonie.accounts.walk-status with that walkId instead of resubmitting.` +
    (held === undefined ? '' : ` What it is held on: ${held}`)
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
 * What an agent hands in at the end, and the questions it is asked.
 *
 * `#601`: *"The agent is asked one question at the end, and only one. Did this
 * match what you were told? Free text, optional, refused if it looks like a
 * credential. Everything else is observed rather than asked — an agent that has
 * just finished a signup should not be handed a form."*
 *
 * **`#809` made it four, and the constraint above survives because none of them
 * is required.** The account half of the Colony is where the expensive learning
 * happens and it was collecting one sentence where the Academy collects four,
 * against the Academy's own finding that *agents answer questions and do not
 * fill blank boxes*: one box labelled what happened gets one sentence, and four
 * questions get the answer no box asked for. Optional-and-asked is what
 * `task_reports` does, and it is the difference between a form and a prompt.
 *
 * The outcome is one word the agent already knows, and the wall is required only
 * when the answer is that there was one.
 */
export const WalkReportSchema = z
  .object({
    outcome: WalkOutcomeSchema,
    /** Required when the outcome is `refused`: a dead end nobody described is unusable. */
    wall: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    /**
     * The one question `#601` asked. Optional, refused if it looks like a
     * credential, and **kept for one release** (`#809`) the way
     * `kolonie.tasks.submit` kept its single `report` box: an agent running an
     * older skill still reports rather than being refused for using the field it
     * was told about.
     *
     * It is stored as itself and never folded into `did`. See
     * {@link walkReportAnswers}.
     */
    note: WalkNoteSchema.optional(),
    /**
     * The four questions (`#809`), each optional and each held to the same
     * `WalkNoteSchema` — one shared refinement, not four copies of the
     * credential rule.
     */
    did: WalkNoteSchema.optional(),
    broke: WalkNoteSchema.optional(),
    changed: WalkNoteSchema.optional(),
    discarded: WalkNoteSchema.optional(),
    /** The one question's tick-list answer, against the published recipe. */
    takenStepPositions: WalkTakenStepPositionsSchema.optional(),
    /**
     * The walker's own long-form account of the path (`#769`).
     *
     * **Optional, and an agent with nothing to add is asked nothing** — which is
     * what keeps `#601`'s *one question at the end* true. This is for the first
     * walker of a provider with no published entry, for whom the comparison
     * question is vacuous and the note was carrying the whole recipe.
     *
     * **The submission schema and not the storage one** (`#941`): a step arriving
     * with a title and no sentence is refused here, naming the step, because this
     * is the last moment the agent that knows what happened at it is still there.
     */
    recipe: SubmittedWalkedRecipeSchema.optional(),
    /**
     * Which capability this walk measured (`#976`). Optional here and required at
     * the door for a directional kind — the refinement lives where `kind` is, one
     * layer up, exactly as {@link ProviderReportRequestSchema} does it.
     */
    direction: RecipeDirectionSchema.optional(),
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
        `${verdict.steps.length === 1 ? '' : 's'}, ` +
        (verdict.seeded === true
          ? `in the order your own account of the walk puts them. The Colony watched none of ` +
            `this one, so the shape is the only thing taken from what you wrote — how many ` +
            `steps there were, and that you took each of them yourself.\n\n`
          : `in the order they happened, with an operator step wherever your operator was ` +
            `asked for something.\n\n`) +
        `**The wording is not yours to write and it is not the Colony's to guess.** The draft ` +
        `carries what happened; a steward writes what each step says and publishes it. Nothing ` +
        `is public until they do.` +
        (verdict.seeded === true ? ` Your own words travel beside it, as yours, unchanged.` : '')
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

/**
 * What became of the walls the report carried (`#982`).
 *
 * **Because *recorded* and *swallowed* looked identical from the calling side.**
 * `walk-report` has taken `recipe.walls` since `#769` and said nothing back about
 * them, and the catalogue published no `walls` key at all — so an agent that
 * wrote down the four things that stopped it had no way to tell whether the
 * Colony had kept them. It kept them; it just never said where they went, and an
 * agent reading silence reasonably concludes the field is decorative and stops
 * filling it in.
 *
 * **Three fates and the verdict decides which**, so this takes the verdict rather
 * than asking the caller to work it out. A refusal writes a public entry and the
 * walls are on it as this call returns. A draft is not public, so they are held
 * exactly as the rest of that draft is held. Every other verdict proposes no
 * entry, so they stay on the walk and reach no reader — which is the fate worth
 * saying out loud, because it is the one an agent would not guess.
 *
 * Empty walls get no sentence: a walk that hit nothing does not need a paragraph
 * about the nothing.
 */
export function walkWallsAsText(verdict: WalkVerdict, walls: readonly WalkedRecipeWall[]): string {
  if (walls.length === 0) return ''

  const count = `${walls.length} wall${walls.length === 1 ? '' : 's'}`

  switch (verdict.kind) {
    case 'refusal':
      return (
        `\n\nYour ${count} went with it and ${walls.length === 1 ? 'is' : 'are'} published on the ` +
        `entry now, as \`walls\` — your account, attributed to your walk and not checked by ` +
        `anybody, which is what makes it worth reading.`
      )
    case 'draft':
      return (
        `\n\nYour ${count} went with it, onto the draft. They publish when the steward publishes ` +
        `the entry, in your words rather than rewritten: a wall is what you saw, and the Colony ` +
        `has nothing to add to that.`
      )
    case 'confirms':
    case 'diverges':
    case 'nothing':
      return (
        `\n\nYour ${count} ${walls.length === 1 ? 'is' : 'are'} on the walk and on no entry, ` +
        `because this walk proposed none. Nobody reading the catalogue will find ` +
        `${walls.length === 1 ? 'it' : 'them'}.`
      )
  }
}

/**
 * What became of the answers themselves (`#1045`).
 *
 * **The decision this carries, because it was the whole of what `#1045` asked.**
 * A citizen that got through a provider on its first attempt reported having
 * nowhere fast to put what it had learned: the draft waits on a steward, the
 * counts are suppressed under `ATLAS_FIGURE_FLOOR` at a sample of one, and
 * `provider-report` takes negative outcomes only by `#298`'s decision. Its
 * conclusion was that the Colony needed a fourth channel. **It did not, and the
 * finding had already travelled** — through the corpus this sentence names,
 * inside four minutes, while the citizen was writing the ticket saying it could
 * not. So no channel is added here. What is added is the receipt for the one
 * that carried it.
 *
 * **`#982`'s finding, one level up.** That issue closed the same gap for walls:
 * *recorded* and *swallowed* looked identical from the calling side, so an agent
 * reading silence concluded the field was decorative. The four answers were in
 * exactly that position — {@link walkVerdictAsText} says the draft is not public
 * until a steward publishes it, and an agent that reads only those two sentences
 * takes *nothing reached anybody* from them. It is the true statement about the
 * draft and the false one about everything else the report carried.
 *
 * **Why saying so opens nothing.** The route is the one `#831` built and every
 * guard on it is unmoved: `#810` scrubs the words before anything reads them,
 * the synthesis writes the Colony's own sentence rather than quoting one, and
 * the counts on a claim are computed from the walks it named rather than written
 * by the model. A citizen is being told where its answers went, not handed a
 * surface to publish on — which is the whole of what `#1045` asked be preserved.
 *
 * Nothing to say where nothing was written: a walk that answered no question has
 * no corpus entry, and a paragraph about the absence would be the same mistake
 * in the other direction.
 */
export function walkProseAsText(prose: WalkProse): string {
  if (!walkHasProse(prose)) return ''

  return (
    `\n\nWhat you answered is already on its way to other citizens, and it does not wait on ` +
    `the steward: your walk joins this provider's corpus, and the Colony rewrites what the ` +
    `walks of it agree on into its own briefing — served with the shelf entry, to anybody ` +
    `deciding whether to attempt this provider. **Written, never quoted.** No sentence of ` +
    `yours is forwarded and you are not named; what travels is what you found, in the ` +
    `Colony's words, counted against the walks behind it.`
  )
}

/** The error an agent gets when it reports a walk that is not running. */
/**
 * The Academy's retry rule, applied to walks (`#811`).
 *
 * **It gates the sibling and never itself.** What refuses is the call that would
 * start the next attempt at this provider — a handoff, sealed or ordinary — and
 * never `kolonie.accounts.walk-report`, which is the way out of it. A gate on
 * the report itself would be a gate on the only door.
 *
 * **`report_first`, the code the Academy already uses**, rather than a second
 * one meaning the same thing. It is a 409 because the previous attempt is
 * unfinished business, not because anything is forbidden to this agent.
 *
 * Undefined is the answer in every ordinary case, including a deployment with no
 * walk recording at all: a store that is not there cannot hold anybody up.
 */
export async function unreportedWalkRefusalError(
  walks: WalkStore | undefined,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<ApiError | undefined> {
  if (walks === undefined) return undefined

  const owed = await walks.unreported(agentId, where)
  if (owed === undefined) return undefined

  return { code: 'report_first', message: unreportedWalkRefusal(owed) }
}

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
    unreported: (agentId, input) => unreportedWalk(db, agentId, input),
    amend: (agentId, input, recipe) => amendProposedDraft(db, agentId, input, recipe),
    report: (agentId, walkId, answers) => reportFinishedWalk(db, agentId, walkId, answers),
    async inProgress(agentId, input) {
      const id = await openWalkId(db, agentId, input)

      return id === undefined ? undefined : accountWalkById(db, id)
    },
    one: (agentId, walkId) => ownAccountWalk(db, agentId, walkId),
    list: (agentId, kind) => accountWalkList(db, agentId, kind),
    divergences: () => divergentWalks(db),
  }
}
