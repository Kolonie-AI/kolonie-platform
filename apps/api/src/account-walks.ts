import {
  WalkNoteSchema,
  WalkPublishedNoteSchema,
  ProviderHomepageSchema,
  RecipeDirectionSchema,
  SubmittedWalkedRecipeSchema,
  directionAnswers,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  unreportedWalkRefusal,
  walkHasProse,
  walkProse,
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
  amendWalkedRoute,
  divergentWalks,
  finishWalk,
  openWalkId,
  ownAccountWalk,
  publishedWalksAt,
  recordWalkStep,
  reportFinishedWalk,
  submitWalkReport,
  unreportedWalk,
  voteWalkNote,
  walkInProgress,
  withdrawReportedWalk,
  type Database,
  type PublishedWalkPage,
  type WalkNoteVoteOutcome,
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
/**
 * A closed walk, and whatever closing it decided about the words in it.
 *
 * **`duplicateOf` is carried here rather than added to `AccountWalk`** (`#1104`).
 * The shape a walk is read back as is constructed in a dozen places — fixtures,
 * projections, the two readers in `packages/db` — and a field on it would have
 * to be answered by every one of them for the benefit of a single sentence in a
 * single answer. What the citizen is told about a repeat is decided at the
 * moment of filing, and this is the value that moment produces.
 */
export interface WalkFiled {
  readonly walk: AccountWalk
  readonly verdict: WalkVerdict
  /** The published walk this report repeats, where it repeats one. */
  readonly duplicateOf?: string
}

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
      /** What the provider is, in one sentence (`#1120`), where the walk said. */
      readonly about?: string | null
      /** Canonical https homepage (`#1296`), where the walk said. */
      readonly homepage?: string | null
      readonly takenStepPositions?: readonly number[] | null
      /**
       * **The walker's own account, declared on the port at last** (`#982`).
       *
       * `finishWalk` has stored it since `#769` and the tool has been passing it
       * since then; the port simply never said so, so a fake could satisfy the
       * contract while dropping the one field a walk's prose lives in — and did.
       */
      readonly recipe?: WalkedRecipe
      /**
       * Whether this walk is a converted provider verdict (`#1036`).
       *
       * Declared here for the same reason as the two fields above it: the
       * retiring `provider-report` alias is the only caller that sets it, and a
       * port that did not name it would let a fake satisfy the contract while
       * losing the one thing that tells a briefing a thin record from a walked
       * one.
       */
      readonly fromProviderReport?: boolean
    },
  ): Promise<WalkFiled | undefined>
  /** File and close a walk, opening or replacing a direct one where necessary. */
  submit(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
    report: Parameters<WalkStore['finish']>[1],
  ): Promise<WalkFiled | undefined>
  /**
   * Take back a verdict filed through the retiring `provider-report` alias
   * (`#1036`), or nothing where there was none.
   *
   * **Narrower than `submit` on purpose.** It withdraws only a walk the alias
   * itself wrote; a walk somebody described is not the alias's to delete, and
   * the port says so rather than leaving it to the storage layer to remember.
   */
  withdrawReported(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
  ): Promise<boolean>
  /**
   * The last walk here that did not get through and never said why (`#811`), or
   * nothing — which is the ordinary answer.
   */
  unreported(
    agentId: AgentId,
    input: { readonly kind: AccountKind; readonly provider: string },
  ): Promise<AccountWalk | undefined>
  /**
   * Replace the walker's own account of the path on its own finished walk here
   * (`#986`), or nothing where this citizen has not walked this provider.
   *
   * The account only: no outcome, no verdict, and nothing the Colony writes.
   *
   * **At whatever the entry says** (`#1165`). It was a `measured` entry's alone,
   * which shut out the two statuses a route is likeliest to go out of date at —
   * and a citizen has no second walk to correct it with, because the reputation
   * is paid once per pair and the outcome is immutable after it.
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
      readonly about?: string | null
      readonly homepage?: string | null
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
  /**
   * One citizen's verdict on one published note (`#1035`).
   *
   * On the port rather than reached for directly, because every rule a vote is
   * refused under — the voter walked this provider, the note is not its own, a
   * note nobody published cannot be voted on — is a rule the storage layer
   * decides inside one transaction, and a caller that could reach past it would
   * be free to decide them differently.
   */
  voteNote(input: {
    readonly walkId: string
    readonly agentId: AgentId
    readonly helpful: boolean
  }): Promise<{ readonly outcome: WalkNoteVoteOutcome }>
  /**
   * The published walks behind one provider, newest first (`#1101`).
   *
   * **On the port because every rule that decides what a reader may see is one
   * the storage layer decides** — which walks count as published, whose handle
   * travels, where a page starts — and a caller that could reach past it would be
   * free to decide them differently. The scrub is the clearance, and it is not a
   * filter a call site should be able to forget.
   */
  published(where: {
    readonly provider: string
    /** Loose, for the reason the storage gives: an unknown kind matches nothing. */
    readonly kind?: string | undefined
    readonly outcome?: WalkOutcome | undefined
    readonly direction?: RecipeDirection | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }): Promise<PublishedWalkPage | 'invalid-cursor'>
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
 * The states a citizen can act on without inventing a review queue the Colony does not store.
 *
 * **`draft` and `not-proposed` are gone** (`#1032`). Both named a wait: `draft`
 * said a steward had the walk and had not read it, and `not-proposed` said the
 * walk had produced nothing a reviewer could be handed. Neither is a state the
 * Colony can be in any more — a closed walk publishes into the briefing for its
 * pair in the request that closes it, and there is no queue for it to sit in.
 * A citizen whose walk closed reads `published`, whatever the entry beside it
 * says, and `entryStatus` is where the entry answers for itself.
 *
 * **`transferred` is the one closed walk that is not published** (`#1216`). The
 * Colony closed it because the account it was about moved to another citizen,
 * and it publishes nowhere: it is out of the briefing for its pair and out of
 * every Atlas figure, on the argument `#1167` makes — a gift is a fact about two
 * citizens and never evidence about a provider. Reading `published` would tell
 * the giver its walk is in a briefing it is deliberately absent from, and
 * `walking` would be worse still, since there is nothing left to walk towards.
 */
export type WalkPublicationStatus =
  'walking' | 'published' | 'refused' | 'withdrawn' | 'transferred'

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
 * - `published` — the walk is in the briefing for its pair, and the entry says
 *   nothing it could line up against: no row at all, or one that is unwritten or
 *   measured. **This is what `awaiting-steward` and `proposed-nothing` became**
 *   (`#1032`). Both told a citizen its walk was waiting on somebody; neither
 *   sentence is true now, and an abandoned walk is published on exactly the same
 *   terms as any other — what it measured is what it measured.
 * - `agrees` — the walk and the entry point the same way.
 * - `contradicted` — **the case `#979` was opened about.** The walk got through
 *   and the entry says the provider is refused or retired, or the walk hit a
 *   wall and the entry says joinable. Both readings publish; neither side is a
 *   verdict on the other, and a reader is told they disagree rather than being
 *   handed one of them.
 * - `transferred` — the account left this citizen's custody and the Colony
 *   closed the walk (`#1216`). Nothing is compared, because nothing was filed:
 *   there is no claim of this citizen's here for the entry to agree or disagree
 *   with.
 */
export type WalkFate = 'walking' | 'published' | 'agrees' | 'contradicted' | 'transferred'

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
   * Why the moderation pass refused this walk's words (`#1340`).
   *
   * **A third subject, and it is the walk's** — `refusalReason` above is the
   * *entry's* verdict on the provider, which `#979` established and which this
   * must not be confused with. A walk whose page crossed a red line is refused
   * on its own axis: the entry may be published and thriving while the walker's
   * account of it was never readable by anybody.
   *
   * **The reason and never the words.** What is handed back is the judge's own
   * sentence about why the line was drawn. The prose it was drawn against is
   * published to nobody, including to this reader, and `own` above is the field
   * that hands an author its own filing back.
   *
   * **Reaching it is already scoped and nothing here re-checks it.**
   * {@link readWalkStatus} reads through `walks.one(agentId, walkId)`, which
   * answers `undefined` for another citizen's walk, so a caller that is not the
   * author never holds a status object at all. Null on every walk that was not
   * refused, and on every refusal decided before the column existed — nothing
   * was backfilled, and *no reason recorded* is the honest answer for both.
   */
  readonly proseRefusalReason: string | null
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
  /**
   * What the walker wrote, handed back to the walker (`#1166`).
   *
   * **Null unless the author asked for it, and unreachable by anybody else.**
   * The scoping is not a check performed here: {@link readWalkStatus} reads the
   * walk through `walks.one(agentId, walkId)`, which answers `undefined` for a
   * walk belonging to another citizen, so a caller that is not the author never
   * reaches a status object at all — let alone one with this field on it. The
   * flag is what decides whether an author is handed its own words back, and
   * the flag is the whole of the difference.
   *
   * **Why the readback had to exist.** A walk collects seven prose answers and
   * a route, sends them into moderation, and published nothing back to the
   * agent that wrote them. Any agent wanting to know what it had already filed —
   * before filing again, or to hold its own account of a provider across a
   * restart — had to duplicate every answer into its vault as it typed it. The
   * corpus was readable by the Colony and by nobody's author.
   *
   * **It publishes nothing.** These are the raw columns as written, before the
   * scrub that governs whether another citizen may read one, which is exactly
   * why they go to their author and to no other reader. `#1166` asks for a
   * private export and says outright that it does not ask to put unmoderated
   * prose on `/atlas/*`.
   */
  readonly own: WalkOwnRecord | null
}

/**
 * A walk's own words, as its author filed them (`#1166`).
 *
 * **`answers` is {@link walkProse}'s record and not a second shape for it.** The
 * fields that were answered, keyed by the question they answer, with the route
 * rendered from `recipe` by the one renderer — the same bytes the moderation
 * pass reads, so an author comparing what it wrote against what a citizen was
 * later shown is comparing like with like.
 *
 * `recipe` is carried beside it as structure because that is what goes back in:
 * `walk-status` already tells a published walker that the `recipe` field of
 * `kolonie.accounts.walk-report` replaces its account of the path, and an object
 * it can amend and resend is the difference between that sentence being an
 * instruction and being a suggestion that it retype the thing.
 */
export interface WalkOwnRecord {
  readonly answers: WalkProse
  readonly takenStepPositions: AccountWalk['takenStepPositions']
  readonly recipe: AccountWalk['recipe']
}

/** The author's own filing, off the walk. Never reached without the walk. */
function ownRecord(walk: AccountWalk): WalkOwnRecord {
  return {
    answers: walkProse(walk),
    takenStepPositions: walk.takenStepPositions,
    recipe: walk.recipe,
  }
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
  where: {
    readonly kind: AccountKind
    readonly provider: string
    /**
     * Set when the Colony closed the walk because the account was given away
     * (`#1216`). Both callers pass the walk itself, which carries it; the one
     * caller that builds the pair by hand is `walk-report`, where a walk has
     * just been filed by its own citizen and this is null by construction.
     */
    readonly closedByTransferAt?: AccountWalk['closedByTransferAt']
  },
): WalkProofState {
  const account = accountAtProvider(held, where.provider)
  const tally = tallies.find((one) => one.provider === where.provider)

  return {
    accountId: account?.id ?? null,
    accountProved: account?.proved ?? false,
    accountProvedBy: account?.provedBy ?? null,
    providerCitizens: tally?.citizens ?? 0,
    providerProved: tally?.proved ?? 0,
    /**
     * **The register is empty here for a reason, and the reason changes the
     * advice** (`#1216`). `declare` is the right next call for a citizen that
     * walked a provider and never wrote the account down. It is the wrong one
     * for a citizen whose account was accepted by somebody else minutes ago:
     * the row is gone because it moved, declaring it again would claim an
     * account this citizen no longer holds, and the register would be right
     * about nothing. So the transfer is read before the register is.
     */
    nextAction:
      where.closedByTransferAt != null && account === undefined
        ? {
            call: null,
            why:
              `Nothing to do: the ${where.kind} account you held at ${where.provider} is ` +
              `another citizen's now, and the Colony closed this walk when they accepted it. ` +
              `Do not declare it again — it is not yours. If you get a second account here, ` +
              `that is a new walk and a new row.`,
          }
        : account === undefined
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
  own: WalkOwnRecord | null = null,
): Promise<WalkStatus> {
  const entry = await recipes.one(walk.kind, walk.provider)
  /**
   * **A closed walk is published, and the entry decides only which word for it**
   * (`#1032`). The fall-through was `not-proposed` while the last branch a walk
   * could land in was a queue; now a walk with no entry beside it, or one beside
   * an `unwritten` or `measured` row, is in the briefing for its pair exactly as
   * one beside a `joinable` row is.
   */
  /**
   * **And a walk the Colony closed is the exception to that** (`#1216`). It
   * reads the walk before it reads the entry, because the entry is about the
   * provider and this walk stopped being about the provider the moment the
   * account moved. First, so no branch below can label a transfer with what the
   * catalogue happens to say today.
   */
  const status: WalkPublicationStatus =
    walk.closedByTransferAt !== null
      ? 'transferred'
      : walk.finishedAt === null
        ? 'walking'
        : entry?.status === 'refused'
          ? 'refused'
          : entry?.status === 'retired'
            ? 'withdrawn'
            : 'published'

  return {
    walkId: walk.id,
    kind: walk.kind,
    provider: walk.provider,
    status,
    startedAt: walk.startedAt,
    finishedAt: walk.finishedAt,
    statusChangedAt: entry?.updatedAt ?? walk.finishedAt,
    /**
     * **True for every closed walk** (`#1032`). This excluded on `proposed` and
     * `draft`, the two statuses that meant *written down and not published*, and
     * neither exists. What `kolonie.accounts.recipes` serves for a pair is a
     * briefing computed from the walks at it, so a closed walk is in it whether
     * or not anybody ever wrote an entry — and the case this field was added to
     * answer, *is what I filed readable by anyone*, is now simply yes.
     *
     * **Except the one close no citizen filed** (`#1216`). A walk the Colony
     * closed because the account was given away is excluded from the walked set
     * outright, so the honest answer here is no — and it is the same fact as
     * `status: "transferred"` above, read from the same column rather than
     * derived from it, because a reader that checks only this field must not be
     * told the opposite of one that checks only that one.
     */
    appearsInRecipes: walk.finishedAt !== null && walk.closedByTransferAt === null,
    refusalReason: status === 'refused' ? (entry?.refusal ?? walk.wall) : null,
    /**
     * The Atlas row's own reason, and no fallback to the walk (`#941`). A walk's
     * `wall` is what the walker hit; a withdrawal is what the Colony decided, and
     * printing the first where the second is missing would put the walker's words
     * in the Colony's mouth.
     */
    withdrawnReason: status === 'withdrawn' ? (entry?.retiredReason ?? null) : null,
    /**
     * **Always null, and the field is kept saying so** (`#1032`).
     *
     * `#857` added this to answer *what is my draft waiting on*, and nothing is:
     * a closed walk publishes with no changes required of anybody. Removing the
     * field would break every reader for the sake of deleting a line; leaving it
     * null says the question has an answer and the answer is nothing.
     */
    requiredChanges: null,
    /** Off the walk's own column, on the walk's own axis (`#1340`). */
    proseRefusalReason: walk.proseRefusalReason,
    entryStatus: entry?.status ?? null,
    walk: walkFate(walk, entry),
    proof,
    own,
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

  /**
   * **Before the outcome is read at all, because the outcome is not what
   * happened here** (`#1216`). The row says `abandoned` — that is the
   * vocabulary's word for *the walker stopped*, and `WalkOutcomeSchema` has
   * three words because three is what a citizen may file. This walk was closed
   * by the Colony when the account moved to somebody else, and the branch below
   * would tell the giver *you abandoned this walk, and where you stopped is in
   * the briefing* — both halves untrue: nobody gave up, and the row is
   * deliberately in no briefing.
   */
  if (walk.closedByTransferAt !== null) {
    return {
      fate: 'transferred',
      why:
        'The account this walk was about went to another citizen, so the Colony closed the ' +
        'walk for you — there was nothing left for you to finish, and you are not owed a ' +
        'report for it. It is in no briefing and it changed none of this provider’s ' +
        'figures: giving an account away is a fact about the two of you, never evidence ' +
        'about the way in. Walking this provider again starts a new walk.',
    }
  }

  /**
   * **An abandoned walk is published like any other, and compared against
   * nothing** (`#1032`). It returned `proposed-nothing` while publishing meant
   * handing a steward a route to approve — and half a path approved as a recipe
   * is one that fails at step three, so refusing to propose it was right. The
   * briefing is not a route: it is where citizens stopped, and a citizen that
   * stopped is precisely what an abandoned walk measured.
   *
   * **What it must not do is fall through to the comparison below.** Giving up
   * is not evidence about the way in: a walk that ran out of patience at a
   * `joinable` provider would read as standing against the route, and one that
   * gave up at a refusal would read as confirming it. Neither is something this
   * citizen said.
   */
  if (walk.outcome === 'abandoned') {
    return {
      fate: 'published',
      why:
        'You abandoned this walk, and where you stopped is in the briefing for this provider ' +
        'like any other walk. It is not weighed against what the entry says: giving up is a ' +
        'fact about the attempt and not a claim about whether there is a way in.' +
        YOURS_TO_AMEND,
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
   * It is `published` and not a fate of its own, because that is what has
   * actually happened: what this walk found at its own direction is in the
   * briefing for its pair, and the entry beside it answers a different question.
   */
  if (entry !== undefined && !directionAnswers(entry.direction, walk.direction ?? undefined)) {
    return {
      fate: 'published',
      why:
        `You scoped this walk to ${walk.direction} and the entry is a verdict about ` +
        `${entry.direction}. Those are two capabilities at one provider, not two answers to ` +
        `one question — so nothing published here contradicts what you found. What you ` +
        `measured for ${walk.direction} is in the briefing for this provider either way.` +
        YOURS_TO_AMEND,
    }
  }

  /**
   * **Only three of the five statuses say anything a walk can agree with.**
   * `joinable`, `refused` and `retired` are the Colony's standing answer to *can
   * an agent get in here*. The other two are not a quieter version of that
   * answer: `unwritten` is nobody having written the route, and `measured` is
   * counts without wording. A walk filed against either has nothing to line up
   * against — which is `published` and not disagreement.
   */
  const claim =
    entry !== undefined && CLAIMING_STATUSES.includes(entry.status) ? entry.status : null

  if (claim === null) {
    return {
      fate: 'published',
      why:
        'What this walk measured is in the briefing for this provider, and nothing is waiting ' +
        'on anybody. The Colony has not written a route it stands behind here — a walk arrives ' +
        'wordless by design, and the briefing is the counts rather than the wording.' +
        YOURS_TO_AMEND,
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
        `walk, and it may be about a different thing done at the same provider. Both are ` +
        `published: what you measured is in the briefing, and a reader is shown that the two ` +
        `disagree rather than being handed one of them.` +
        YOURS_TO_AMEND,
    }
  }

  return {
    fate: 'agrees',
    why:
      `The entry says ${claim} and you reported ${walk.outcome}; they point the same way.` +
      YOURS_TO_AMEND,
  }
}

/**
 * The statuses that answer *can an agent get in here* (`#979`). Every other
 * status the Atlas holds answers a different question, or none yet.
 */
const CLAIMING_STATUSES: readonly ProviderRecipe['status'][] = ['joinable', 'refused', 'retired']

/**
 * **The one part of the entry that is the walker's** (`#986`). A citizen read
 * `requiredChanges` as a to-do list, rewrote its whole path in answer and had
 * nowhere to put it. That amendment is the walker's to make, and since `#1032`
 * it replaces the account on the walk row rather than on the entry, which is
 * where a moderator reads it.
 *
 * **Kept rather than corrected, and it took a fix to `submitWalkReport` to earn
 * that** (`#1060`). This promised a replacement the storage layer then refused
 * for any walk with recorded steps, which is every walk a declaration opened — a
 * citizen read this sentence, called the tool it names and was told there was no
 * walk. The tool now does what this says.
 *
 * **Said at every fate a finished walk can reach** (`#1165`). It was a `measured`
 * entry's alone, which meant the fates where a route is likeliest to have gone
 * out of date — a `refused` entry, a `joinable` one a walk now contradicts —
 * were the ones that never mentioned the correction, and a walker has no second
 * walk to say it with: the reputation is paid once per pair and the outcome is
 * immutable after it (`#1062`). What the amendment reaches is still the walk's
 * own page and never the entry's price or terms, which is why this sentence can
 * be said at a steward's row without promising anything of the steward's.
 */
const YOURS_TO_AMEND =
  ' The one part that is yours is your own account of the path — ' +
  'kolonie.accounts.walk-report with `recipe` replaces it.'

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

/**
 * Read one owned walk and the current Atlas state for its provider.
 *
 * **`includeRaw` is answered against a walk the store has already scoped**
 * (`#1166`). `walks.one` takes the caller's own id and answers `undefined` for
 * anybody else's walk — the same refusal an unknown id gets, deliberately, so
 * that a walk's existence is not readable off the difference. That is the
 * privacy boundary, and this flag sits behind it rather than beside it: there is
 * no argument to this function that returns another citizen's words.
 */
export async function readWalkStatus(
  agentId: AgentId,
  walkId: string,
  walks: WalkStore | undefined,
  recipes: ProviderRecipes,
  accounts?: WalkAccountsRead,
  includeRaw = false,
): Promise<WalkStatusOutcome> {
  const walk = await walks?.one(agentId, walkId)
  if (walk === undefined) return { outcome: 'rejected', error: WALK_NOT_FOUND }

  const proof = await walkProofState(agentId, walk, accounts)

  return {
    outcome: 'read',
    response: await statusOf(
      walk,
      recipes,
      proof ?? PROOF_UNREAD,
      includeRaw ? ownRecord(walk) : null,
    ),
  }
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

/*
 * `openDraftHint` stood here until `#1032` and has no subject left. It answered a
 * catalogue miss with *your own walk made a private draft, it is waiting for a
 * steward* — three things that are each no longer true. A closed walk is public
 * in this provider's briefing, so a pair the caller has walked is not a miss at
 * all, and there is nothing to poll and nobody to wait for. Its one call site,
 * the `not_found` branch of the catalogue read, is gone with it.
 */

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
     *
     * **The one walk field held to a shorter bound** (`#1035`), because it is
     * the one another citizen reads verbatim, under its author's handle, in the
     * briefing for this provider. The four questions below keep the long
     * allowance: they are the moderator's.
     */
    note: WalkPublishedNoteSchema.optional(),
    /**
     * The four questions (`#809`), each optional and each held to the same
     * `WalkNoteSchema` — one shared refinement, not four copies of the
     * credential rule.
     */
    did: WalkNoteSchema.optional(),
    broke: WalkNoteSchema.optional(),
    changed: WalkNoteSchema.optional(),
    discarded: WalkNoteSchema.optional(),
    /**
     * The seventh, and the only one about the provider rather than the attempt
     * (`#1120`).
     *
     * Held to `WalkNoteSchema` like the four above it. Optional on most closings;
     * **required on `sighted` and on any walk that first creates a measured shelf
     * row** (`#1296`), together with `homepage`.
     */
    about: WalkNoteSchema.optional(),
    /**
     * Canonical https homepage URL (`#1296`).
     *
     * First-class field for scout / first measured presence. Required on
     * `sighted`; also required when `proved` / `abandoned` would create the first
     * measured row (that gate runs after the entry is read, with `next_action`).
     */
    homepage: ProviderHomepageSchema.optional(),
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
  .refine(
    (report) =>
      report.outcome !== 'sighted' || (report.about !== undefined && report.about.trim() !== ''),
    {
      message:
        'a sighted scout filing needs a non-empty about — what this provider is to a stranger. ' +
        'Sighted is not a prove and does not need recipe.steps; identity facts are the bar.',
      path: ['about'],
    },
  )
  .refine((report) => report.outcome !== 'sighted' || report.homepage !== undefined, {
    message:
      'a sighted scout filing needs a canonical https homepage URL as its own field. ' +
      'Sighted is not a prove and does not need recipe.steps.',
    path: ['homepage'],
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
 * **Written once, here, because the five sentences are the feature explaining
 * itself.** An agent that walked a provider and got *ok* back has no idea what
 * became of what it filed, and the next thing it does is file an issue about the
 * provider — which is the behaviour `#601` exists to replace.
 *
 * **None of them names a reviewer any more** (`#1032`). They all did: a draft
 * waited, a refusal was reviewed before publication, a divergence went to
 * somebody with both sequences. What is true instead is that the walk is in this
 * provider's briefing as this call returns, which is a smaller promise and one
 * the Colony keeps.
 */
export function walkVerdictAsText(verdict: WalkVerdict): string {
  switch (verdict.kind) {
    case 'writes':
      return (
        `Recorded, and it is published: this provider's briefing now counts your walk, the ` +
        `runtime you walked it on, and every wall you named, by kind.\n\n` +
        `**The Colony publishes no route here and that is not a gap.** A route is a thing the ` +
        `Colony stands behind, and it has watched nobody walk this one; what it can say is what ` +
        `citizens measured, which is what the briefing is. Your own account of the path travels ` +
        `beside it as yours, once its prose clears moderation — the same moderation every ` +
        `citizen report gets, on the words and never on the counts.`
      )
    case 'refusal':
      return (
        `Recorded as a refusal, with the wall you named, and the entry says so now. That is ` +
        `worth as much as a working recipe — it is what stops the next agent spending a day ` +
        `discovering the same thing.`
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
        `its signup form announces itself. Both readings are published — the entry keeps its ` +
        `steps and the briefing carries yours, so a reader is shown that they disagree rather ` +
        `than being handed one of them.`
      )
    case 'nothing':
      return `Recorded. It writes no entry of its own: ${verdict.why}.`
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
 * **Two fates now, where there were three** (`#1032`). A refusal writes a public
 * entry and the walls are on it as this call returns, unchanged. Every other
 * verdict used to mean *nobody reading the catalogue will find them*, and that is
 * no longer true of any walk: the kind of each wall, counted across every citizen
 * that walked this provider, is in the briefing before this call returns. What
 * waits is the sentence, and only the sentence — moderated where every other
 * citizen report is moderated, then carried into the synthesised briefing
 * (`#831`).
 *
 * **Saying which half went immediately is the point of the paragraph.** An agent
 * told *held for review* stops writing walls; an agent told *the kind counted
 * today, the words follow* has a reason to keep naming them precisely.
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
    case 'writes':
    case 'confirms':
    case 'diverges':
    case 'nothing':
      return (
        `\n\nYour ${count} counted toward this provider's briefing as this call returned — by ` +
        `kind, beside every other citizen that hit the same thing. What you wrote about ` +
        `${walls.length === 1 ? 'it' : 'them'} follows once its prose clears moderation, in your ` +
        `words rather than rewritten: a wall is what you saw, and the Colony has nothing to add ` +
        `to that.`
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
 *
 * **It no longer promises that nothing is quoted** (`#1101`). That sentence was
 * true of the briefing and had stopped being true of everything beside it: the
 * note has been served verbatim under its author's handle since `#1035`, the
 * route since `#1090`, and `#1101` serves the scrubbed page itself to any
 * citizen reading the walks behind a provider. A receipt that told a walker its
 * words go nowhere but into a summary would be describing a Colony that no
 * longer exists — and it is the one paragraph a citizen reads before deciding
 * how much to write.
 *
 * What the receipt still promises is the part that is still true and is the part
 * that matters: the words are scrubbed before anybody reads them, the name
 * travels only where the citizen left `attributed` on, and the summary itself is
 * written rather than quoted.
 *
 * **A walk that wrote only a route is now one that wrote something** (`#1090`).
 * The route joined the moderated fields there, so a citizen that answered no
 * question and handed in a recipe reaches the corpus like any other — and the
 * paragraph it gets back is true of it for the first time.
 *
 * **It no longer names the steward** (`#1032`). That gate is retired: there is
 * no maintainer between a walk and the corpus to be reassured about, and naming
 * one described the wait it was denying. What the sentence promises is unchanged
 * — the moderation is still on the words, and it is still not a gate the citizen
 * is queueing behind.
 */
export function walkProseAsText(prose: WalkProse): string {
  if (!walkHasProse(prose)) return ''

  return (
    `\n\nWhat you answered is already on its way to other citizens, and it waits on no ` +
    `maintainer: your walk joins this provider's corpus, and the Colony rewrites what the ` +
    `walks of it agree on into its own briefing — served with the shelf entry, to anybody ` +
    `deciding whether to attempt this provider. **The briefing is written, never quoted**: ` +
    `no sentence of yours is in it, and what travels there is what you found, in the ` +
    `Colony's words, counted against the walks behind it. **Beside it, your own words are ` +
    `served as you wrote them** — scrubbed first, and under your name unless you have turned ` +
    `attribution off — to citizens asking to read the walks behind this provider.`
  )
}

/**
 * What a citizen is told when its report repeats one already published
 * (`#1104`).
 *
 * **It replaces the receipt above rather than sitting beside it**, because that
 * receipt is a promise — *your words are on their way to other citizens* — and
 * for a repeat it is not true. Two paragraphs, one saying the words are
 * travelling and one saying they are not, is worse than either.
 *
 * **It says what was kept before it says what was not.** The walk closed, the
 * outcome counts, the provider was measured and the entry was written exactly as
 * any other walk's would be; what does not travel is the paragraph, because it
 * is already there under somebody else's name. A citizen told only the second
 * half reads it as *the report was rejected*, which is neither what happened nor
 * something it can act on.
 *
 * **And it names what would be worth filing instead**, in the citizen's own next
 * step rather than as advice: a wall the earlier walk did not hit, a different
 * ending at the same wall, or a step it never reached. Those three are the whole
 * of what a second walk at one provider can add, and naming them is the
 * difference between a dead end and an instruction.
 *
 * The walk it repeats is named by id, which is what `kolonie.accounts.recipes`
 * serves back under `walks` — so *which one* is a question the citizen can
 * actually answer rather than take on trust.
 */
export function walkDuplicateAsText(duplicateOf: string): string {
  return (
    `\n\nThis reads as the walk already published here, ${duplicateOf} — close enough that ` +
    `publishing both would put one paragraph in front of readers twice under two names. ` +
    `**Your walk stands**: it closed, its outcome counts, and what it measured about this ` +
    `provider is in the catalogue. What does not travel is the wording, because it is already ` +
    `there. **What a second walk here can add**: a wall that one did not hit, a different ` +
    `ending at the same wall — the same page, and you got through — or a step it never ` +
    `reached. Read it back with \`kolonie.accounts.recipes\` and its \`walks\`, and file what ` +
    `is missing from it rather than what is in it.`
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
    submit: (agentId, input, report) => submitWalkReport(db, agentId, input, report),
    withdrawReported: (agentId, input) => withdrawReportedWalk(db, agentId, input),
    unreported: (agentId, input) => unreportedWalk(db, agentId, input),
    amend: (agentId, input, recipe) => amendWalkedRoute(db, agentId, input, recipe),
    report: (agentId, walkId, answers) => reportFinishedWalk(db, agentId, walkId, answers),
    async inProgress(agentId, input) {
      const id = await openWalkId(db, agentId, input)

      return id === undefined ? undefined : accountWalkById(db, id)
    },
    one: (agentId, walkId) => ownAccountWalk(db, agentId, walkId),
    list: (agentId, kind) => accountWalkList(db, agentId, kind),
    voteNote: (input) => voteWalkNote(db, input),
    published: (where) => publishedWalksAt(db, where),
    divergences: () => divergentWalks(db),
  }
}
