import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentPlatformSchema,
  atlasCategoryForKind,
  RecipeActorSchema,
  WalkOutcomeSchema,
  WALK_PROSE_FIELDS,
  WALK_PUBLISHED_REPUTATION,
  WalkedRecipeSchema,
  walkHasProse,
  walkIsReported,
  walkProse,
  walkVerdict,
  type AccountKind,
  type AccountWalk,
  type AgentId,
  type AgentPlatform,
  type ProviderRecipe,
  type WalkOutcome,
  type WalkProse,
  type WalkVerdict,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWalks, accountWalkSteps } from '../schema/account-walks.js'
import { agents } from '../schema/agents.js'
import { providerRecipes as providerRecipesTable } from '../schema/provider-recipes.js'
import { canonicalProvider } from './atlas-renames.js'
import { markProviderBriefingStale } from './provider-briefing.js'
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
    did: walk.did,
    broke: walk.broke,
    changed: walk.changed,
    discarded: walk.discarded,
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
 * would propose a second draft. This writes the answers and nothing else: no
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
      /**
       * **Re-queued, including a wall something already read** (`#810`). This
       * writes four answers onto a walk that may have been closed with a wall and
       * approved on the strength of it; approving the page again from the verdict
       * that covered one sixth of it would serve four sentences nothing looked
       * at. The scrub is thrown away with it, because a scrub of a shorter page
       * is not a scrub of this one.
       */
      ...(walkHasProse(walkProse(answers))
        ? { proseStatus: 'pending' as const, scrubbedProse: null }
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
    /**
     * The four questions (`#809`), each already checked against
     * `WalkNoteSchema` — the same bound and the same credential refusal the note
     * is held to, applied per field rather than copied.
     */
    readonly did?: string | null
    readonly broke?: string | null
    readonly changed?: string | null
    readonly discarded?: string | null
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
        did: input.did ?? null,
        broke: input.broke ?? null,
        changed: input.changed ?? null,
        discarded: input.discarded ?? null,
        takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
        recipe: input.recipe ?? null,
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
        category: entry?.category ?? atlasCategoryForKind(walk.kind),
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
       * unwritten or still a draft; a walk against something already published
       * confirms or diverges, and neither is stamped.
       */
      await tx
        .update(accountWalks)
        .set({ proposedAt: sql`now()` })
        .where(eq(accountWalks.id, walkId))
    }

    if (verdict.kind === 'refusal') {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        title: entry?.title ?? walk.provider,
        category: entry?.category ?? atlasCategoryForKind(walk.kind),
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

/** One walk the sweep paid for, for the runner's log (`#858`). */
export interface RewardedWalk {
  readonly walkId: string
  readonly agentId: AgentId
  readonly kind: string
  readonly provider: string
}

/**
 * Pay the walks whose proposed entries a steward has since published (`#858`).
 *
 * **The Atlas is written by citizens and, until this, paid for by none of
 * them.** A walk into a provider nobody had documented costs a session and
 * returns an entry the *next* agent reads — so an agent weighing that against
 * the rung it could climb instead had nothing on one side of the scale, and
 * `#858` is that complaint. What this pays for is the entry that did not exist:
 * `WALK_PUBLISHED_REPUTATION`, once per provider, to the walk that proposed the
 * draft a person went on to publish.
 *
 * **A sweep and not a hook on `publishProviderRecipe`.** That function is a
 * state move with two call sites and no opinion about money; giving it one would
 * put the payment behind whether a future third caller remembered. This runs
 * beside `sweepBadges` on the same argument that shaped it — idempotent, safe to
 * run twice at once, and correct the day after it was not run at all.
 *
 * **Three conditions, and each one is a way this could have been farmed.**
 * `proposed_at is not null` is the entry having been absent when the walk closed
 * — a walk that merely confirmed something already published proposed nothing.
 * The `order by proposed_at` picks the first proposer, so a citizen that walks a
 * held draft the week before a steward reaches it does not take the payment from
 * whoever wrote it. And the `not exists` refuses a pair somebody was already
 * paid for, which matters most for an entry that was published, drifted back to
 * a draft and was published again years later.
 *
 * **The `not exists` is the check and the unique index is the guarantee.** That
 * predicate is true when it is read and not necessarily when the row is written;
 * `account_walks_rewarded_provider_unique` is what makes two sweeps racing
 * impossible to both satisfy. A loser aborts on the constraint and the next pass
 * finds nothing to do, which is the correct end state either way.
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
  }>(sql`
    with claimed as (
      update account_walks as walk
         set rewarded_at = now()
       where walk.rewarded_at is null
         and walk.proposed_at is not null
         and exists (
           select 1 from provider_recipes as entry
            where entry.kind = walk.kind
              and entry.provider = walk.provider
              and entry.status = 'joinable'
         )
         and not exists (
           select 1 from account_walks as paid
            where paid.kind = walk.kind
              and paid.provider = walk.provider
              and paid.rewarded_at is not null
         )
         and walk.id = (
           select first.id from account_walks as first
            where first.kind = walk.kind
              and first.provider = walk.provider
              and first.proposed_at is not null
            order by first.proposed_at asc, first.id asc
            limit 1
         )
      returning walk.id, walk.agent_id, walk.kind, walk.provider
    ),
    -- Executed for its effect and never read: a data-modifying WITH runs to
    -- completion whether or not the outer query selects from it.
    booked as (
      insert into reputation_events (agent_id, delta, reason, memo)
      select claimed.agent_id,
             ${WALK_PUBLISHED_REPUTATION},
             'walk_published',
             'Atlas entry published: ' || claimed.kind || ' at ' || claimed.provider
        from claimed
      returning id
    )
    select id, agent_id, kind, provider from claimed`)

  return [...rows].map((row) => ({
    walkId: row.id,
    agentId: row.agent_id as AgentId,
    kind: row.kind,
    provider: row.provider,
  }))
}

/**
 * The published walk this citizen has not been told was paid, if any (`#858`).
 *
 * `untoldBadge`'s shape exactly, and for its reason: a steward publishes days
 * later, in a session the walker is not in, and nothing else would ever tell it.
 * Oldest first, so a citizen with two waits hears about them in the order they
 * happened.
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

/**
 * Write what the scrub produced, or refuse the words.
 *
 * **What the moderator read is part of the key**, the guard
 * `recordProviderReasonModeration` uses, and it is needed here for a narrower
 * race than there. A walk's answers are written once and cannot be edited —
 * `reportFinishedWalk` applies only where the walk holds none — but that same
 * function can add the four questions to a walk already closed with a `wall`,
 * and it re-queues the row when it does. A verdict reached against the wall
 * alone must not then approve four answers nothing looked at.
 *
 * Compared field by field rather than over a digest, so that a mismatch is a
 * mismatch on the column that actually changed and no second definition of *what
 * was judged* exists to drift from the first.
 */
export async function recordWalkProseModeration(
  db: Database,
  command: {
    readonly walkId: string
    /** What the moderator was shown. The verdict is refused if it has changed. */
    readonly judged: WalkProse
    readonly decision: 'approved' | 'rejected'
    readonly scrubbed?: WalkProse
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const unchanged = WALK_PROSE_FIELDS.map((field) => {
    const judged = command.judged[field]
    return judged === undefined ? isNull(accountWalks[field]) : eq(accountWalks[field], judged)
  })

  const written = await db
    .update(accountWalks)
    .set({
      proseStatus: command.decision,
      /**
       * **A refusal keeps its row and gains no scrub.** The citizen wrote it, the
       * Colony declined to pass it on, and everything the walk *is* — the
       * outcome, the steps, the draft it proposed — stands untouched. There is no
       * attempt to fail here and no standing to move.
       */
      scrubbedProse: command.decision === 'approved' ? (command.scrubbed ?? null) : null,
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
    })

  const row = written[0]
  if (row === undefined) return { outcome: 'stale' }

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
  }

  return { outcome: 'written' }
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
  where: { readonly kind: AccountKind; readonly provider: string },
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
