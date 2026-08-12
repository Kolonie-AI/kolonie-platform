import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  RecipeActorSchema,
  WalkOutcomeSchema,
  WalkedRecipeSchema,
  walkVerdict,
  type AccountKind,
  type AccountWalk,
  type AgentId,
  type ProviderRecipe,
  type WalkOutcome,
  type WalkVerdict,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks, accountWalkSteps } from '../schema/account-walks.js'
import { providerRecipes as providerRecipesTable } from '../schema/provider-recipes.js'
import { canonicalProvider } from './atlas-renames.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
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
    wall: walk.wall,
    note: walk.note,
    takenStepPositions: walk.takenStepPositions,
    /** Parsed on the way out, like every other `jsonb` here: the column is not a shape. */
    recipe: walk.recipe === null ? null : WalkedRecipeSchema.parse(walk.recipe),
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
        eq(accountWalks.kind, input.kind),
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
   * **Read before write, and the read is its own function** (`#601`). Reporting
   * a walk has to be able to ask *is one open* without opening one — an agent
   * that reports a walk it never started must be told so, not handed an empty
   * record it just created.
   */
  const existing = await openWalkId(db, agentId, input)
  if (existing !== undefined) return existing

  const [row] = await db
    .insert(accountWalks)
    .values({ agentId, kind: input.kind, provider })
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
 * Close a walk and do to the catalogue whatever the walk earns.
 *
 * **One function, in one transaction, because the two halves must not be able
 * to disagree.** A walk marked `proved` whose draft was not written is a record
 * saying a recipe exists where none does; a draft written from a walk that was
 * never closed is a recipe derived from a path that may still be running.
 *
 * **What happens is `walkVerdict`'s decision and not this function's.** The
 * table of outcomes lives in `packages/core/src/account/walk.ts` beside the
 * argument for each row; this applies it. A second implementation of *what does
 * a finished walk mean* is a second answer to it.
 *
 * **Nothing here reaches the public Atlas.** A draft is not public (`#604`) and
 * a divergence is returned for a steward rather than written over what somebody
 * published. `#600`'s rule is unchanged: what the Colony says about somebody
 * else's product passes a person.
 */
export async function finishWalk(
  db: Database,
  walkId: string,
  input: {
    readonly outcome: WalkOutcome
    /** Required when the outcome is `refused`, refused otherwise. */
    readonly wall?: string | null
    /** The answer to the one question, already checked against `WalkNoteSchema`. */
    readonly note?: string | null
    /** Published recipe positions checked by the agent, in order. */
    readonly takenStepPositions?: readonly number[] | null
    /** The walker's own long-form account of the path (`#769`), where it gave one. */
    readonly recipe?: WalkedRecipe | null
  },
): Promise<{ readonly walk: AccountWalk; readonly verdict: WalkVerdict } | undefined> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(accountWalks)
      .set({
        finishedAt: sql`now()`,
        outcome: input.outcome,
        wall: input.outcome === 'refused' ? (input.wall ?? null) : null,
        note: input.note ?? null,
        takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
        recipe: input.recipe ?? null,
      })
      .where(and(eq(accountWalks.id, walkId), isNull(accountWalks.finishedAt)))
      .returning()

    /**
     * **Already finished is not an error and writes nothing twice.** The
     * `is null` above is what makes closing a walk idempotent: a retried call,
     * or a proof arriving after a declaration already closed it, must not
     * propose a second draft.
     */
    if (closed === undefined) return undefined

    const steps = await tx
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, walkId))
      .orderBy(asc(accountWalkSteps.position))

    const walk = toWalk(closed, steps)
    const entry = await providerRecipe(tx, walk.kind, walk.provider)
    const verdict = walkVerdict(walk, entry)

    if (verdict.kind === 'draft') {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        /**
         * **The provider's own name and nothing invented.** A title is prose and
         * a steward writes it; until then the entry is called what it is. The
         * existing title is kept where there is one, so a walk against an entry
         * somebody already named does not rename it.
         */
        title: entry?.title ?? walk.provider,
        category: entry?.category ?? 'data-apis',
        status: 'draft',
        steps: verdict.steps,
        /**
         * **The walker's account travels with the entry it proposed** (`#769`).
         *
         * Without this the long form would sit on the walk row and a steward
         * reviewing the draft would be reading a shape with no words beside it —
         * which is the state the citizen who filed `#769` was already in, one
         * table along. `undefined` leaves whatever the entry had: a walk that
         * added nothing must not delete the last walker's account.
         */
        ...(walk.recipe === null ? {} : { walkedRecipe: walk.recipe }),
      })
    }

    if (verdict.kind === 'refusal') {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        title: entry?.title ?? walk.provider,
        category: entry?.category ?? 'data-apis',
        status: 'refused',
        refusal: verdict.wall,
        steps: [],
        /** A refusal's walls are the most useful account there is — see the draft above. */
        ...(walk.recipe === null ? {} : { walkedRecipe: walk.recipe }),
      })
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

    return { walk, verdict }
  })
}

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
