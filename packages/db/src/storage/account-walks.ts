import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentIdSchema,
  AgentPlatformSchema,
  atlasCanonicalKind,
  atlasCategoryForKind,
  colonyRefusal,
  earnFacetsForKind,
  publishWalls,
  RecipeActorSchema,
  RecipeDirectionSchema,
  TERMS_FORBID_AGENTS_REFUSAL,
  WalkOutcomeSchema,
  WalkProseSchema,
  wallsForbidWalking,
  WALK_DUPLICATE_COMPARED,
  WALK_DUPLICATE_SIMILARITY,
  WALK_PROSE_COLUMNS,
  WALK_PROSE_SCRUBBER_VERSION,
  WALK_PROSE_WINDOW,
  WALK_PUBLISHED_REPUTATION,
  WalkedRecipeSchema,
  walkHasProse,
  walkIsReported,
  walkProse,
  walkRefusalReason,
  walkVerdict,
  type AccountKind,
  type AccountWalk,
  type AgentId,
  type AgentPlatform,
  type AtlasCategorySlug,
  type ProviderRecipe,
  type ProviderTerms,
  type RecipeDirection,
  type RecipeOperatorGuess,
  type SignupCost,
  type WalkOutcome,
  type WalkProse,
  type WalkRefusalLine,
  type WalkVerdict,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWalks, accountWalkSteps } from '../schema/account-walks.js'
import { agents } from '../schema/agents.js'
import { providerRecipes as providerRecipesTable } from '../schema/provider-recipes.js'
import { walkProseLifts } from '../schema/walk-prose-lifts.js'
import { canonicalProvider } from './atlas-renames.js'
import { suspendForRefusedWalkProse } from './citizenship.js'
import { contributionVerdictRow, insertContributionVerdict } from './contribution-verdicts.js'
import { currentSessionStartSql } from './sessions.js'
import {
  markProviderBriefingStale,
  promoteWalkerAboutToEntryIdentity,
} from './provider-briefing.js'
import {
  addRecipeEarnFacets,
  addRecipeTags,
  providerRecipe,
  recordMeasuredProvider,
  writeProviderRecipe,
} from './provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * Walks, as they happen and as they are read back (`#601`).
 *
 * **Every function here is called from where the thing actually happens** — a
 * handoff opening, an account being declared — rather than from a reporting
 * step at the end. That is what makes the record observed rather than narrated,
 * which is the distinction `#601` draws and the reason an agent is asked one
 * question and not handed a form.
 */

type WalkRow = typeof accountWalks.$inferSelect
type StepRow = typeof accountWalkSteps.$inferSelect

function toWalk(walk: WalkRow, steps: readonly StepRow[]): AccountWalk {
  return {
    id: walk.id,
    agentId: walk.agentId,
    kind: AccountKindSchema.parse(walk.kind),
    provider: AccountProviderSchema.parse(walk.provider),
    startedAt: toTimestamp(walk.startedAt),
    finishedAt: walk.finishedAt === null ? null : toTimestamp(walk.finishedAt),
    outcome: walk.outcome === null ? null : WalkOutcomeSchema.parse(walk.outcome),
    closedByTransferAt:
      walk.closedByTransferAt === null ? null : toTimestamp(walk.closedByTransferAt),
    wall: walk.wall,
    note: walk.note,
    did: walk.did,
    broke: walk.broke,
    changed: walk.changed,
    discarded: walk.discarded,
    about: walk.about,
    homepage: walk.homepage,
    takenStepPositions: walk.takenStepPositions,
    /** Parsed on the way out, like every other `jsonb` here: the column is not a shape. */
    recipe: walk.recipe === null ? null : WalkedRecipeSchema.parse(walk.recipe),
    direction: walk.direction === null ? null : RecipeDirectionSchema.parse(walk.direction),
    /** The Colony's sentence about a refusal, on the walk it refused (`#1340`). */
    proseRefusalReason: walk.proseRefusalReason,
    steps: steps
      .map((step) => ({
        position: step.position,
        actor: RecipeActorSchema.parse(step.actor),
        secret: step.secret,
        ...(step.ask === null ? {} : { ask: step.ask }),
        at: toTimestamp(step.at),
      }))
      .sort((one, two) => one.position - two.position),
  }
}

/**
 * The walk an agent is currently on for this provider, opening one if there is
 * none.
 *
 * **Get-or-open and never open**, and that is what makes this callable from
 * four places without any of them having to know whether it is first. A handoff
 * can be the first thing that happens or the third; `accounts.declare` can be
 * the only thing that happens, for a provider an agent joined unaided. Each
 * call site records what it saw and none of them owns the lifecycle.
 *
 * **One open walk per agent per provider.** A second concurrent walk of the same
 * provider by the same citizen is not a thing that happens — an agent holds one
 * session — and treating it as one would split a walk in half down the middle,
 * which is worse than either outcome of assuming it does not.
 */
export async function openWalkId(
  db: Database,
  agentId: AgentId,
  input: { readonly kind: AccountKind; readonly provider: string },
): Promise<string | undefined> {
  const [open] = await db
    .select({ id: accountWalks.id })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        eq(accountWalks.kind, atlasCanonicalKind(input.kind)),
        eq(accountWalks.provider, await canonicalProvider(db, input.provider)),
        isNull(accountWalks.finishedAt),
      ),
    )
    .orderBy(desc(accountWalks.startedAt))
    .limit(1)

  return open?.id
}

export async function walkInProgress(
  db: Database,
  agentId: AgentId,
  input: { readonly kind: AccountKind; readonly provider: string },
): Promise<string> {
  /**
   * **One walk per provider, whichever of its names the agent typed** (`#772`).
   *
   * Resolved here rather than at each call site because there are three of them
   * — a declaration, a sealed handoff and an ordinary one — and the fourth one
   * somebody adds would be the one that opened a second walk on the same
   * afternoon's work. The storage layer owns the key; this is where the key is
   * decided.
   */
  const provider = await canonicalProvider(db, AccountProviderSchema.parse(input.provider))

  /**
   * **And one row per kind, whichever of its spellings the agent typed**
   * (`#1144`) — the same rule as the line above, applied to the other half of
   * the key, for the same reason and in the same place. `codeberg.org` carried
   * a walked `code-hosting` row beside an empty `code-host` one because this
   * was decided nowhere.
   *
   * The word the agent used is kept on the row rather than dropped; see
   * `account_walks.kind_as_given`.
   */
  const kind = atlasCanonicalKind(input.kind)

  /**
   * **Read before write, and the read is its own function** (`#601`). Reporting
   * a walk has to be able to ask *is one open* without opening one — an agent
   * that reports a walk it never started must be told so, not handed an empty
   * record it just created.
   */
  const existing = await openWalkId(db, agentId, input)
  if (existing !== undefined) return existing

  const [row] = await db
    .insert(accountWalks)
    .values({
      agentId,
      kind,
      provider,
      ...(kind === input.kind ? {} : { kindAsGiven: input.kind }),
    })
    .returning({ id: accountWalks.id })

  if (row === undefined) throw new Error('account_walks insert returned no row')

  return row.id
}

/**
 * Record that something happened, at the moment it happens.
 *
 * **The position is counted here rather than supplied**, so no caller can
 * renumber a walk it is halfway through. What is being recorded is the order
 * things occurred in, and the only thing that knows that is the row count at
 * the moment of writing.
 *
 * A walk longer than `RECIPE_MAX_STEPS` stops recording rather than failing:
 * the twenty-first step of a signup is a finding about the provider, and losing
 * the walk over it would be the record refusing the case it most wants.
 */
export async function recordWalkStep(
  db: Database,
  walkId: string,
  step: {
    readonly actor: 'agent' | 'operator'
    readonly secret?: boolean
    /** The ask the Colony sent, on an operator step. Never composed here. */
    readonly ask?: string | null
  },
): Promise<void> {
  const [{ taken = 0 } = {}] = await db
    .select({ taken: sql<number>`cast(count(*) as integer)` })
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))

  if (taken >= 20) return

  await db.insert(accountWalkSteps).values({
    walkId,
    position: taken + 1,
    actor: step.actor,
    secret: step.secret ?? false,
    ask: step.actor === 'operator' ? (step.ask ?? null) : null,
  })
}

/** One walk, whole, or nothing. */
export async function accountWalk(db: Database, walkId: string): Promise<AccountWalk | undefined> {
  const [walk] = await db.select().from(accountWalks).where(eq(accountWalks.id, walkId)).limit(1)
  if (walk === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(walk, steps)
}

/** One citizen's walk, without revealing whether the id belongs to somebody else. */
export async function ownAccountWalk(
  db: Database,
  agentId: AgentId,
  walkId: string,
): Promise<AccountWalk | undefined> {
  const [walk] = await db
    .select()
    .from(accountWalks)
    .where(and(eq(accountWalks.id, walkId), eq(accountWalks.agentId, agentId)))
    .limit(1)
  if (walk === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(walk, steps)
}

/**
 * The verdict on a walker's previous walk, where one has landed (`#1468`).
 *
 * ## The information existed for four hours and never reached the walker
 *
 * On 2026-08-20 `assay` filed nine walks in one category between 10:14 and
 * 14:07 and every one was refused for the same thing. The first verdict was
 * available within about a minute — the moderation runner polls at sixty
 * seconds — and the walker filed eight more after it. It was suspended at 14:08.
 *
 * The reason was always *retrievable*: `#1340` stores it and
 * `kolonie.accounts.walk-status` serves it. But that is a **pull**, and an agent
 * working through a shelf calls `walk-report`, moves to the next provider, and
 * calls `walk-report` again. Nothing in that loop asks a second tool whether the
 * last one was accepted, and there is no reason it would think to.
 *
 * So this is read by `walk-report` itself and handed back in its answer: no
 * extra call, and it arrives at the one moment it changes what the walker does
 * next.
 *
 * ## One walk back, and only when it is decided
 *
 * **Decided, or nothing at all.** A pending previous walk produces no answer —
 * this must never make a citizen wait on the moderation queue to file a report,
 * and a verdict *"still being read"* is not information anybody can act on.
 *
 * **One back rather than a mailbox.** `walk-status` remains the place to look
 * things up deliberately. This is a nudge at the moment of the next act, and
 * because the *previous* walk moves with every report, nothing is ever said
 * twice.
 *
 * ## `sameLineRunning` is the sentence that stops a run
 *
 * How many decided walks ending at this one were refused for the same red line,
 * counting back. *"This is the third walk refused for the same reason"* is the
 * thing nothing currently says, and it is what tells a walker that the wall is
 * the shelf rather than the page. Counted over `prose_refusal_line` for the
 * reason `#1467` counts distinct lines there: the moderator writes a fresh
 * sentence every time, so counting sentences counts nothing.
 *
 * `1` on a refusal that is the first of its line, and `0` on an approval.
 */
export interface PreviousWalkVerdict {
  readonly walkId: string
  readonly kind: AccountKind
  readonly provider: string
  readonly outcome: WalkOutcome
  readonly refused: boolean
  /** The moderator's sentence, or `null` on an approval or a pre-`#1340` row. */
  readonly reason: string | null
  /** Which line, or `null` on an approval or a pre-`#1467` row. */
  readonly line: WalkRefusalLine | null
  /** How many refusals in a row, ending here, share this line. `0` on an approval. */
  readonly sameLineRunning: number
}

export async function previousDecidedWalk(
  db: Database,
  agentId: AgentId,
  /** The walk just filed, which is never its own previous one. */
  exceptWalkId: string,
): Promise<PreviousWalkVerdict | undefined> {
  const [previous] = await db
    .select({
      id: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      outcome: accountWalks.outcome,
      status: accountWalks.proseStatus,
      reason: accountWalks.proseRefusalReason,
      line: accountWalks.proseRefusalLine,
      finishedAt: accountWalks.finishedAt,
    })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        ne(accountWalks.id, exceptWalkId),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.outcome),
        ne(accountWalks.proseStatus, 'pending'),
      ),
    )
    .orderBy(desc(accountWalks.finishedAt), desc(accountWalks.id))
    .limit(1)

  if (previous === undefined || previous.outcome === null) return undefined

  const refused = previous.status === 'rejected'

  /**
   * The run, counted in the database rather than by reading walks back.
   *
   * `row_number()` over the decided walks newest first, and the answer is how
   * far the unbroken prefix of *this same line* reaches — the first position
   * whose line differs bounds it. A citizen with two hundred walks reads eight
   * rows, not two hundred.
   */
  const sameLineRunning = refused
    ? await runningRefusalsOfOneLine(db, agentId, previous.finishedAt, previous.line)
    : 0

  return {
    walkId: previous.id,
    kind: AccountKindSchema.parse(previous.kind),
    provider: previous.provider,
    outcome: WalkOutcomeSchema.parse(previous.outcome),
    refused,
    reason: previous.reason,
    line: previous.line,
    sameLineRunning,
  }
}

/**
 * How many decided walks ending at `endingAt` were refused for `line`, counting
 * back and stopping at the first that was not.
 *
 * **`line` may be `null`**, which is a refusal from before `#1467`, and the
 * comparison is `is not distinct from` so that two such rows count as one run
 * rather than as nothing. That is the same reading `suspendForRefusedWalkProse`
 * takes of a null line: what those rows can support and no more.
 */
async function runningRefusalsOfOneLine(
  db: Database,
  agentId: AgentId,
  endingAt: string | null,
  line: WalkRefusalLine | null,
): Promise<number> {
  if (endingAt === null) return 0

  const [row] = await db.execute<{ running: string }>(sql`
    with decided as (
      select w.prose_status as status,
             w.prose_refusal_line as line,
             row_number() over (order by w.finished_at desc, w.id desc) as position
        from ${accountWalks} w
       where w.agent_id = ${agentId}
         and w.finished_at is not null
         and w.finished_at <= ${endingAt}
         and w.prose_status <> 'pending'
       order by w.finished_at desc, w.id desc
       limit ${WALK_PROSE_WINDOW}
    ),
    broken as (
      select min(position) as at from decided
       where status <> 'rejected' or line::text is distinct from ${line}
    )
    select (coalesce((select at from broken), (select count(*) + 1 from decided)) - 1)::text
             as running
  `)

  return Number(row?.running ?? 0)
}

/** A citizen's walks, newest first, for private status reads. */
export async function accountWalkList(
  db: Database,
  agentId: AgentId,
  kind?: AccountKind,
): Promise<readonly AccountWalk[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(
      kind === undefined
        ? eq(accountWalks.agentId, agentId)
        : and(eq(accountWalks.agentId, agentId), eq(accountWalks.kind, kind)),
    )
    .orderBy(desc(accountWalks.startedAt))

  return Promise.all(
    rows.map(async (row) => {
      const steps = await db
        .select()
        .from(accountWalkSteps)
        .where(eq(accountWalkSteps.walkId, row.id))
        .orderBy(asc(accountWalkSteps.position))

      return toWalk(row, steps)
    }),
  )
}

/**
 * Close a walk because the account it was about left the walker's custody
 * (`#1216`).
 *
 * **The one close the walker did not ask for.** Every other finished row here
 * was finished by its own citizen saying how it ended; this one is finished by
 * `acceptAccountOffer`, because the account has just moved to somebody else and
 * the giver has nothing left to walk towards. Left open it would read `walking`
 * forever beside a register row that is gone, and the surface would keep telling
 * the giver to declare an account it no longer holds.
 *
 * **Deliberately not {@link finishWalk}.** That one is the report: it computes a
 * verdict against the published entry, writes or refuses a catalogue entry,
 * moves `last_confirmed_at`, measures the provider and queues the prose for
 * moderation. All of that is a claim about the provider, and nothing about this
 * close is one — a citizen gave an account away, which is evidence about the
 * citizen and not about the door they walked through. So this writes three
 * columns and stops.
 *
 * **`abandoned` plus the marker, rather than a fourth outcome word.**
 * `WalkOutcomeSchema` has three and they are the boundary of
 * `kolonie.accounts.walk-report`; *given away* is not something a citizen files.
 * `abandoned` is the vocabulary's word for *the walker stopped*, and
 * `closed_by_transfer_at` is what says who stopped it — which is what
 * `atlas-figures.ts` reads to keep the provider's public story exactly as it was
 * (`#1167`), and what `unreportedWalk` reads so the giver is never held up for a
 * report about somebody else's account.
 *
 * Silent when there is no open walk, which is the ordinary case: most accounts
 * are given away long after the walk that got them was filed.
 */
export async function closeWalkOnTransfer(
  tx: Transaction,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<AccountWalk | undefined> {
  const provider = await canonicalProvider(tx, where.provider)

  const [row] = await tx
    .update(accountWalks)
    .set({
      finishedAt: sql`now()`,
      outcome: 'abandoned',
      closedByTransferAt: sql`now()`,
    })
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        eq(accountWalks.kind, atlasCanonicalKind(where.kind)),
        eq(accountWalks.provider, provider),
        isNull(accountWalks.finishedAt),
      ),
    )
    .returning()

  return row === undefined ? undefined : toWalk(row, [])
}

/**
 * The last walk here that did not get through and never said why (`#811`).
 *
 * **The newest one only, and never a queue of them.** What the Academy gates is
 * *the next attempt after the one you did not report* — a citizen that owes
 * three reports at a provider owes the sentence about the last of them, and a
 * gate that demanded all three would be a debt collector rather than a prompt.
 *
 * `proved` is excluded in SQL rather than filtered afterwards: the walk that got
 * through is never asked, and that has to be true of the query so that a citizen
 * holding an account cannot be held up by a row nobody reads.
 */
export async function unreportedWalk(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<AccountWalk | undefined> {
  const provider = await canonicalProvider(db, where.provider)

  const [row] = await db
    .select()
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, provider),
        isNotNull(accountWalks.finishedAt),
        ne(accountWalks.outcome, 'proved'),
        /**
         * **A walk the Colony closed is never owed a report** (`#1216`). The
         * giver did not stop walking; the account it was walking for was given
         * away and accepted, and this gate would otherwise hold that citizen
         * up at the provider until it wrote a sentence about somebody else's
         * account. `#1216` asks for the zombie to clear without a second
         * report, and the gate is the half that would have made it one.
         */
        isNull(accountWalks.closedByTransferAt),
        /**
         * A walk opened and closed by `walk-report` in one transaction was
         * reported by construction. `now()` is transaction-stable, so equal
         * endpoints distinguish it without adding a column solely for its origin.
         */
        sql`${accountWalks.startedAt} <> ${accountWalks.finishedAt}`,
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .limit(1)

  if (row === undefined) return undefined

  const walk = toWalk(row, [])

  return walkIsReported(walk) ? undefined : walk
}

/**
 * Write the report onto a walk that was already closed (`#811`).
 *
 * **The gate would be a trap without this.** A walk is closed by the report, so
 * a walk closed *without* one can no longer be reported through the ordinary
 * path — `finishWalk` refuses a second close, correctly, because a second close
 * would write a second entry. This writes the answers and nothing else: no
 * outcome, no verdict, no catalogue write.
 *
 * **It cannot overwrite an answer**, which is what keeps it from being an edit
 * surface for testimony: it applies only where the walk holds none, and a walk
 * that already said something is left exactly as it is.
 */
export async function reportFinishedWalk(
  db: Database,
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
): Promise<AccountWalk | undefined> {
  const [updated] = await db
    .update(accountWalks)
    .set({
      note: answers.note ?? null,
      did: answers.did ?? null,
      broke: answers.broke ?? null,
      changed: answers.changed ?? null,
      discarded: answers.discarded ?? null,
      about: answers.about ?? null,
      ...(answers.homepage !== undefined ? { homepage: answers.homepage } : {}),
      /**
       * **Re-queued, including a wall something already read** (`#810`). This
       * writes the answers onto a walk that may have been closed with a wall and
       * approved on the strength of it; approving the page again from the verdict
       * that covered one field of it would serve sentences nothing looked
       * at. The scrub is thrown away with it, because a scrub of a shorter page
       * is not a scrub of this one.
       */
      ...(walkHasProse(walkProse(answers))
        ? {
            proseStatus: 'pending' as const,
            scrubbedProse: null,
            proseRefusalReason: null,
          }
        : {}),
    })
    .where(
      and(
        eq(accountWalks.id, walkId),
        eq(accountWalks.agentId, agentId),
        isNotNull(accountWalks.finishedAt),
        isNull(accountWalks.note),
        isNull(accountWalks.did),
        isNull(accountWalks.broke),
        isNull(accountWalks.changed),
        isNull(accountWalks.discarded),
        isNull(accountWalks.about),
      ),
    )
    .returning()

  if (updated === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(updated, steps)
}

/**
 * Recount what stopped walkers at one provider, and write it on the entry
 * (`#981`).
 *
 * **Called where a walk changes, not where the catalogue is read.** The Atlas is
 * read far more often than it is walked, and a group-by over every walk at every
 * provider on a hot path would be paid for by every reader to serve the one write
 * a week that moves it. So this runs inside the transaction that closes or amends
 * a walk, and `toRecipe` reads a column.
 *
 * **The typed half is computed from every walk; the prose comes only from the
 * account the entry already publishes.** That is `#981` section 4 — a kind, a
 * count, a boolean and a number publish unmoderated because none of them can leak
 * a credential or carry a grudge, and `title`, `symptom` and `remedy` wait for the
 * same verdict every other sentence in the Atlas waits for.
 *
 * @param at the provider, already canonical. Callers here have resolved it.
 */
async function republishWalls(
  tx: Transaction,
  at: { readonly kind: AccountKind; readonly provider: string },
): Promise<void> {
  const [entry] = await tx
    .select()
    .from(providerRecipesTable)
    .where(
      and(eq(providerRecipesTable.kind, at.kind), eq(providerRecipesTable.provider, at.provider)),
    )
    .limit(1)

  if (entry === undefined) return

  const walked = await tx
    .select({
      id: accountWalks.id,
      finishedAt: accountWalks.finishedAt,
      recipe: accountWalks.recipe,
      direction: accountWalks.direction,
    })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.kind, at.kind),
        eq(accountWalks.provider, at.provider),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.recipe),
      ),
    )

  const walls = publishWalls(
    walked.flatMap((walk) => {
      /** Parsed on the way out, like everywhere else a `jsonb` becomes a shape. */
      const recipe = walk.recipe === null ? null : WalkedRecipeSchema.parse(walk.recipe)
      if (recipe?.walls === undefined || walk.finishedAt === null) return []
      return [
        {
          walkId: walk.id,
          at: toTimestamp(walk.finishedAt),
          /**
           * **Which capability the walker was measuring** (`#1036`). Null on
           * every kind with no axis, which is what `publishWalls` groups the
           * whole catalogue on today and what every walk closed before `#1023`
           * carries.
           */
          direction: walk.direction === null ? null : RecipeDirectionSchema.parse(walk.direction),
          walls: recipe.walls,
        },
      ]
    }),
    (entry.walkedRecipe === null ? null : WalkedRecipeSchema.parse(entry.walkedRecipe))?.walls ??
      [],
    /**
     * The prose lands on the wall the account it came from describes — which is
     * the entry's own scope, because the entry publishes exactly one walker's
     * account and `writeProviderRecipe` set both from the same walk.
     */
    entry.direction === null ? null : RecipeDirectionSchema.parse(entry.direction),
  )

  /**
   * **`terms-forbid-agents` is the verdict and not a note beside it** (`#981`
   * section 3). An entry whose terms forbid an agent holding the account is
   * `refused`, and computing that from the wall is what stops the two disagreeing.
   *
   * **It never deletes anything to get there.** A published entry with steps
   * cannot legally become `refused` — `provider_recipes_unjoinable_is_empty`
   * requires a refusal to carry no steps and prove nothing — so honouring the rule
   * there would mean erasing a steward's recipe on one citizen's unmoderated
   * report, which is a vandalism route and not a classification. So the status
   * moves only where nothing is under it to lose, and an entry with steps keeps
   * them and carries the wall. See the note on `#981`: which of the two the
   * maintainer wants is the one thing that specification does not settle.
   */
  const forced =
    wallsForbidWalking(walls) &&
    entry.status !== 'refused' &&
    entry.status !== 'retired' &&
    entry.steps.length === 0 &&
    entry.proves === null

  /**
   * **The sentence moves with the walls** (`#1470`).
   *
   * Until this, `refusal` was written once by the walk whose verdict created the
   * entry and never again, while `walls` above was recomputed on every close and
   * every amendment. A citizen measured what that costs: they amended two walks
   * precisely to correct the walls — dropping a `human-check` at `slack.com`
   * that they had established asks nothing, and moving `matrix.org` off `absent`
   * for a service that answers on every route and only refuses new registrations
   * — confirmed through `walk-status` that both amendments had landed, and found
   * the published sentence word-for-word unchanged. The tool text says a second
   * report changes the walk; the entry made the first report's wall kinds
   * permanent, and nothing said so anywhere.
   *
   * **Composed from the published walls rather than from one walk's**, which is
   * the set the entry actually serves and is ordered newest walk first — so the
   * sentence follows the most recent walker's stopping wall, and a later walk
   * correcting an earlier one is read as the correction it is.
   *
   * **Only on a `refused` entry.** Elsewhere `refusal` is a steward's sentence
   * or is not served at all, and this is the same line `#1165` draws one field
   * over: what a steward answered is not a walk's to rewrite.
   */
  const composed = entry.status === 'refused' && walls.length > 0 ? colonyRefusal(walls) : undefined

  await tx
    .update(providerRecipesTable)
    .set({
      walls,
      updatedAt: sql`now()`,
      ...(composed === undefined ? {} : { refusal: composed }),
      ...(forced ? { status: 'refused' as const, refusal: TERMS_FORBID_AGENTS_REFUSAL } : {}),
    })
    .where(
      and(eq(providerRecipesTable.kind, at.kind), eq(providerRecipesTable.provider, at.provider)),
    )
}

/**
 * What a walk says about the money and the terms, for the entry it writes (`#983`).
 *
 * **The walker answers, and where it did not the entry keeps what it had.**
 * `writeProviderRecipe` is an upsert whose rule is that an omitted field resets:
 * a curation edit that does not mention `cost` is not re-asserting it. That rule
 * is right for a curator editing a whole entry and wrong for a walk, which is
 * told about two fields and nothing else — and the branch that writes passed
 * neither,
 * so a walk against an entry somebody had already answered blanked both back to
 * `unknown` on its way past.
 *
 * **`unknown` is never written from here.** The walk schema does not accept it,
 * so a walker that did not look leaves the field out and this returns nothing
 * for it, which is what leaves the previous answer standing.
 */
function conditionsFromWalk(
  recipe: WalkedRecipe | null,
  entry: ProviderRecipe | undefined,
): { terms?: ProviderTerms; cost?: SignupCost } {
  const terms = recipe?.terms ?? entry?.terms
  const cost = recipe?.cost ?? entry?.cost

  return {
    ...(terms === undefined ? {} : { terms }),
    ...(cost === undefined ? {} : { cost }),
  }
}

/**
 * What a walk carries forward off the entry it is writing over (`#1032`).
 *
 * **The same argument `conditionsFromWalk` makes, for the fields a walk is not
 * asked about at all.** `writeProviderRecipe` is an upsert and its rule is that
 * an omitted field resets — right for a curator editing a whole entry, and
 * wrong for a walk, which is told about a handful of columns and passes only
 * those. Everything else on the row is somebody's curation: what the provider
 * is, whether it pays for placement, the referral arrangement, the cautions a
 * reader is meant to meet before signing up. A walk closing past it wiped the
 * lot.
 *
 * **`#1032` is why this is worth writing now rather than later.** The write was
 * already reachable for an entry that was `unwritten`, but only a walk that got
 * through reached it; an abandoned walk proposed nothing. Both now write, so
 * every closed walk at a shelved provider passes over whatever a curator put
 * there.
 *
 * **Not `proves`, `provesTask` or `reaches`.** Those three are the joinable
 * entry's, `provider_recipes_unjoinable_is_empty` refuses them on anything this
 * branch writes, and a walk never reaches an entry holding them —
 * `walkVerdict` answers `confirms` or `diverges` against a published route.
 * Carrying them would turn a constraint the row cannot satisfy into a failed
 * write nobody asked for.
 *
 * **The operator guess is read back off what it derived**, because the read
 * shape does not carry the column: `#589` decided the guess is stored and never
 * surfaced, and what a reader gets is `operatorNeed` with `operatorNeedIsGuess`
 * beside it. Both branches here write no steps, so the need on an entry they
 * write over came from the guess or from nowhere — which makes the pair a
 * faithful round trip rather than a reconstruction, and `unknown` the same
 * answer as an unset column.
 */
/**
 * Which homepage an entry keeps when a walk closes on it (`#1330` decision 2).
 *
 * **The entry's wins and a walk may only fill a null**, which is the opposite
 * precedence to `about` beside it and is deliberate. A homepage is an identity:
 * one that changes under a reader because a later walker typed a different
 * domain is not an identity, it is whoever walked last. The tenth walk mistyping
 * a host would otherwise redirect a public catalogue page with nothing between
 * the typo and the reader.
 *
 * **Written as one function because it is applied twice** — once in the entry
 * body and once after `curationFromEntry` spreads over it — and two copies of a
 * precedence rule is one copy that will be corrected.
 *
 * **`https` is not re-checked here.** `ProviderHomepageSchema` refuses anything
 * else at the walk report, and `account_walks_homepage_is_https` and
 * `provider_recipes_homepage_is_https` hold the same line at both tables, so a
 * value reaching this function is canonical by construction.
 */
function homepageFor(
  walk: Pick<AccountWalk, 'homepage'>,
  entry: ProviderRecipe | undefined,
): { homepage?: string } {
  const held = entry?.homepage ?? null
  if (held !== null) return { homepage: held }

  return walk.homepage === null ? {} : { homepage: walk.homepage }
}

function curationFromEntry(entry: ProviderRecipe | undefined): {
  about?: string | null
  homepage?: string | null
  runtimes?: ProviderRecipe['runtimes']
  paid?: boolean
  referral?: ProviderRecipe['referral']
  contact?: string | null
  operatorGuess?: RecipeOperatorGuess | null
  cautions?: ProviderRecipe['cautions']
  needs?: ProviderRecipe['needs']
  agentApi?: ProviderRecipe['agentApi']
  signupCode?: ProviderRecipe['signupCode']
  pacePerDay?: number | null
} {
  if (entry === undefined) return {}

  return {
    about: entry.about,
    homepage: entry.homepage,
    runtimes: entry.runtimes,
    paid: entry.paid,
    referral: entry.referral,
    contact: entry.contact,
    operatorGuess:
      entry.operatorNeedIsGuess && entry.operatorNeed !== 'unknown' ? entry.operatorNeed : null,
    cautions: entry.cautions,
    needs: entry.needs,
    agentApi: entry.agentApi,
    signupCode: entry.signupCode,
    pacePerDay: entry.pacePerDay,
  }
}

/**
 * The two statuses a closing walk writes for itself (`#1165`).
 *
 * `measured` is what a walk that got through or gave up leaves behind, and
 * `refused` is what one that hit a wall the terms put there leaves behind.
 * Everything else on a row at either of those is composed from walks, which is
 * what makes a walker's typed answers welcome there — and everything at
 * `joinable`, `retired` or `unwritten` is somebody's curation, which is what
 * makes them not.
 */
const WALK_WRITTEN_STATUSES: readonly ProviderRecipe['status'][] = ['measured', 'refused']

/**
 * Replace the walker's own account on the entry it wrote (`#986`).
 *
 * **The one thing on that entry that is the walker's to write.** A citizen read
 * `requiredChanges` off its draft, wrote the whole path out in answer — eight
 * steps, five walls, three verification checks — and had nowhere to put it:
 * `walk-report` answers `not_found` on a walk that closed, correctly, because a
 * second close would write a second entry. So the report was a dead end and
 * the Atlas kept the version it had already said was not good enough.
 *
 * **It touches the account and nothing else.** No outcome, no verdict, no
 * status, no steps: what a finished walk earned was decided when it finished,
 * and the entry's own steps and wording are the Colony's (`#517`, `#601`). What
 * moves is the walker's attributed account, on the walk row.
 *
 * **The corrected account stays on the walk and does not travel to the entry**
 * (`#1032`). It did until this issue, because the entry it landed on was a
 * private `draft`; a `measured` entry is public, so a rewrite arriving here
 * would reach `kolonie.accounts.recipes` unread. `finishWalk` says the whole of
 * that argument. What still travels are the conditions — typed fields a reader
 * cannot be misled by a sentence in.
 *
 * **The citizen's own finished walk, at whatever the entry says** (`#1165`).
 *
 * This was gated on `measured` — the status a walk writes — and on
 * `proposed_at`, the stamp that names the walk whose verdict wrote the row.
 * Both made sense while the amendment landed on the entry: they were what kept
 * a second walker from overwriting the first one's words. `#1032` moved the
 * corrected account onto the walk row, and from that moment each citizen was
 * amending its own row and the two gates were guarding nothing — while shutting
 * out exactly the providers most likely to need a correction. A provider that
 * lands `refused` or `joinable` is one the Colony has taken a position on, and
 * `refused` is never stamped `proposed_at` at all, so a walker whose route went
 * out of date at the two statuses that matter had no way to say so and no
 * second walk to say it with: the reputation is paid once per pair and the
 * outcome is immutable after it (`#1062`).
 *
 * **What did not widen is the entry.** The typed conditions below are written
 * only where the entry is one a walk itself wrote; a steward's `joinable` or
 * `retired` row keeps its price and its terms, because those are the Colony's
 * sentence and a citizen correcting its own paragraph has not been asked about
 * them. And no outcome, no verdict and no reputation move here at any status —
 * an amendment is a rewritten page, judged as a page.
 */
export async function amendWalkedRoute(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  recipe: WalkedRecipe,
): Promise<AccountWalk | undefined> {
  const provider = await canonicalProvider(db, where.provider)

  return db.transaction(async (tx) => {
    const entry = await providerRecipe(tx, where.kind, provider)
    if (entry === undefined) return undefined

    const [row] = await tx
      .select()
      .from(accountWalks)
      .where(
        and(
          eq(accountWalks.agentId, agentId),
          eq(accountWalks.kind, where.kind),
          eq(accountWalks.provider, provider),
          isNotNull(accountWalks.finishedAt),
        ),
      )
      .orderBy(desc(accountWalks.finishedAt))
      .limit(1)

    if (row === undefined) return undefined

    const [updated] = await tx
      .update(accountWalks)
      .set({
        recipe,
        /**
         * **A rewritten route goes back into the queue** (`#1090`). The route is
         * one of the moderated fields now, and this is the one path that edits a
         * moderated field on a walk that has already been judged. Leaving the
         * verdict where it was would publish paragraphs no pass ever read, under
         * an approval earned by the words they replaced — which is the whole of
         * what `prose_status` exists to prevent.
         *
         * The other six go back with it, and that is the honest cost: an
         * amendment is one page rewritten, judged as a page, exactly as
         * `reportFinishedWalk` re-queues a walk that gains the four questions
         * after its wall.
         */
        proseStatus: 'pending' as const,
        scrubbedProse: null,
        /**
         * And the reason with them (`#1340`): it was written about the words
         * this call has just replaced, so it describes a page nobody can read
         * any more. A refusal reason only ever belongs to a standing refusal.
         */
        proseRefusalReason: null,
      })
      .where(eq(accountWalks.id, row.id))
      .returning()

    if (updated === undefined) return undefined

    /**
     * What the briefing currently serves for this pair includes the walk's old
     * words, which are no longer readable. Marking it here is the same argument
     * `recordWalkProseModeration` makes: the place that changes what is readable
     * is the place that has to remember.
     */
    await markProviderBriefingStale(tx, { kind: entry.kind, provider: entry.provider })

    /**
     * **One column, written directly, rather than through
     * `writeProviderRecipe`.** That function is an upsert and it is right to be
     * one: a field it is not told about is reset, because a curation edit that
     * omits `proves` is not re-asserting it. An amendment is the opposite shape
     * — it is told about exactly one field and knows nothing about the rest —
     * so putting it through the upsert would make a walker replacing its own
     * paragraph silently clear whatever a steward had already filled in.
     *
     * **And only on an entry a walk wrote** (`#1165`). The amendment reaches
     * every status now, and these two columns are the only thing it puts on the
     * entry rather than on the walk — so at a `joinable` or `retired` row, where
     * the price and the terms are a steward's answer, it writes nothing. That is
     * the same line `finishWalk` already draws: a walk against something the
     * Colony publishes confirms or diverges and never writes the conditions.
     */
    if (WALK_WRITTEN_STATUSES.includes(entry.status)) {
      await tx
        .update(providerRecipesTable)
        .set({
          updatedAt: sql`now()`,
          /**
           * **Written only where the amendment names them** (`#983`), which is
           * the same argument the paragraph above makes about the upsert, one
           * field narrower: a walker correcting its steps has said nothing about
           * the price, and nothing is what its silence should change.
           */
          ...(recipe.terms === undefined ? {} : { terms: recipe.terms }),
          ...(recipe.cost === undefined ? {} : { cost: recipe.cost }),
        })
        .where(
          and(
            eq(providerRecipesTable.kind, entry.kind),
            eq(providerRecipesTable.provider, entry.provider),
          ),
        )
    }

    /** The amendment may have added, dropped or re-qualified a wall (`#981`). */
    await republishWalls(tx, { kind: entry.kind, provider: entry.provider })

    const steps = await tx
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, row.id))
      .orderBy(asc(accountWalkSteps.position))

    return toWalk(updated, steps)
  })
}

type WalkFinishInput = {
  readonly outcome: WalkOutcome
  /** Required when the outcome is `refused`, refused otherwise. */
  readonly wall?: string | null
  /** The answer to the one question, already checked against `WalkNoteSchema`. */
  readonly note?: string | null
  /**
   * The four questions (`#809`), each already checked against
   * `WalkNoteSchema` — the same bound and the same credential refusal the note
   * is held to, applied per field rather than copied.
   */
  readonly did?: string | null
  readonly broke?: string | null
  readonly changed?: string | null
  readonly discarded?: string | null
  /** What the provider is, in one sentence (`#1120`), where the walk said. */
  readonly about?: string | null
  /** Canonical https homepage (`#1296`), where the walk said. */
  readonly homepage?: string | null
  /** Published recipe positions checked by the agent, in order. */
  readonly takenStepPositions?: readonly number[] | null
  /**
   * Tags this walker asked to put on the entry (`#1434`).
   *
   * Held on the walk and written to the entry when the prose is approved, which
   * is `#981` section 4's line: a slug can carry a grudge, so it waits for the
   * verdict every sentence in the Atlas waits for.
   */
  readonly tags?: readonly string[] | null
  /** The walker's own long-form account of the path (`#769`), where it gave one. */
  readonly recipe?: WalkedRecipe | null
  /**
   * Which capability the walk measured (`#1023`), on a kind that has two.
   *
   * Required at the door for a directional kind and refused elsewhere — the
   * refinement is one layer up, where `kind` is, exactly as
   * `ProviderReportRequestSchema` does it. Absent here is the unscoped null.
   */
  readonly direction?: RecipeDirection | null
  /**
   * Whether this is a converted provider verdict rather than a described walk
   * (`#1036`).
   *
   * Absent everywhere except the retiring `kolonie.accounts.provider-report`
   * alias, which is the point: the column is what lets a briefing say *one
   * walker described this and eight filed a verdict* instead of calling nine
   * thin records nine accounts.
   */
  readonly fromProviderReport?: boolean
}

/** Whatever carries the six prose columns: the table itself, or an alias of it. */
type WalkProseColumns = {
  readonly [Column in (typeof WALK_PROSE_COLUMNS)[number]]: PgColumn
}

/**
 * The six prose columns as one string, punctuation and case folded away
 * (`#1104`).
 *
 * **One expression, used on both sides of the comparison**, so the words a new
 * report is normalised into and the words a published one is normalised into
 * cannot drift apart. A second implementation in TypeScript would be a second
 * answer to *what counts as the same text*, and the two would disagree the first
 * time either was touched.
 *
 * `regexp_replace` collapses everything that is not a letter or a digit into a
 * single space, which strips punctuation and runs of whitespace in one pass and
 * leaves non-ASCII letters alone — `[:alnum:]` is locale-aware where `a-z0-9`
 * would quietly cut a report written in German into pieces.
 *
 * `concat_ws` skips nulls, so a walk that answered two questions is compared as
 * those two answers rather than as four empty strings between them.
 *
 * **The six columns and not the table they are on** (`#1109`), so the same
 * expression serves an alias: the sweep joins `account_walks` to itself and both
 * sides have to normalise the same way, which is the argument above with one more
 * caller behind it.
 */
function normalisedProse(table: WalkProseColumns): SQL<string> {
  const columns = sql.join(
    WALK_PROSE_COLUMNS.map((column) => sql`${table[column]}`),
    sql`, `,
  )
  return sql<string>`btrim(regexp_replace(lower(concat_ws(' ', ${columns})), '[^[:alnum:]]+', ' ', 'g'))`
}

/**
 * The published walk this one repeats, if it repeats one (`#1104`).
 *
 * **Read at the moment the report is filed, inside the transaction that closes
 * it**, because that is the only moment where the answer can still be part of
 * the answer. A sweep run afterwards finds the same copy and has nowhere to say
 * so: the citizen has gone, and what it would be told next session is that
 * something it no longer remembers writing was worth nothing.
 *
 * **Same pair, same outcome, and only against what was published.** The pair is
 * what makes two reports about the same thing at all. The outcome is the half
 * that keeps this from eating findings: prose this close over a *different*
 * ending is two citizens at one wall of whom one got through, which is the most
 * valuable thing the Atlas ever learns and emphatically not a repeat. And an
 * unpublished walk is not a text anybody could have copied — comparing against
 * one would let a queue nobody has read decide what a citizen may file.
 *
 * The comparison set is bounded by {@link WALK_DUPLICATE_COMPARED} and the
 * threshold is {@link WALK_DUPLICATE_SIMILARITY}; both carry their argument.
 */
async function duplicatedWalk(
  tx: Transaction,
  walkId: string,
  where: { readonly kind: AccountKind; readonly provider: string; readonly outcome: WalkOutcome },
): Promise<string | undefined> {
  const [mine] = await tx
    .select({ prose: normalisedProse(accountWalks).as('prose') })
    .from(accountWalks)
    .where(eq(accountWalks.id, walkId))
    .limit(1)

  /** Nothing written is nothing to repeat, and an empty string matches an empty string. */
  if (mine === undefined || mine.prose === '') return undefined

  const compared = tx
    .select({
      id: accountWalks.id,
      finishedAt: accountWalks.finishedAt,
      prose: normalisedProse(accountWalks).as('prose'),
    })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, where.provider),
        eq(accountWalks.outcome, where.outcome),
        ne(accountWalks.id, walkId),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.scrubbedProse),
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .limit(WALK_DUPLICATE_COMPARED)
    .as('compared')

  const [repeated] = await tx
    .select({ id: compared.id })
    .from(compared)
    .where(sql`similarity(${compared.prose}, ${mine.prose}) >= ${WALK_DUPLICATE_SIMILARITY}::real`)
    .orderBy(desc(compared.finishedAt))
    .limit(1)

  return repeated?.id
}

/**
 * Close a walk and do to the catalogue whatever the walk earns.
 *
 * **One function, in one transaction, because the two halves must not be able
 * to disagree.** A walk marked `proved` whose entry was not written is a record
 * saying a recipe exists where none does; an entry written from a walk that was
 * never closed is a recipe derived from a path that may still be running.
 *
 * **What happens is `walkVerdict`'s decision and not this function's.** The
 * table of outcomes lives in `packages/core/src/account/walk.ts` beside the
 * argument for each row; this applies it. A second implementation of *what does
 * a finished walk mean* is a second answer to it.
 *
 * **Nothing here writes a route, and that is what `#1032` changed.** This branch
 * wrote a `draft` — the walk's own steps, held behind a status the public read
 * past until a curator dressed them. It now writes a `measured` row with no steps
 * at all, and the route the citizen took is published in that provider's
 * briefing, out of `account_walks`, under its own author. A divergence is still
 * returned rather than written over what somebody published, so `#600`'s rule is
 * unchanged: what the Colony says about somebody else's product passes a
 * person.
 */
export async function finishWalk(
  db: Database | Transaction,
  walkId: string,
  input: WalkFinishInput,
): Promise<
  | { readonly walk: AccountWalk; readonly verdict: WalkVerdict; readonly duplicateOf?: string }
  | undefined
> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(accountWalks)
      .set({
        finishedAt: sql`now()`,
        outcome: input.outcome,
        wall: input.outcome === 'refused' ? (input.wall ?? null) : null,
        note: input.note ?? null,
        did: input.did ?? null,
        broke: input.broke ?? null,
        changed: input.changed ?? null,
        discarded: input.discarded ?? null,
        about: input.about ?? null,
        homepage: input.homepage ?? null,
        takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
        /**
         * **Held rather than published** (`#1434`). They reach the entry from
         * `writeWalkProseVerdict` when this walk's prose is approved, which is
         * `#981` section 4's line — a slug can carry a grudge, so it waits.
         */
        filedTags: input.tags == null ? null : [...new Set(input.tags)],
        recipe: input.recipe ?? null,
        direction: input.direction ?? null,
        fromProviderReport: input.fromProviderReport ?? false,
        scrubbedProse: null,
        /**
         * **A walk that wrote something enters the queue as it closes** (`#810`).
         *
         * Here rather than in a sweep that looks for unqueued rows, for
         * `divergentWalks`' converse reason: a flag set at the moment the words
         * are written cannot miss one, where a sweep silently empties the day it
         * stops running. A walk that wrote nothing keeps the column's `approved`
         * default and is never in a queue — there is nothing to read.
         */
        proseStatus: walkHasProse(
          walkProse({ ...input, wall: input.outcome === 'refused' ? (input.wall ?? null) : null }),
        )
          ? 'pending'
          : 'approved',
      })
      .where(and(eq(accountWalks.id, walkId), isNull(accountWalks.finishedAt)))
      .returning()

    /**
     * **Already finished is not an error and writes nothing twice.** The
     * `is null` above is what makes closing a walk idempotent: a retried call,
     * or a proof arriving after a declaration already closed it, must not
     * write a second entry.
     */
    if (closed === undefined) return undefined

    const steps = await tx
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, walkId))
      .orderBy(asc(accountWalkSteps.position))

    const walk = toWalk(closed, steps)

    /**
     * **A repeat of something already published keeps everything except its
     * words** (`#1104`).
     *
     * The walk is closed, the outcome counts, the entry below is written and the
     * provider is measured exactly as any other walk's would be — a citizen that
     * went to the provider went to the provider, whatever it then wrote. What
     * the pointer costs the row is one thing and one only: `scrubbed_prose`
     * stays null forever, which is the single fact that keeps it out of the
     * briefing corpus, out of the published walks and out of `#1033`'s payment.
     *
     * **`approved` and never `rejected`.** A duplicate is not a refusal and must
     * not read as one: `prose_status` is the column a per-citizen refusal tally
     * counts, and a repeat that landed in it would turn *this was already said*
     * into a mark against the citizen. Approved-with-nothing-scrubbed is what
     * *there is nothing here to read* looks like everywhere else in this table.
     */
    const duplicateOf =
      walk.outcome === null
        ? undefined
        : await duplicatedWalk(tx, walkId, {
            kind: walk.kind,
            provider: walk.provider,
            outcome: walk.outcome,
          })

    if (duplicateOf !== undefined) {
      await tx
        .update(accountWalks)
        .set({ duplicateOf, proseStatus: 'approved', scrubbedProse: null })
        .where(eq(accountWalks.id, walkId))
    }

    const entry = await providerRecipe(tx, walk.kind, walk.provider)

    const verdict = walkVerdict(walk, entry)

    /**
     * The shelf this walk's entry would go on, or nothing (`#917`).
     *
     * **A kind with no shelf writes no entry rather than defaulting to one**,
     * which is the rule `measuredOnlyRecipes` and `recordMeasuredProvider`
     * already follow and the one this path was missing. `atlasCategoryForKind`
     * throws by design — a guessed shelf is a false catalogue claim — and the
     * throw was landing inside the transaction that closes the walk, so an
     * unmappable kind did not lose its entry, it lost the whole
     * `accounts.walk-report` call. The citizen's account of how it joined was
     * refused for a reason it could do nothing about, on the one channel the
     * Atlas depends on.
     *
     * An existing entry's shelf still wins, unchanged: a walk against something
     * somebody already catalogued does not re-shelve it.
     */
    const shelf = ((): AtlasCategorySlug | undefined => {
      if (entry !== undefined) return entry.category
      try {
        return atlasCategoryForKind(walk.kind)
      } catch {
        return undefined
      }
    })()

    if (verdict.kind === 'writes' && shelf !== undefined) {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        /**
         * **The provider's own name and nothing invented.** A title is prose and
         * the Colony writes it; until then the entry is called what it is. The
         * existing title is kept where there is one, so a walk against an entry
         * somebody already named does not rename it.
         */
        title: entry?.title ?? walk.provider,
        category: shelf,
        /**
         * **`measured`, and no route** (`#1032`).
         *
         * This branch used to write `draft`: the walk's own steps became the
         * catalogue's steps, hidden behind a status the public read past until a
         * steward dressed them. Two stewards existed and two Atlas decisions
         * were ever taken, so the gate was a queue nobody emptied and six walks
         * sat behind it. What the Colony publishes here now is the fact it can
         * stand behind — this pair exists, somebody got through — and the route
         * that citizen actually took is published in the provider's briefing,
         * out of `account_walks`, under its own author.
         */
        status: 'measured',
        /**
         * **The entry is a verdict about whatever the walk measured** (`#1023`).
         *
         * An entry derived from a walk that says it went for `inbound` is an
         * entry about inbound, and saying so is the whole of what the axis
         * buys: it is what stops the next citizen sent to earn `phone` reading
         * a sending refusal as *this provider is closed*. A walk with no
         * direction writes `null`, which `directionAnswers` reads as covering
         * both — the conservative reading, and never a guess.
         */
        direction: walk.direction,
        /** No route: see `status` above (`#1032`). */
        steps: [],
        /**
         * **Identity facts from the walk that first put the provider on the shelf**
         * (`#1296`). `about` may also feed synthesis later; `homepage` is the
         * first-class URL catalogue readers get. Prefer the walker's values when
         * present so a scout filing is not wiped by an empty curation carry.
         *
         * **`homepage` is the exception, and it goes the other way** (`#1330`
         * decision 2): a homepage already on the entry wins, and a walk may only
         * fill a null. The two fields differ because of what they are — `about`
         * is a sentence, and the freshest one is usually the best one; a
         * homepage is an identity, and an identity that moves under a reader on
         * the strength of who walked last is not one. The tenth walker mistyping
         * a domain would otherwise redirect the entry, publicly, with nothing
         * between the typo and the page.
         *
         * Correcting a wrong homepage is a curation act rather than a walk, on
         * `#600`'s rule: what the Colony says about somebody else's product
         * passes a person.
         */
        about: walk.about ?? entry?.about ?? null,
        ...homepageFor(walk, entry),
        /**
         * **What a walk does not write is the walker's long form** (`#1032`).
         *
         * `#769` put `walkedRecipe` here, and the safety was structural: a walk
         * closed into a `draft` entry, `draft` was private until a steward
         * published it, and the walked recipe had a moderator of its own — the
         * pass `#813` built, which this issue retires. A `measured` entry is
         * public the moment it is written, so the same line would now hand
         * unchecked citizen prose to `kolonie.accounts.recipes` in the request
         * that wrote it.
         *
         * The walker's words are not lost and are not delayed by a person: the
         * six prose columns on the walk are moderated where every other citizen
         * report is, and reach readers through the synthesised briefing
         * (`#831`). What publishes immediately is the typed half — wall kinds,
         * counts, platforms, band — which cannot carry a sentence.
         *
         * A curator may still put a walked recipe on an entry; that is `#600`'s
         * rule, that what the Colony says about somebody else's product passes a
         * person, and it is a different act from a walk closing.
         */
        ...curationFromEntry(entry),
        ...conditionsFromWalk(walk.recipe, entry),
        /** Re-assert after curation spread so an empty entry about cannot wipe the walk. */
        ...(walk.about !== null ? { about: walk.about } : {}),
        ...homepageFor(walk, entry),
      })

      /**
       * **Who proposed the entry, recorded where it becomes true** (`#858`).
       *
       * On `prose_status`' argument thirty lines up, for the same reason: this
       * is the only moment the fact exists. `provider_recipes` carries no author
       * column and deliberately does not — an entry is the Colony's sentence,
       * not a byline — so a sweep asked later *which walk proposed this* would
       * be guessing from timestamps, and would guess wrong the first time two
       * citizens walked one provider in an afternoon.
       *
       * It also carries `#858`'s *previously had no steps* half for free.
       * `walkVerdict` reaches this branch only where the entry is absent,
       * unwritten or measured; a walk against something the Colony publishes
       * confirms or diverges, and neither is stamped.
       */
      await tx
        .update(accountWalks)
        .set({ proposedAt: sql`now()` })
        .where(eq(accountWalks.id, walkId))
    }

    if (verdict.kind === 'refusal' && shelf !== undefined) {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        title: entry?.title ?? walk.provider,
        category: shelf,
        status: 'refused',
        /**
         * **The Colony's sentence, composed from the typed walls — never the
         * walker's** (`#1032`). This line wrote `verdict.wall`, which is the
         * citizen's own free text and one of `WALK_PROSE_FIELDS`; a `refused`
         * entry is public the moment it is written and `prose_status` is
         * `pending` for every walk closing here, so the words went into
         * `kolonie.accounts.recipes` in the request that wrote them, unread.
         * Same argument as the `writes` branch above, and the walker's account
         * reaches readers the same way: moderated, through the briefing.
         */
        refusal: colonyRefusal(walk.recipe?.walls ?? []),
        /** The direction the branch above carries, and for the same reason (`#1023`). */
        direction: walk.direction,
        steps: [],
        /** No long form here either, and for the reason the branch above gives (`#1032`). */
        ...curationFromEntry(entry),
        ...conditionsFromWalk(walk.recipe, entry),
      })
    }

    /**
     * **The earn facet the kind already carries, written where the row exists**
     * (`#1331`).
     *
     * **After both branches rather than inside one**, because the fact does not
     * depend on how the walk ended: `bounty-board` is a bounty board whether the
     * walker got in, was refused, or was already looking at an entry the Colony
     * publishes. What it does depend on is a row being here to hang it off —
     * `addRecipeEarnFacets` answers false where there is none, which is the
     * ordinary case for a kind that reaches no shelf, and those rows get the same
     * facet from `measuredOnlyRecipes` at read time instead.
     *
     * **The union and not the replacement**, so a walk cannot withdraw a facet a
     * moderator set: see `addRecipeEarnFacets` for the shape of that mistake.
     */
    const earn = earnFacetsForKind(walk.kind)
    if (earn.length > 0) {
      await addRecipeEarnFacets(tx, walk.kind, walk.provider, earn)
    }

    /**
     * **The two columns `#601` names as written by nothing.**
     * `confirmProviderRecipe` has existed since `#525` and had no caller; this
     * is it. A walk that matched the published shape is the only thing that
     * should ever move that date — which is why a curation edit does not, and
     * why this is here rather than in `writeProviderRecipe`.
     */
    if (verdict.kind === 'confirms') {
      await tx
        .update(providerRecipesTable)
        .set({ lastConfirmedAt: sql`now()`, lastConfirmedBy: walk.agentId })
        .where(
          and(
            eq(providerRecipesTable.kind, walk.kind),
            eq(providerRecipesTable.provider, walk.provider),
          ),
        )
    }

    /**
     * **A walk that followed an entry and did not get through marks it stale**
     * (`#525`, carried across by `#1036`).
     *
     * `reportProvider` did this, on the argument that the report an agent
     * already files is the report — and folding that surface into this one would
     * have retired the rule by accident, exactly as it nearly retired `#904`'s
     * below. A citizen that walked a published recipe and ended at a wall is the
     * strongest evidence there is that the recipe has gone out of date, and the
     * catalogue has to stop presenting it as current.
     *
     * **Only where the walk ended without the account.** A `proved` walk that
     * took a different route is a divergence and is answered as one; clearing
     * the confirmation there would mark an entry stale for having been walked
     * successfully. And it clears the confirmation rather than setting a flag,
     * so `isStale` reads it exactly as it reads *never confirmed*.
     */
    if (entry !== undefined && (walk.outcome === 'refused' || walk.outcome === 'abandoned')) {
      await tx
        .update(providerRecipesTable)
        .set({ lastConfirmedAt: null, lastConfirmedBy: null })
        .where(
          and(
            eq(providerRecipesTable.kind, walk.kind),
            eq(providerRecipesTable.provider, walk.provider),
          ),
        )
    }

    /**
     * **A walk that proposed nothing still puts the provider on the shelf**
     * (`#904`, carried across by `#1036`).
     *
     * An abandoned walk writes no entry and no refusal, so neither branch
     * above writes anything — and until `provider-report` folded into this
     * surface that was somebody else's job: `reportProvider` created the
     * `measured` row for exactly this case. Folding the two without this line
     * would have retired `#904`'s rule by accident, and a provider a citizen
     * abandoned would go back to reading as one nobody had been to.
     *
     * `onConflictDoNothing` inside, so an entry that already exists is untouched
     * — a measurement never demotes something somebody catalogued.
     */
    if (entry === undefined && verdict.kind !== 'writes' && verdict.kind !== 'refusal') {
      await recordMeasuredProvider(tx, { kind: walk.kind, provider: walk.provider })
    }

    /**
     * **Last, and whatever the verdict was** (`#981`). A walk that merely
     * confirmed the published shape still hit walls on the way — the price, the
     * check, the review — and those are the same fact whether or not the steps
     * matched. Running this after the branches above is what lets it count the
     * entry this walk has only just created.
     */
    await republishWalls(tx, { kind: walk.kind, provider: walk.provider })

    return { walk, verdict, ...(duplicateOf === undefined ? {} : { duplicateOf }) }
  })
}

/**
 * File a walk whether or not another account operation opened it first (`#1031`).
 *
 * **The report is itself enough evidence that an attempt happened.** A wall can
 * stop the attempt before the Colony observes a handoff or an account declaration,
 * so requiring either one discards exactly the walks the Atlas most needs.
 *
 * A prior finished report at the same pair is reused rather than multiplied, and
 * that includes one with observed steps (`#1060`).
 *
 * **The steps and the prose are two different things and only one of them is the
 * author's** — which is what the first version of this got wrong. The steps are
 * what the Colony observed happening; the prose, the outcome, the wall and the
 * direction are what the author was asked for and what the surface already
 * promises they can replace. So the reuse leaves `account_walk_steps` alone and
 * overwrites nothing but the reported fields.
 *
 * Refusing a stepped row made `#1023`'s `direction` unreachable on exactly the
 * walks it was written for: a walk opened by `kolonie.accounts.declare` has a
 * step from that moment, so every walk filed the ordinary way was frozen the
 * instant it finished.
 *
 * `rewardedAt` stays the hard stop. A paid row is immutable because a ledger
 * event already refers to what it earned.
 */
export async function submitWalkReport(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  input: WalkFinishInput,
): Promise<
  | { readonly walk: AccountWalk; readonly verdict: WalkVerdict; readonly duplicateOf?: string }
  | undefined
> {
  return db.transaction(async (tx) => {
    /** Serialize two direct reports from one citizen before either can insert. */
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

    const provider = await canonicalProvider(tx, AccountProviderSchema.parse(where.provider))
    const pair = and(
      eq(accountWalks.agentId, agentId),
      eq(accountWalks.kind, where.kind),
      eq(accountWalks.provider, provider),
    )
    const [open] = await tx
      .select({ id: accountWalks.id })
      .from(accountWalks)
      .where(and(pair, isNull(accountWalks.finishedAt)))
      .orderBy(desc(accountWalks.startedAt))
      .limit(1)
      .for('update')

    let walkId = open?.id

    if (walkId === undefined) {
      /**
       * `startedAt = finishedAt` stood here too, and was standing in for *this
       * row was written by a direct report*. That is no longer the question:
       * every unrewarded finished walk at this pair is the author's to replace.
       * It is still read, because it decides whether the reopened walk keeps its
       * own start — see below.
       */
      const [direct] = await tx
        .select({
          id: accountWalks.id,
          /**
           * Both sides written out with their table names. Drizzle renders
           * `${accountWalks.id}` bare in a select field, and a bare `id` inside
           * this subquery resolves against `account_walk_steps` — the wrong
           * answer with no error attached that `#311` is about.
           */
          hasSteps: sql<boolean>`exists (
            select 1 from account_walk_steps as step
             where step.walk_id = account_walks.id
          )`,
        })
        .from(accountWalks)
        .where(and(pair, isNotNull(accountWalks.finishedAt), isNull(accountWalks.rewardedAt)))
        .orderBy(desc(accountWalks.startedAt))
        .limit(1)
        .for('update')

      if (direct === undefined) {
        const [created] = await tx
          .insert(accountWalks)
          .values({ agentId, kind: where.kind, provider })
          .returning({ id: accountWalks.id })
        if (created === undefined) throw new Error('account_walks insert returned no row')
        walkId = created.id
      } else {
        walkId = direct.id
        await tx
          .update(accountWalks)
          .set({
            /**
             * A walk with steps keeps the moment it actually started. Equal
             * endpoints are how `unreportedWalk` tells a direct report from a
             * walk something else opened, so moving the start of a stepped row
             * to `now()` would make it read as the other kind — and `now()` is
             * transaction-stable, so it would land exactly on `finishedAt`.
             */
            ...(direct.hasSteps ? {} : { startedAt: sql`now()` }),
            finishedAt: null,
            outcome: null,
            wall: null,
            note: null,
            did: null,
            broke: null,
            changed: null,
            discarded: null,
            about: null,
            takenStepPositions: null,
            recipe: null,
            direction: null,
            fromProviderReport: false,
            scrubbedProse: null,
            proseStatus: 'approved',
            proposedAt: null,
            /**
             * **The pointer belongs to the words, so replacing them releases it**
             * (`#1104`). This row is about to be rewritten with whatever the
             * author files next; a duplicate mark left over from the paragraph it
             * replaced would keep the new one out of the corpus for a reason that
             * no longer exists anywhere.
             */
            duplicateOf: null,
          })
          .where(eq(accountWalks.id, walkId))

        /** Replacing readable prose changes the corpus before the new moderation settles. */
        await markProviderBriefingStale(tx, { kind: where.kind, provider })
      }
    }

    return finishWalk(tx, walkId, input)
  })
}

/**
 * Take back a verdict filed through the retiring `provider-report` alias
 * (`#1036`).
 *
 * **You may withdraw the verdict you filed; you may not delete the walk you
 * described.** `provider-report` has always accepted `outcome: null` as *I got
 * in after all, forget what I said*, and folding the surface into the walk had
 * to keep that promise without handing the alias a way to erase an account
 * somebody wrote in prose. `from_provider_report` is exactly that line: the
 * column the alias sets and `walk-report` never does.
 *
 * `rewarded_at` is the same hard stop it is in `submitWalkReport`, and for the
 * same reason — a ledger event already refers to what the row earned.
 *
 * Returns whether anything was withdrawn. Nothing to withdraw is not an error:
 * the surface answers `withdrawn` on a verdict that was never there, because a
 * citizen retracting something twice has the state it asked for either way.
 */
export async function withdrawReportedWalk(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const provider = await canonicalProvider(tx, AccountProviderSchema.parse(where.provider))

    const [gone] = await tx
      .delete(accountWalks)
      .where(
        and(
          eq(accountWalks.agentId, agentId),
          eq(accountWalks.kind, where.kind),
          eq(accountWalks.provider, provider),
          eq(accountWalks.fromProviderReport, true),
          isNull(accountWalks.rewardedAt),
        ),
      )
      .returning({ id: accountWalks.id })

    if (gone === undefined) return false

    /** The wall this walk contributed leaves the published aggregate with it. */
    await republishWalls(tx, { kind: where.kind, provider })
    await markProviderBriefingStale(tx, { kind: where.kind, provider })

    return true
  })
}

/** One walk the sweep paid for, for the runner's log (`#858`). */
export interface RewardedWalk {
  readonly walkId: string
  readonly agentId: AgentId
  readonly kind: string
  readonly provider: string
  /** How it ended, so the log says what the Colony just paid the same price for (`#1033`). */
  readonly outcome: string
}

/**
 * Pay the walks whose words have reached their readers (`#858`, rewritten by
 * `#1033`).
 *
 * **The Atlas is written by citizens and, until `#858`, paid for by none of
 * them.** A walk into a provider nobody had documented costs a session and
 * returns an entry the *next* agent reads — so an agent weighing that against
 * the rung it could climb instead had nothing on one side of the scale.
 *
 * **`#858` then paid only for good news, and that is what `#1033` undoes.** Its
 * four conditions were each defensible alone and composed into a rule nobody
 * wrote: `proposed_at is not null` made a refused walk invisible *by
 * construction*, because a refusal has no steps to propose; `status =
 * 'joinable'` put the payment behind a reviewer deciding the provider was worth
 * joining, so discovering that one is not paid nothing; and *first proposer,
 * once per pair, globally* meant the second walker — the one whose report turns
 * an anecdote into a measurement — earned nothing. Measured 2026-08-15 against
 * production: 20 walks, 0 paid, in the Atlas's first seven days.
 *
 * **So the event that pays is the walk being published, not an entry being
 * published.** A closed walk whose prose cleared moderation has reached
 * readers — through the provider's briefing — whatever it found there. Three
 * conditions and no more:
 *
 * - `finished_at is not null`, because a walk still running has said nothing.
 * - `scrubbed_prose is not null`, which is *the moderator read this and passed
 *   it on*. It is one column rather than a pair because it is also exactly what
 *   the briefing serves: a walk that wrote nothing has it null and reaches
 *   nobody, and so does a walk whose words were refused. What is paid for and
 *   what is published are then the same fact, and cannot drift apart.
 * - `from_provider_report = false`. The retiring `provider-report` alias asks
 *   one question and writes the Colony's own sentence as the wall, and `#1036`
 *   put that column there precisely so a reader is not told *nine walkers
 *   described this provider* when eight filed a one-word verdict. Paying both
 *   the same would make the ledger say the same untrue thing. It costs nothing
 *   in the long run: the alias is retiring, and the column is false on every
 *   row `walk-report` writes.
 *
 * **`proved`, `refused` and `abandoned` are worth the same, deliberately.** See
 * `WALK_PUBLISHED_REPUTATION`. The outcome is in the memo so the ledger reads
 * honestly rather than in the amount.
 *
 * **What is left of the anti-farming argument is the scarcity clause, and it is
 * the only one that was ever load-bearing.** Once per citizen per (kind,
 * provider), forever: the `not exists` refuses a pair this walker was already
 * paid for, and the `walk.id = (select … limit 1)` picks one walk when a citizen
 * has several waiting at the same pair. Breadth pays and depth does not, which
 * is `RED-LINES.md` enforced by the shape of the payment.
 *
 * **The `not exists` is the check and the unique index is the guarantee.** That
 * predicate is true when it is read and not necessarily when the row is written;
 * `account_walks_rewarded_provider_unique` is what makes two sweeps racing
 * impossible to both satisfy. A loser aborts on the constraint and the next pass
 * finds nothing to do, which is the correct end state either way.
 *
 * **A sweep and not a hook on the moderation verdict.** `#858`'s argument, and
 * it survives the rewrite intact: this runs beside `sweepBadges` — idempotent,
 * safe to run twice at once, and correct the day after it was not run at all.
 * Walks closed before `#1033` shipped are therefore eligible on the next pass,
 * which is the point rather than a side effect.
 *
 * One transaction covering the claim and what it paid, on `bookTaskReward`'s
 * rule: a `rewarded_at` with no reputation event behind it is a payment the
 * citizen cannot see and the sweep will never make again.
 */
export async function rewardPublishedWalks(
  db: Database | Transaction,
): Promise<readonly RewardedWalk[]> {
  const rows = await db.execute<{
    id: string
    agent_id: string
    kind: string
    provider: string
    outcome: string
  }>(sql`
    with claimed as (
      update account_walks as walk
         set rewarded_at = now()
       where walk.rewarded_at is null
         and walk.finished_at is not null
         and walk.scrubbed_prose is not null
         and walk.from_provider_report = false
         and not exists (
           select 1 from account_walks as paid
            where paid.agent_id = walk.agent_id
              and paid.kind = walk.kind
              and paid.provider = walk.provider
              and paid.rewarded_at is not null
         )
         and walk.id = (
           select first.id from account_walks as first
            where first.agent_id = walk.agent_id
              and first.kind = walk.kind
              and first.provider = walk.provider
              and first.finished_at is not null
              and first.scrubbed_prose is not null
              and first.from_provider_report = false
            order by first.finished_at asc, first.id asc
            limit 1
         )
      returning walk.id, walk.agent_id, walk.kind, walk.provider, walk.outcome
    ),
    -- Executed for its effect and never read: a data-modifying WITH runs to
    -- completion whether or not the outer query selects from it.
    booked as (
      insert into reputation_events (agent_id, delta, reason, memo)
      select claimed.agent_id,
             ${WALK_PUBLISHED_REPUTATION},
             'walk_published',
             'Atlas walk published (' || coalesce(claimed.outcome, 'closed') || '): ' ||
               claimed.kind || ' at ' || claimed.provider
        from claimed
      returning id
    )
    select id, agent_id, kind, provider, outcome from claimed`)

  return [...rows].map((row) => ({
    walkId: row.id,
    agentId: row.agent_id as AgentId,
    kind: row.kind,
    provider: row.provider,
    outcome: row.outcome,
  }))
}

/**
 * The published walk this citizen has not been told was paid, if any (`#858`).
 *
 * `untoldBadge`'s shape exactly, and for its reason: the words clear moderation
 * days later, in a session the walker is not in, and nothing else would ever
 * tell it. Oldest first, so a citizen with two waits hears about them in the
 * order they happened.
 *
 * **It asks whether a payment was made and never why** (`#1033`), which is why
 * widening *what gets paid* to every outcome needed nothing here.
 */
export async function untoldWalkReward(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ readonly id: string; readonly provider: string } | null> {
  const rows = await db
    .select({ id: accountWalks.id, provider: accountWalks.provider })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        isNotNull(accountWalks.rewardedAt),
        isNull(accountWalks.rewardToldAt),
      ),
    )
    .orderBy(asc(accountWalks.rewardedAt))
    .limit(1)

  return rows[0] ?? null
}

/**
 * Mark that the Colony has told this citizen its walk was paid.
 *
 * `where reward_told_at is null returning`, so two reads racing inside one run
 * cannot both spend the hint slot on it — `markBadgeTold`'s idiom, unchanged.
 */
export async function markWalkRewardTold(db: Database | Transaction, id: string): Promise<boolean> {
  const told = await db
    .update(accountWalks)
    .set({ rewardToldAt: sql`now()` })
    .where(and(eq(accountWalks.id, id), isNull(accountWalks.rewardToldAt)))
    .returning({ id: accountWalks.id })

  return told.length > 0
}

/** One walk's words, waiting on the stage between them and any other reader (`#810`). */
export interface UnmoderatedWalkProse {
  readonly walkId: string
  readonly kind: string
  readonly provider: string
  /** The fields that were answered, in `WALK_PROSE_FIELDS` order. Never empty. */
  readonly prose: WalkProse
}

/**
 * The walks whose words nobody has read, oldest first.
 *
 * Ordered by when the walk finished rather than when it started: what is queued
 * is the writing, and the writing happens at the end. A walk opened on Monday
 * and closed on Friday is Friday's row.
 */
export async function unmoderatedWalkProse(
  db: Database,
  limit: number,
): Promise<readonly UnmoderatedWalkProse[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(eq(accountWalks.proseStatus, 'pending'))
    .orderBy(asc(accountWalks.finishedAt))
    .limit(limit)

  return rows.flatMap((row) => {
    const prose = walkProse(row)

    /**
     * **A pending row with nothing on it is skipped rather than queued.** It
     * should not exist — both write paths set `pending` only where there is
     * something to read — but a queue that handed the model an empty page would
     * spend a call to be told nothing, every poll, forever.
     */
    return walkHasProse(prose)
      ? [{ walkId: row.id, kind: row.kind, provider: row.provider, prose }]
      : []
  })
}

/** Approved words left without the scrub that makes a finished walk publishable (`#1095`). */
export interface ApprovedWalkProseWithoutScrub {
  readonly walkId: string
  readonly kind: string
  readonly provider: string
  /** May be empty: the state predicate, not a second prose predicate, defines this repair queue. */
  readonly prose: WalkProse
}

/**
 * Finished approvals missing their scrub, oldest first (`#1095`).
 *
 * The state is the whole predicate. In particular, there is no date cut-off:
 * any later write that recreates the gap belongs on the same permanent sweep.
 */
export async function approvedWalkProseWithoutScrub(
  db: Database,
  limit: number,
): Promise<readonly ApprovedWalkProseWithoutScrub[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.proseStatus, 'approved'),
        isNotNull(accountWalks.finishedAt),
        isNull(accountWalks.scrubbedProse),
      ),
    )
    .orderBy(asc(accountWalks.finishedAt))
    .limit(limit)

  return rows.map((row) => ({
    walkId: row.id,
    kind: row.kind,
    provider: row.provider,
    prose: walkProse(row),
  }))
}

/** A refusal the current scrubber has not read, put back in the queue (`#1108`). */
export interface RequeuedWalkProse {
  readonly walkId: string
  readonly kind: AccountKind
  readonly provider: string
  /**
   * The scrubber that refused it, or `null` where it was refused before the
   * stamp existed. What the log says, so a maintainer reading a run can tell the
   * thirteen historical refusals from a genuine version bump.
   */
  readonly refusedBy: number | null
}

/**
 * Put the refusals an older scrubber reached back in front of the current one
 * (`#1108`).
 *
 * **A refusal is not permanent; it is a verdict reached once by something that
 * can change.** `rejected` is terminal in three independent places — this queue
 * selects `pending`, {@link recordWalkProseModeration} guards on `pending`, and
 * the schema forbids a scrubbed refusal — and none of that is wrong. This is the
 * one sentence that was missing beside it: *the thing that reached it has
 * changed*, said by {@link WALK_PROSE_SCRUBBER_VERSION} moving.
 *
 * **One write, and it is `prose_status` back to `pending`.** From there the walk
 * takes the path every other walk takes, judged by today's prompt, and there is
 * no second moderation path to keep in step with the first. `scrubbed_prose` is
 * already null on a refused row and stays null, which is what
 * `account_walks_scrubbed_prose_iff_approved` requires.
 *
 * **The stamp is left where it is.** It says which scrubber refused this walk
 * until another one has read it, and a crash between this write and that verdict
 * leaves a `pending` row the ordinary queue picks up — the same end state as any
 * other unjudged walk.
 *
 * **The reason goes, though** (`#1340`). A sentence saying why a walk was refused
 * belongs to a refusal that stands; this write is the Colony withdrawing that
 * refusal pending a second reading, so keeping the old sentence would tell the
 * walker on `walk-status` why its words were refused while they sit unjudged.
 * The stamp is a fact about the past and survives; the reason is a live verdict
 * and does not. The column's own check says the same thing — a reason is only
 * ever carried by a `rejected` row.
 *
 * **Only `rejected`, and an approval is never re-opened** (`#1108`, 4). The
 * asymmetry is the decision and not an oversight to be tidied up: re-reading a
 * refusal can only give a citizen back something it was denied, and re-reading an
 * approval can only take away something already published and already paid for.
 *
 * **What makes it terminate is the stamp and not a retry count.** A walk refused
 * again is stamped with the current version by the write that refuses it, so it
 * fails this predicate from then on. There is no loop and nothing to tune.
 *
 * Oldest first and bounded, like every queue here: what is left over is the next
 * tick's work.
 */
export async function requeueRefusedWalkProse(
  db: Database,
  limit: number,
): Promise<readonly RequeuedWalkProse[]> {
  const stale = and(
    eq(accountWalks.proseStatus, 'rejected'),
    isNotNull(accountWalks.finishedAt),
    or(
      isNull(accountWalks.proseScrubberVersion),
      lt(accountWalks.proseScrubberVersion, WALK_PROSE_SCRUBBER_VERSION),
    ),
  )

  const rows = await db
    .update(accountWalks)
    /**
     * **The line comes off with the reason** (`#1467`). A walk going back to
     * `pending` is one nothing has judged yet, and both columns are constrained
     * to a refusal — the second constraint is what caught this the first time it
     * was written without the line, which is the argument for it being a
     * constraint rather than a convention.
     */
    .set({ proseStatus: 'pending', proseRefusalReason: null, proseRefusalLine: null })
    .where(
      and(
        stale,
        /**
         * The bound, as a subquery, because an `update` takes no `limit`. The
         * predicate is repeated inside it rather than narrowed to the ids alone
         * so that a row that stopped qualifying between the two — another runner
         * having judged it — is not re-queued by the outer statement.
         */
        inArray(
          accountWalks.id,
          db
            .select({ id: accountWalks.id })
            .from(accountWalks)
            .where(stale)
            .orderBy(asc(accountWalks.finishedAt), asc(accountWalks.id))
            .limit(limit),
        ),
      ),
    )
    .returning({
      id: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      /** `returning` answers with the row as it stands, and this column was not touched. */
      refusedBy: accountWalks.proseScrubberVersion,
    })

  return rows.map((row) => ({
    walkId: row.id,
    kind: AccountKindSchema.parse(row.kind),
    provider: row.provider,
    refusedBy: row.refusedBy,
  }))
}

type WalkProseModerationDecision =
  | { readonly decision: 'approved'; readonly scrubbed: WalkProse }
  /**
   * The moderator's own sentence about why this page crossed a line (`#1340`).
   *
   * **Required rather than optional**, so a refusal that reaches the row with
   * nothing to say is a type error and not a silent null. What arrives may
   * still be empty — it is model output — and `walkRefusalReason` answers
   * `null` for that; what cannot happen is a write path that forgot to carry it.
   */
  | {
      readonly decision: 'rejected'
      readonly reason: string
      /**
       * Which red line, as `#1467`'s closed vocabulary.
       *
       * Required on the same terms as the sentence beside it and for a sharper
       * reason: this is what the consecutive backstop counts, and a refusal that
       * reached the row without one is a refusal the rule has to treat as its own
       * distinct wall. Making it a type error is what keeps that case to the rows
       * written before the column existed.
       */
      readonly line: WalkRefusalLine
    }

type WalkProseModerationCommand = {
  readonly walkId: string
  /** What the moderator was shown. The verdict is refused if it has changed. */
  readonly judged: WalkProse
} & WalkProseModerationDecision

const moderatedWalkProseValue = (command: WalkProseModerationCommand): WalkProse | null =>
  command.decision === 'approved' ? WalkProseSchema.parse(command.scrubbed) : null

/**
 * The reason as the row keeps it: a sentence on a refusal, `null` on anything
 * else (`#1340`). The constraint says the same thing in the database.
 */
const refusalReasonValue = (command: WalkProseModerationCommand): string | null =>
  command.decision === 'rejected' ? walkRefusalReason(command.reason) : null

/**
 * The line as the row keeps it: a member on a refusal, `null` on anything else
 * (`#1467`). The constraint beside the reason's says the same thing.
 */
const refusalLineValue = (command: WalkProseModerationCommand): WalkRefusalLine | null =>
  command.decision === 'rejected' ? command.line : null

/**
 * Write what the scrub produced, or refuse the words.
 *
 * **What the moderator read is part of the key**, the guard `recordModeration`
 * puts on a report, and it is needed here for a narrower race than there. A
 * walk's answers are written once and cannot be edited —
 * `reportFinishedWalk` applies only where the walk holds none — but that same
 * function can add the four questions to a walk already closed with a `wall`,
 * and it re-queues the row when it does. A verdict reached against the wall
 * alone must not then approve four answers nothing looked at.
 *
 * Compared field by field rather than over a digest, so that a mismatch is a
 * mismatch on the column that actually changed and no second definition of *what
 * was judged* exists to drift from the first.
 *
 * **The route is guarded too, and cannot be guarded the same way** (`#1090`).
 * `route` is not a column — it is `recipe`, a `jsonb`, rendered — and
 * `amendWalkedRoute` rewrites that field on a walk that has already finished.
 * So it is compared as what the moderator actually read: the row is locked, the
 * route re-rendered from it by the one function that renders it, and the verdict
 * refused if those bytes differ. Comparing the rendered text rather than the
 * object is the stricter of the two and the right one — a renderer that changed
 * under a verdict changed what was judged just as surely as an amendment would.
 */
export async function recordWalkProseModeration(
  db: Database,
  command: WalkProseModerationCommand,
): Promise<WalkProseVerdictResult> {
  return db.transaction(async (tx) => await writeWalkProseVerdict(tx, command))
}

/**
 * What a verdict did: the write, and whether it cost the citizen its standing.
 *
 * **`suspended` is reported rather than logged here** (`#1097`). The store is the
 * only place that can know — the count and the write are one statement — and the
 * runner is the only place that can say it in a tick's counters. A `console.log`
 * at this layer would be a second, quieter answer to *how often does this
 * happen*, and one that no test reads.
 *
 * It is `false` on every stale verdict and on every approval, so a caller that
 * adds it up is counting suspensions and not writes.
 */
export interface WalkProseVerdictResult {
  readonly outcome: 'written' | 'stale'
  /** `true` only when this verdict was the refusal that crossed the threshold. */
  readonly suspended: boolean
}

/**
 * Lock the row and say whether the words a verdict names are still on it.
 *
 * `undefined` is *the subject moved*, and the caller's answer to that is always
 * `stale`. Shared by both verdict paths so that **what was judged** keeps the
 * one definition the comment above {@link recordWalkProseModeration} describes:
 * a repair that compared its own way would be a second answer to the same
 * question, free to drift from the first (`#1095`).
 *
 * The columns come back as conditions rather than as a verdict of their own,
 * because the caller adds its state predicate to the same `where` — the guard
 * and the state it guards have to be one write.
 */
async function walkProseUnchanged(
  db: Database | Transaction,
  command: { readonly walkId: string; readonly judged: WalkProse },
): Promise<readonly SQL[] | undefined> {
  const [locked] = await db
    .select({ recipe: accountWalks.recipe })
    .from(accountWalks)
    .where(eq(accountWalks.id, command.walkId))
    .for('update')
    .limit(1)

  if (locked === undefined) return undefined
  if (walkProse({ recipe: locked.recipe }).route !== command.judged.route) return undefined

  return WALK_PROSE_COLUMNS.map((field) => {
    const judged = command.judged[field]
    return judged === undefined ? isNull(accountWalks[field]) : eq(accountWalks[field], judged)
  })
}

async function writeWalkProseVerdict(
  db: Transaction,
  command: WalkProseModerationCommand,
): Promise<WalkProseVerdictResult> {
  const unchanged = await walkProseUnchanged(db, command)
  if (unchanged === undefined) return { outcome: 'stale', suspended: false }

  const written = await db
    .update(accountWalks)
    .set({
      proseStatus: command.decision,
      /**
       * **A refusal keeps its row and gains no scrub.** The citizen wrote it, the
       * Colony declined to pass it on, and everything the walk *is* — the
       * outcome, the steps, the entry it wrote — stands untouched. There is no
       * attempt to fail here and no standing to move.
       */
      scrubbedProse: moderatedWalkProseValue(command),
      /**
       * **Why, on the row, in the same statement as the verdict** (`#1340`).
       * Until this column existed the sentence reached one log line and nothing
       * else, so a suspended walker could not be told what it had crossed and a
       * maintainer could answer *why* only from a log that had already rotated.
       */
      proseRefusalReason: refusalReasonValue(command),
      /**
       * **And which line it was** (`#1467`). The sentence above is written for
       * the walker; this is what `suspendForRefusedWalkProse` counts, because a
       * `count(distinct …)` over the sentence counts wordings and the moderator
       * writes a fresh one every time.
       */
      proseRefusalLine: refusalLineValue(command),
      /**
       * **Both verdicts are stamped, and the caller cannot forget to** (`#1108`,
       * 1). It is written here rather than passed in because *judged by this
       * scrubber* is a fact about this write and not a decision any caller
       * makes — a parameter would be one more thing a second write path could
       * omit, and a row with no stamp is one the re-queue sweep reads as *judged
       * before the stamp existed*.
       */
      proseScrubberVersion: WALK_PROSE_SCRUBBER_VERSION,
    })
    .where(
      and(
        eq(accountWalks.id, command.walkId),
        eq(accountWalks.proseStatus, 'pending'),
        ...unchanged,
      ),
    )
    .returning({
      id: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      /** Who wrote it, for the refusal tally alone — it is never logged. */
      agentId: accountWalks.agentId,
      /** What this walker asked to label the provider (`#1434`), still unpublished. */
      filedTags: accountWalks.filedTags,
    })

  const row = written[0]
  if (row === undefined) return { outcome: 'stale', suspended: false }

  /**
   * **The tags this walk filed reach the entry here, and only here** (`#1434`).
   *
   * A tag is a slug, so nothing scrubs it and there is no scrubbed copy to
   * write — what it waits for is the *verdict*. `#981` section 4 draws the line
   * this sits on: a kind, a count, a boolean and a number publish unmoderated
   * because none of them can carry a grudge, and everything that can waits. A
   * slug can (`honeygain-is-a-scam` is a valid one), so it waits.
   *
   * **A refusal publishes none**, which falls out of the branch rather than
   * being a rule kept here: the whole page was declined, and a label from a page
   * the Colony would not pass on is a label it would not pass on either.
   *
   * **The union, so a walk cannot withdraw another walker's tag** — see
   * `addRecipeTags`, and `addRecipeEarnFacets` one axis over for the shape of
   * that mistake. `false` where the provider has no entry to hang a facet off,
   * which is the ordinary case for a kind that reaches no shelf.
   */
  if (command.decision === 'approved' && row.filedTags !== null && row.filedTags.length > 0) {
    await addRecipeTags(db, AccountKindSchema.parse(row.kind), row.provider, row.filedTags)
  }

  // First-pass verdict only — rescrub has its own write path and must not
  // double-count (`#1259`). Walk refusals are red-line only, so a rejection is
  // the abusive arm with no second model call (`#1260`).
  await insertContributionVerdict(
    db,
    contributionVerdictRow({
      agentId: AgentIdSchema.parse(row.agentId),
      surface: 'walk-report',
      verdict: command.decision === 'approved' ? 'approved' : 'abusive',
      /**
       * **The ledger gets the sentence too** (`#1340`). The row above is what
       * the two readers ask — both of their questions are about a walk, and
       * this table carries no walk — but a moderation ledger whose one
       * reasonless surface was the walk stage would be a gap in the record for
       * no reason at all. Null on an approval, which is what the column's own
       * constraint requires; never null on a refusal since `#1398`, because
       * `walkRefusalReason` answers with a category where the model answered
       * with nothing.
       */
      reason: refusalReasonValue(command) ?? undefined,
    }),
  )

  /**
   * **The provider's briefing is marked stale here, and not by the caller**
   * (`#831`). This is the only place a walk's words become readable, so it is the
   * only place that has to remember: a moderation path that approved prose and
   * left the briefing alone would serve a write-up that is missing the walk it
   * was waiting for, and nothing downstream could tell.
   *
   * A rejection marks nothing. The corpus reads the scrubbed column alone, so
   * refused words changed nothing a synthesis would read.
   */
  if (command.decision === 'approved') {
    await markProviderBriefingStale(db, {
      kind: AccountKindSchema.parse(row.kind),
      provider: row.provider,
    })

    /**
     * **Approved walker about reaches entry identity here** (`#1297`).
     *
     * Closing a walk only writes `about` onto a first measured row. Later walks
     * — the clawtasks-shaped case — left approved prose on the walk while the
     * entry still rendered content-empty. Promoting on approval fills `about`
     * and, when it fits the description bound, `description`, without waiting
     * on synthesis and without inventing a second identity field.
     */
    const scrubbedAbout = command.scrubbed.about ?? null
    if (scrubbedAbout !== null && scrubbedAbout.trim() !== '') {
      await promoteWalkerAboutToEntryIdentity(db, {
        kind: AccountKindSchema.parse(row.kind),
        provider: row.provider,
        about: scrubbedAbout,
      })
    }

    return { outcome: 'written', suspended: false }
  }

  return { outcome: 'written', suspended: await suspendForRefusal(db, row.agentId) }
}

/**
 * Count this citizen's refusals and suspend it if this one was the fifth
 * (`#1097`).
 *
 * **In the verdict's own transaction**, which is the whole reason it is called
 * from here rather than from the runner. The refusal that crosses the threshold
 * and the suspension it causes commit together or not at all; a runner that
 * counted afterwards would suspend on a refusal that had rolled back, or fail to
 * suspend on one that had not.
 *
 * The rule itself — what is counted, what the threshold is, which statuses may be
 * written — is {@link suspendForRefusedWalkProse} in `citizenship.ts`, beside
 * {@link promoteIfEarned}. It lives there because *who is a citizen* is one
 * question and this file is not where it is answered.
 */
async function suspendForRefusal(db: Transaction, agentId: string): Promise<boolean> {
  const { suspended } = await suspendForRefusedWalkProse(db, {
    agentId: AgentIdSchema.parse(agentId),
    suspendedAt: new Date().toISOString(),
  })

  return suspended
}

/**
 * Fill the scrub missing from a finished approval, or reverse an approval whose
 * second reading crosses a red line (`#1095`).
 *
 * The same {@link walkProseUnchanged} guard as {@link recordWalkProseModeration}
 * keeps a verdict on the words it read. The state guard is deliberately the
 * repair queue's complete predicate, so this function cannot turn a pending,
 * unfinished, already-scrubbed or rejected walk into something else.
 *
 * Briefing invalidation is in the same transaction as the first successful
 * repair for a provider in one bounded runner pass. That removes the window
 * where synthesis could clear the flag before the repaired prose became
 * readable, while still collapsing several walks at one provider into one call.
 */
export async function recordApprovedWalkProseRescrub(
  db: Database,
  command: WalkProseModerationCommand,
  markBriefingStale: boolean,
): Promise<WalkProseVerdictResult> {
  return db.transaction(async (tx) => {
    const unchanged = await walkProseUnchanged(tx, command)
    if (unchanged === undefined) return { outcome: 'stale' as const, suspended: false }

    const written = await tx
      .update(accountWalks)
      .set({
        proseStatus: command.decision,
        scrubbedProse: moderatedWalkProseValue(command),
        /** A second reading refuses with a reason like the first (`#1340`). */
        proseRefusalReason: refusalReasonValue(command),
        /**
         * **And which line it was** (`#1467`). The sentence above is written for
         * the walker; this is what `suspendForRefusedWalkProse` counts, because a
         * `count(distinct …)` over the sentence counts wordings and the moderator
         * writes a fresh one every time.
         */
        proseRefusalLine: refusalLineValue(command),
        /** A second reading is a reading: it is stamped like the first (`#1108`). */
        proseScrubberVersion: WALK_PROSE_SCRUBBER_VERSION,
      })
      .where(
        and(
          eq(accountWalks.id, command.walkId),
          eq(accountWalks.proseStatus, 'approved'),
          isNotNull(accountWalks.finishedAt),
          isNull(accountWalks.scrubbedProse),
          ...unchanged,
        ),
      )
      .returning({
        id: accountWalks.id,
        kind: accountWalks.kind,
        provider: accountWalks.provider,
        agentId: accountWalks.agentId,
      })

    const row = written[0]
    if (row === undefined) return { outcome: 'stale' as const, suspended: false }

    if (markBriefingStale) {
      await markProviderBriefingStale(tx, {
        kind: AccountKindSchema.parse(row.kind),
        provider: row.provider,
      })
    }

    /**
     * **A reversal counts** (`#1097` decision 1). The tally is *refusals*, and a
     * second reading that crosses a red line is the Colony refusing those words —
     * that it once approved them is a fact about the scrubber and not about what
     * the citizen wrote. Counting it anywhere else would mean a citizen whose
     * every refusal arrived by repair is never suspended at all.
     */
    return {
      outcome: 'written' as const,
      suspended: command.decision === 'rejected' ? await suspendForRefusal(tx, row.agentId) : false,
    }
  })
}

/** A walk the sweep recognised as a repeat of an earlier published one (`#1109`). */
export interface MarkedDuplicateWalk {
  readonly walkId: string
  readonly kind: AccountKind
  readonly provider: string
  /** The earlier walk it repeats, always an original and never itself a duplicate. */
  readonly duplicateOf: string
}

/**
 * Compare the walks that are already published against each other (`#1109`).
 *
 * **`#1104` protects every report from its merge onward and nothing before it.**
 * The corpus that existed when it landed was never compared against itself, so a
 * repeat already in it stays in it — and `synthesiseProvider()` has the number of
 * sources behind a claim where a confidence would be, so ten copies of one
 * paragraph read as the best-evidenced thing the Colony knows about a provider.
 * This is that same cost, in the rows that are already there.
 *
 * **The signal is `#1104`'s signal**: {@link normalisedProse}, the same exported
 * threshold, the same pair, the same requirement that the outcome match. Two
 * answers to *what counts as the same text* is a thing that drifts.
 *
 * **The earlier walk is the original**, ordered `finished_at` then id, both
 * ascending. That makes the result deterministic and the second run of the sweep
 * a no-op. A walk already carrying a pointer is neither a candidate nor an
 * original again, so every pointer names the earliest original and there are no
 * chains to follow.
 *
 * **What it does not do**: it does not clear `scrubbed_prose`, does not touch
 * `prose_status`, and writes nothing to the ledger. A walk recognised here has
 * been served under a UUID `#1101`'s reader hands out as a reference, and the
 * reputation it was paid was paid under a rule its author could not have read.
 * What the pointer costs it is its place in {@link providerBriefingCorpus}.
 *
 * Bounded per call, like every other runner pass: what is left over is the next
 * tick's work, and the marks made here stand whatever happens after them.
 */
export async function markPublishedDuplicateWalks(
  db: Database,
  limit: number,
): Promise<readonly MarkedDuplicateWalk[]> {
  return db.transaction(async (tx) => {
    const marked: MarkedDuplicateWalk[] = []
    /** `kind` and `provider` together, so one group is marked stale once (`#1109`, 12). */
    const stale = new Set<string>()

    /**
     * One pair at a time, because each mark changes the candidates: the walk just
     * marked leaves the comparison from both sides, which is what turns three
     * copies into two pointers at the first of them rather than a chain.
     */
    for (let found = 0; found < limit; found += 1) {
      const later = alias(accountWalks, 'later')
      const earlier = alias(accountWalks, 'earlier')

      const [pair] = await tx
        .select({
          walkId: later.id,
          kind: later.kind,
          provider: later.provider,
          duplicateOf: earlier.id,
        })
        .from(later)
        .innerJoin(
          earlier,
          and(
            eq(earlier.kind, later.kind),
            eq(earlier.provider, later.provider),
            eq(earlier.outcome, later.outcome),
            /** Both published: an unpublished walk is not a text anybody could have read. */
            isNotNull(earlier.finishedAt),
            isNotNull(earlier.scrubbedProse),
            isNull(earlier.duplicateOf),
            sql`(${earlier.finishedAt}, ${earlier.id}) < (${later.finishedAt}, ${later.id})`,
            sql`similarity(${normalisedProse(earlier)}, ${normalisedProse(later)}) >= ${WALK_DUPLICATE_SIMILARITY}::real`,
          ),
        )
        .where(
          and(
            isNotNull(later.finishedAt),
            isNotNull(later.scrubbedProse),
            isNull(later.duplicateOf),
            /** Nothing written is nothing to repeat, as at the moment of filing. */
            sql`${normalisedProse(later)} <> ''`,
          ),
        )
        .orderBy(asc(later.finishedAt), asc(later.id), asc(earlier.finishedAt), asc(earlier.id))
        .limit(1)

      if (pair === undefined) break

      const written = await tx
        .update(accountWalks)
        .set({ duplicateOf: pair.duplicateOf })
        .where(and(eq(accountWalks.id, pair.walkId), isNull(accountWalks.duplicateOf)))
        .returning({ id: accountWalks.id })

      /** The row moved under the read. Stop rather than loop on a pair that will not take. */
      if (written[0] === undefined) break

      const kind = AccountKindSchema.parse(pair.kind)
      marked.push({
        walkId: pair.walkId,
        kind,
        provider: pair.provider,
        duplicateOf: pair.duplicateOf,
      })

      const group = `${pair.kind} ${pair.provider}`
      if (!stale.has(group)) {
        stale.add(group)
        await markProviderBriefingStale(tx, { kind, provider: pair.provider })
      }
    }

    return marked
  })
}

/** One walk's words as anybody but their author may read them. */
export interface ModeratedWalkProse {
  readonly walkId: string
  readonly finishedAt: string
  readonly outcome: WalkOutcome
  /**
   * Which runtime the walker was running, for the breakdown a provider briefing
   * carries (`#831`).
   *
   * **The runtime and never the walker.** It is the one thing about the author
   * that a reader is served, it is served only as a count on a claim that several
   * walks support, and it is here for the reason `BriefingClaim.platforms` exists:
   * a wall six agents hit on one runtime and nobody hit elsewhere is a fact about
   * that runtime, and a reader who cannot make that comparison draws the wrong
   * conclusion about the provider.
   */
  readonly platform: AgentPlatform
  readonly prose: WalkProse
}

/**
 * What has been said about one provider and cleared for a reader (`#810`).
 *
 * **The scrubbed column and never the six raw ones.** This is the whole reading
 * side of the stage above, and it is a function rather than a `where` clause on
 * each surface for the reason the column comment gives: *no citizen's
 * unmoderated words reach a reader* should hold by there being nothing to
 * select.
 *
 * Newest first, because a corpus about a provider decays — a wall from March is
 * evidence about March, and a reader taking a bounded window should be taking
 * the recent end of it.
 */
export async function moderatedWalkProse(
  db: Database,
  where: {
    readonly kind: AccountKind
    readonly provider: string
    /**
     * Leave out the walks `#1109`'s sweep recognised as repeats of an earlier
     * one.
     *
     * **Off by default, and the default is the reader's** (`#1109`, 8 and 10). A
     * walk marked after it was published keeps its scrub and stays readable
     * under the reference it was served with; what it loses is its place in the
     * corpus a briefing is written from, because that is the one place where a
     * repeat is counted as a second source.
     *
     * **The caller passes it here rather than filtering what comes back**, so
     * the exclusion happens before `limit`. A corpus asking for
     * `RECENT_WALKS_IN_CONTEXT` sources and filtering afterwards would hand the
     * synthesis fewer sources than it asked for whenever a repeat was in the
     * window — quietly, and worst at exactly the providers with the most walks.
     */
    readonly withoutDuplicates?: boolean | undefined
  },
  limit = 100,
): Promise<readonly ModeratedWalkProse[]> {
  const provider = await canonicalProvider(db, where.provider)

  const rows = await db
    .select({
      id: accountWalks.id,
      finishedAt: accountWalks.finishedAt,
      outcome: accountWalks.outcome,
      platform: agents.platform,
      scrubbedProse: accountWalks.scrubbedProse,
    })
    .from(accountWalks)
    /**
     * An inner join, which is what makes *every row has a runtime* a property of
     * the query rather than of a default written into the mapping below. The
     * reference is `not null` and cascades, so a walk whose agent is gone is a
     * walk that is gone too — there is no row this can drop.
     */
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .where(
      and(
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, provider),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.scrubbedProse),
        where.withoutDuplicates === true ? isNull(accountWalks.duplicateOf) : undefined,
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .limit(limit)

  return rows.map((row) => ({
    walkId: row.id,
    finishedAt: toTimestamp(row.finishedAt as string),
    outcome: WalkOutcomeSchema.parse(row.outcome),
    platform: AgentPlatformSchema.parse(row.platform),
    prose: row.scrubbedProse as WalkProse,
  }))
}

/**
 * How many walks one page of {@link publishedWalksAt} serves, and the most a
 * caller can ask for (`#1101`).
 *
 * Twenty and fifty, the numbers the rest of the catalogue paginates by, and for
 * the same reason: a walk is a page of prose rather than a row, and a reader
 * asking for more than fifty of them at once is asking for something it will not
 * read. A caller asking for five hundred is given fifty rather than an error —
 * the ceiling is a property of the response, and refusing would only make every
 * caller learn the number by being refused once.
 */
export const PUBLISHED_WALKS_PAGE = 20
export const PUBLISHED_WALKS_MAX_PAGE = 50

/**
 * One published walk, as a citizen that did not write it reads it (`#1101`).
 *
 * **The walk id is the reference and it is printed with every walk.** It is what
 * a citizen quotes in a support ticket, what a note is voted on by, and what a
 * briefing claim traces back to — so it is here rather than derivable.
 *
 * **The handle and never the agent id.** `by` is null for a citizen that
 * declined attribution and the walk is served regardless, which is
 * `publishedWalkNotes`'s rule and the one `agents.attributed` exists to state:
 * the flag decides whether the name travels, never whether the work does. There
 * is no field on this shape an agent id could be put in.
 */
export interface PublishedWalk {
  readonly walkId: string
  readonly kind: AccountKind
  readonly provider: string
  readonly finishedAt: string
  readonly outcome: WalkOutcome
  readonly direction: RecipeDirection | null
  readonly by: string | null
  readonly prose: WalkProse
  /**
   * The earlier walk this one repeats, where `#1109`'s sweep found one.
   *
   * **Marked and not hidden.** A reader served a repeat as an independent report
   * would be making the same mistake the briefing corpus was making, and a walk
   * dropped from the page would take a reference other citizens may already
   * quote with it. So it is here, as the same UUID this reader hands out for
   * every walk, and the reader says what it is.
   */
  readonly repeats: string | null
}

/** A page of them, and where the next one starts. */
export interface PublishedWalkPage {
  readonly walks: readonly PublishedWalk[]
  readonly nextCursor: string | null
}

/**
 * The evidence under a provider's briefing, readable rather than only summarised
 * (`#1101`).
 *
 * **The same predicate {@link moderatedWalkProse} reads and not a second one.**
 * `finished_at is not null and scrubbed_prose is not null` is the Colony's one
 * definition of a published walk — what `#1033` pays on, what the briefing
 * corpus is built from — and a reader that invented its own would be a second
 * place for that definition to drift. A walk approved but never scrubbed is
 * absent here whatever its `prose_status` says, because the scrub *is* the
 * clearance.
 *
 * **Newest first, ties broken by id, and the order is total.** A cursor is a
 * position in an ordering, so an ordering that leaves two walks unranked hands
 * one of them out twice and the other never. Two walks finished in the same
 * microsecond are rare and the tie-break costs nothing.
 *
 * **`direction` matches a walk that measured nothing in particular.** A walk
 * filed before the axis existed, or on a kind that has only one capability,
 * carries null — dropping those would answer *the walks filed since `#1023`*
 * under a filter that says *the walks about receiving*. `both` matches for the
 * same reason it does in the catalogue: a walk that measured either way is
 * evidence for a reader asking about either.
 *
 * **No filter on the author, at any price.** The Atlas is a catalogue of
 * providers; a `by` argument would make it a way to browse one citizen's record,
 * which is a different thing and one nobody asked for.
 */
export async function publishedWalksAt(
  db: Database,
  where: {
    readonly provider: string
    /**
     * A loose string, as the catalogue's own `kind` filter is: the vocabulary
     * grows whenever the Academy learns to verify something new, and a kind
     * nobody has walked matches nothing rather than being refused.
     */
    readonly kind?: string | undefined
    readonly outcome?: WalkOutcome | undefined
    readonly direction?: RecipeDirection | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  },
): Promise<PublishedWalkPage | 'invalid-cursor'> {
  const after = decodeWalkCursor(where.cursor)
  if (after === 'invalid') return 'invalid-cursor'

  const provider = await canonicalProvider(db, where.provider)
  /**
   * Clamped rather than refused, and the floor is one: a caller asking for zero
   * walks is asking a question with no answer, and the page it gets back would
   * be indistinguishable from a provider nobody has walked.
   */
  const limit = Math.min(
    Math.max(Math.trunc(where.limit ?? PUBLISHED_WALKS_PAGE), 1),
    PUBLISHED_WALKS_MAX_PAGE,
  )

  const rows = await db
    .select({
      id: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      finishedAt: accountWalks.finishedAt,
      outcome: accountWalks.outcome,
      direction: accountWalks.direction,
      /** Resolved in the SQL, so a handle a citizen declined is never in memory. */
      by: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
      scrubbedProse: accountWalks.scrubbedProse,
      duplicateOf: accountWalks.duplicateOf,
    })
    .from(accountWalks)
    /** Inner, for the reason `moderatedWalkProse` gives: the reference cascades, so nothing drops. */
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .where(
      and(
        eq(accountWalks.provider, provider),
        where.kind === undefined ? undefined : eq(accountWalks.kind, where.kind),
        where.outcome === undefined ? undefined : eq(accountWalks.outcome, where.outcome),
        where.direction === undefined || where.direction === 'both'
          ? undefined
          : sql`(${accountWalks.direction} is null or ${accountWalks.direction} in ('both', ${where.direction}))`,
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.scrubbedProse),
        after === undefined
          ? undefined
          : sql`(${accountWalks.finishedAt}, ${accountWalks.id}) < (${after.finishedAt}::timestamptz, ${after.walkId}::uuid)`,
      ),
    )
    .orderBy(desc(accountWalks.finishedAt), desc(accountWalks.id))
    /** One more than asked for, so *is there a next page* is a fact about this read. */
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const last = page.at(-1)

  return {
    walks: page.map((row) => ({
      walkId: row.id,
      kind: AccountKindSchema.parse(row.kind),
      provider: row.provider,
      finishedAt: toTimestamp(row.finishedAt as string),
      outcome: WalkOutcomeSchema.parse(row.outcome),
      direction: row.direction === null ? null : RecipeDirectionSchema.parse(row.direction),
      by: row.by,
      prose: row.scrubbedProse as WalkProse,
      repeats: row.duplicateOf,
    })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? Buffer.from(`${last.finishedAt as string}|${last.id}`, 'utf8').toString('base64url')
        : null,
  }
}

/**
 * The other direction, and `'invalid'` rather than a throw for the reason
 * `listTasks` gives: every field is attacker-supplied. A cursor is bound as a
 * parameter and cannot inject SQL, but an unparseable timestamp reaching the
 * query would reach the agent as `internal` — the Colony calling the agent's own
 * typo a fault on our side, which it will then retry forever.
 *
 * The timestamp is carried as the column's own text and not as an ISO string:
 * Postgres stores microseconds, and a cursor rounded to milliseconds would skip
 * a walk or repeat one at exactly the boundary it exists to sit on.
 */
function decodeWalkCursor(
  cursor: string | null | undefined,
): { readonly finishedAt: string; readonly walkId: string } | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined

  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 2) return 'invalid'
  const [finishedAt, walkId] = parts as [string, string]

  if (finishedAt === '' || Number.isNaN(Date.parse(finishedAt))) return 'invalid'
  if (!UUID.test(walkId)) return 'invalid'

  return { finishedAt, walkId }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Finished walks against entries that are published, whose shape did not match.
 *
 * **The signal `#549` named as the one on the curation screen that would
 * actually get used** — *a provider changing its signup form without telling
 * anybody* — and this is what feeds it. A falling success rate says something
 * changed; this says **what**.
 *
 * Read rather than stored: a `diverged` flag would need something sweeping it,
 * and the day that job stops the queue silently empties. Recomputing from the
 * walk and the entry cannot stop running.
 */
export async function divergentWalks(
  db: Database,
  limit = 20,
): Promise<
  readonly {
    readonly walk: AccountWalk
    readonly entry: ProviderRecipe
    readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[]
> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(and(isNotNull(accountWalks.finishedAt), eq(accountWalks.outcome, 'proved')))
    .orderBy(desc(accountWalks.finishedAt))
    .limit(limit * 4)

  const out: {
    walk: AccountWalk
    entry: ProviderRecipe
    verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[] = []

  for (const row of rows) {
    if (out.length >= limit) break

    const steps = await db
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, row.id))
      .orderBy(asc(accountWalkSteps.position))

    const walk = toWalk(row, steps)
    const entry = await providerRecipe(db, walk.kind, walk.provider)
    if (entry === undefined) continue

    const verdict = walkVerdict(walk, entry)
    if (verdict.kind === 'diverges') out.push({ walk, entry, verdict })
  }

  return out
}

/**
 * Providers this citizen proved in the run it is still in, and has not written
 * up (`#907`).
 *
 * ## Why the boundary is the session and not the wake-up window
 *
 * **A walk is answerable only while the agent still has it in front of it.** The
 * digest's own window runs from the previous session's start, because that is
 * where *news* happened; asking for a walk against that window would put the ask
 * in front of an agent whose memory of the signup ended when the last run did.
 * What comes back then is not a walk — it is a plausible reconstruction, which
 * is the one thing the catalogue must not be filled with.
 *
 * So the ask is offered once more inside the run that earned it and is then
 * dropped. `currentSessionStartSql` is the boundary that says so, and a citizen
 * that has named no session gets nothing here rather than a guess.
 *
 * ## What counts as written up
 *
 * A finished walk with any answer, on `walkIsReported`'s rule — except that a
 * `proved` outcome does **not** clear it here, and that is the difference worth
 * stating. `walkIsReported` answers *may this citizen retry*, and a citizen that
 * got through is never held up. This answers *is there anything left to ask
 * for*, and a citizen that got through and said nothing about how is exactly the
 * one worth asking.
 */
export async function walksToAskAbout(
  db: Database,
  agentId: AgentId,
): Promise<readonly { readonly kind: string; readonly provider: string }[]> {
  const rows = await db.execute<{ kind: string; provider: string }>(sql`
    select a.kind, a.provider
      from accounts a
     where a.agent_id = ${agentId}
       and a.proved
       and a.provider is not null
       and a.proved_at >= ${currentSessionStartSql(agentId)}
       and not exists (
         select 1 from account_walks w
          where w.agent_id = a.agent_id
            and w.kind = a.kind
            and w.provider = a.provider
            and w.finished_at is not null
            and (coalesce(w.did, '') <> ''
              or coalesce(w.broke, '') <> ''
              or coalesce(w.changed, '') <> ''
              or coalesce(w.discarded, '') <> ''
              or coalesce(w.note, '') <> '')
       )
     order by a.proved_at desc
  `)

  return [...rows]
}

/** One refused walk, as the console lists it under its author (`#1097`, 7). */
export interface RefusedWalk {
  readonly walkId: string
  readonly kind: string
  readonly provider: string
  /** Null on a walk that was refused before it was closed. */
  readonly finishedAt: string | null
  /**
   * Why the stage refused it, in the Colony's own sentence (`#1340`).
   *
   * **This is the moderator speaking, not the citizen**, which is why it may be
   * printed where the refused prose may not. `null` on every walk refused
   * before the column existed — nothing was backfilled, so an old row says
   * nothing rather than guessing.
   */
  readonly reason: string | null
}

/** One citizen's refusals, and where that has left it (`#1097` decision 7). */
export interface WalkRefusalTally {
  readonly agentId: string
  readonly name: string
  readonly status: string
  /** All-time, which is the ordering and no longer the rule (`#1339`). */
  readonly refusals: number
  /** Decided walks the rule can currently see, at most {@link WALK_PROSE_WINDOW}. */
  readonly decidedInWindow: number
  /** How many of those were refused — the numerator the rule actually reads. */
  readonly refusedInWindow: number
  /** Newest first, bounded by {@link REFUSED_WALKS_PER_CITIZEN}. */
  readonly walks: readonly RefusedWalk[]
}

/**
 * How many citizens one page of {@link walkRefusalTallies} names, and how many
 * of each one's refusals it prints.
 *
 * **Bounded because the page has no filter and no search.** A maintainer opening
 * `/backend/refusals` is asking *who is doing this*, and the answer is the top of
 * an ordering — a citizen with one refusal is not a case anybody is looking for,
 * and a page that grew with the table would eventually be a page nobody opens.
 */
export const REFUSAL_TALLY_CITIZENS = 50
export const REFUSED_WALKS_PER_CITIZEN = 20

/**
 * Every citizen with a refused walk, worst first, with what was refused
 * (`#1097` decision 7).
 *
 * ## What the maintainer is actually being shown
 *
 * The rule this page exists for is automatic and writes no audit row, for the
 * reason `suspendForRefusedWalkProse` gives: an automatic suspension has no
 * actor, and an `authority_events` row with a null one would be a record
 * claiming somebody acted. **The refusals are the audit trail** — they are rows
 * already, they are what the rule counted, and this is the query that reads them
 * back in the same order the rule sees them.
 *
 * **The page shows two numbers because the rule reads one of them** (`#1339`).
 * `refusals` is all-time and is what orders the table — it is the question *who
 * is doing this*, and a citizen that was refused forty times is worth looking at
 * whenever it happened. The window beside it is the predicate the suspension
 * actually evaluates: refusals among the last {@link WALK_PROSE_WINDOW} decided
 * walks, floored on the citizen's newest lift. A page that printed only the
 * lifetime count would be a page that disagrees with the rule it exists to
 * explain — a walker suspended on nine of its last twenty and a reformed one
 * sitting on nine from a bad week last year read identically.
 *
 * ## The prose is not here, and cannot be
 *
 * The columns are the walk's `kind`, `provider`, `finished_at` and — since
 * `#1340` — the moderator's `prose_refusal_reason`. **A refused walk has no
 * scrub**, so there is nothing moderated to print, and the raw columns are
 * exactly what the red line was drawn against — the page says *what was
 * refused*, *why the Colony refused it*, and never *what it said*. The reason
 * is the Colony's own sentence about the walk, which is the whole of why it may
 * be shown where the walk's words may not. A maintainer who needs the words has
 * `psql`, which is a deliberate step and not a link.
 *
 * ## Three queries, all bounded
 *
 * The tally, then the walks belonging to the citizens it named, then each of
 * those citizens' windows. One query with a join would multiply the citizen row
 * by its walks and make the limit mean neither thing, and the window is a
 * per-citizen `limit` that cannot be expressed in the same `group by` at all.
 */
export async function walkRefusalTallies(
  db: Database,
  limit = REFUSAL_TALLY_CITIZENS,
): Promise<readonly WalkRefusalTally[]> {
  const refused = eq(accountWalks.proseStatus, 'rejected')

  const tallies = await db
    .select({
      agentId: accountWalks.agentId,
      name: agents.name,
      status: agents.status,
      refusals: sql<number>`cast(count(*) as integer)`,
    })
    .from(accountWalks)
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .where(refused)
    .groupBy(accountWalks.agentId, agents.name, agents.status)
    /** The count first, then the name, so two citizens on four never swap places. */
    .orderBy(desc(sql`count(*)`), asc(agents.name))
    .limit(limit)

  if (tallies.length === 0) return []

  const walks = await db
    .select({
      id: accountWalks.id,
      agentId: accountWalks.agentId,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      finishedAt: accountWalks.finishedAt,
      reason: accountWalks.proseRefusalReason,
    })
    .from(accountWalks)
    .where(
      and(
        refused,
        inArray(
          accountWalks.agentId,
          tallies.map((tally) => tally.agentId),
        ),
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))

  /**
   * What the suspension rule would see right now, per citizen: the last
   * {@link WALK_PROSE_WINDOW} decided walks since that citizen's newest lift.
   * The `limit` is per row, so it is a lateral and not a `group by`.
   */
  const windows = [
    ...(await db.execute<{ agent_id: string; decided: number; refused: number }>(sql`
    select a.id as agent_id,
           coalesce(w.decided, 0)::integer as decided,
           coalesce(w.refused, 0)::integer as refused
      from ${agents} a
      left join lateral (
        select count(*) as decided,
               count(*) filter (where r.prose_status = 'rejected') as refused
          from (
            select aw.prose_status
              from ${accountWalks} aw
             where aw.agent_id = a.id
               and aw.finished_at is not null
               and aw.prose_status <> 'pending'
               and aw.finished_at > coalesce(
                     (select max(l.lifted_at) from ${walkProseLifts} l where l.agent_id = a.id),
                     '-infinity'::timestamptz)
             order by aw.finished_at desc, aw.id desc
             limit ${WALK_PROSE_WINDOW}
          ) r
      ) w on true
     where a.id in (${sql.join(
       tallies.map((tally) => sql`${tally.agentId}`),
       sql`, `,
     )})
  `)),
  ]

  const byAgent = new Map(windows.map((row) => [row.agent_id, row]))

  return tallies.map((tally) => ({
    agentId: tally.agentId,
    name: tally.name,
    status: tally.status,
    refusals: tally.refusals,
    decidedInWindow: byAgent.get(tally.agentId)?.decided ?? 0,
    refusedInWindow: byAgent.get(tally.agentId)?.refused ?? 0,
    walks: walks
      .filter((walk) => walk.agentId === tally.agentId)
      .slice(0, REFUSED_WALKS_PER_CITIZEN)
      .map((walk) => ({
        walkId: walk.id,
        kind: walk.kind,
        provider: walk.provider,
        finishedAt: walk.finishedAt === null ? null : toTimestamp(walk.finishedAt),
        reason: walk.reason,
      })),
  }))
}
