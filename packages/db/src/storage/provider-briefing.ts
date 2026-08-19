import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  CURRENT_PROVIDER_CLAIM_WALKS,
  ProviderBriefingSchema,
  RECENT_WALKS_IN_CONTEXT,
  ServedProviderBriefingClaimSchema,
  descriptionFromWalkerAbout,
  firstWalkerAbout,
  now as currentTime,
  figureKey,
  isCurrentProviderClaim,
  walkProseText,
  type AccountKind,
  type AgentPlatform,
  type ProviderBriefing,
  type ProviderBriefingClaim,
  type WalkOutcome,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWalks, providerBriefings, providerRecipes } from '../schema/index.js'
import { moderatedWalkProse } from './account-walks.js'
import { canonicalProvider } from './atlas-renames.js'
import { toTimestamp } from './rows.js'

/** Which provider a briefing is about. The whole identity of one, and its key. */
export interface ProviderKey {
  readonly kind: AccountKind
  readonly provider: string
}

/**
 * Everything the synthesis needs about one walk, and nothing about its walker.
 *
 * **No `agentId`, for `BriefingSource`'s reason.** The synthesis writes text that
 * is published, so the less it is handed about who wrote what, the fewer ways
 * there are for that to reach the page. What it needs is the account of the walk
 * and the shape of the evidence: what happened, on which runtime, how recently.
 */
export interface ProviderBriefingSource {
  /** The walk's id, which is what a claim names in `sources`. */
  readonly id: string
  /**
   * How the walk ended.
   *
   * The provider analogue of `BriefingSource.kind`, and it does the same job in
   * the prompt: advice from a walker that got an account is a route, and the same
   * sentence from one that gave up is a wall with a route-shaped guess in it.
   *
   * **It is on the source and not on the claim.** The three sections already say
   * wall, route or unsolved, so a claim carrying an outcome as well would be
   * carrying the same fact in a second vocabulary that could disagree with the
   * first.
   */
  readonly outcome: WalkOutcome
  /**
   * The walker's own scrubbed words, as questions and answers.
   *
   * Read by the synthesis model and by nothing that serves a reader — which is
   * the whole of `#810`'s arrangement: the scrub is what makes these words
   * readable at all, and the briefing is what a reader gets instead of them.
   */
  readonly content: string
  /**
   * The scrubbed answer to “what is this provider?”, when the walker gave one
   * (`#1297`). Carried beside `content` so description synthesis can fall back
   * to it without parsing the Q&A page.
   */
  readonly about: string | null
  readonly platform: AgentPlatform
  /** When the walk finished. The claim's `lastSupportedAt` is the newest of these. */
  readonly finishedAt: string
}

/**
 * The whole moderated corpus of one provider (`#831`).
 *
 * A thin pass over {@link moderatedWalkProse}, which already applies every rule
 * that matters here — the scrubbed column and never the six raw ones, finished
 * walks only, newest first, and the rename resolved before anything is matched.
 * What this adds is the shape the synthesis reads and the bound it reads it
 * under.
 *
 * **Newest first and bounded**, where the task corpus is most-confirmed first: a
 * walk carries no confirmation count, because a walk is one agent walking once
 * and nothing merges two of them. Recency is the only ordering the evidence
 * supports, and it is the right one for a corpus that decays — a signup wall from
 * March is evidence about March.
 *
 * **Repeats are left out here and nowhere else** (`#1109`). `synthesiseProvider()`
 * drops any claim naming no source, so the number of sources behind a claim is
 * what it has instead of a confidence: ten citizens filing one paragraph about
 * one wall would become ten sources and read as the best-evidenced thing the
 * Colony knows about that provider. The reader keeps serving those walks — they
 * were published, and a marked repeat says more to a reader than a missing one —
 * and this is where the double-counting actually happened.
 */
export async function providerBriefingCorpus(
  db: Database,
  where: ProviderKey,
): Promise<readonly ProviderBriefingSource[]> {
  const walks = await moderatedWalkProse(
    db,
    { ...where, withoutDuplicates: true },
    RECENT_WALKS_IN_CONTEXT,
  )

  return walks.map((walk) => ({
    id: walk.walkId,
    outcome: walk.outcome,
    content: walkProseText(walk.prose),
    about: walk.prose.about ?? null,
    platform: walk.platform,
    finishedAt: walk.finishedAt,
  }))
}

/**
 * Mark a provider's briefing as out of date.
 *
 * `markBriefingStale`'s contract, provider-keyed: called where the readable
 * corpus **could** have moved rather than where it definitely did, because a
 * redundant synthesis costs one model call and a missed one leaves a citizen
 * attempting a provider on the strength of a wall that has since been removed.
 *
 * The upsert is what lets a provider with no briefing yet be marked — the row
 * comes into existence here, empty and dirty, before anything has been written.
 *
 * **The provider is canonicalised first**, which nothing else in this file has to
 * repeat: a rename must not produce a second queue entry under the old name that
 * no reader will ever look at.
 */
export async function markProviderBriefingStale(
  db: Database | Transaction,
  where: ProviderKey,
): Promise<void> {
  const provider = await canonicalProvider(db, where.provider)
  const at = new Date().toISOString()

  await db
    .insert(providerBriefings)
    .values({ kind: where.kind, provider, updatedAt: at })
    .onConflictDoUpdate({
      target: [providerBriefings.kind, providerBriefings.provider],
      set: { dirty: true, updatedAt: at },
    })
}

/**
 * The providers whose briefings need rewriting, oldest first.
 *
 * Bounded by a batch size for `staleBriefings`' reason: this spends money per
 * row, and one tick that found two hundred stale providers would spend two
 * hundred syntheses in a burst.
 */
export async function staleProviderBriefings(
  db: Database,
  limit: number,
): Promise<readonly ProviderKey[]> {
  const rows = await db
    .select({ kind: providerBriefings.kind, provider: providerBriefings.provider })
    .from(providerBriefings)
    .where(eq(providerBriefings.dirty, true))
    .orderBy(asc(providerBriefings.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    kind: AccountKindSchema.parse(row.kind),
    provider: AccountProviderSchema.parse(row.provider),
  }))
}

/**
 * Store a freshly written provider briefing and clear the flag.
 *
 * The two decisions here are `writeBriefing`'s and are made the same way.
 *
 * **No claims, no row** (`#611`). A briefing with nothing in it makes an offer
 * that cannot be met, and it hides the gap — a row per provider reads as coverage
 * where *these eleven have something to say* is the truer picture. Deleted rather
 * than written and hidden, because a row kept for bookkeeping needs every
 * reader-facing surface to remember to skip it. The flag goes with the row, which
 * is what stops the rewrite loop: the next approved walk recreates it.
 *
 * **The flag is cleared unconditionally**, so a walk approved while a synthesis
 * was in flight waits for the next change rather than the next tick. A briefing
 * is allowed to be one walk behind; it is not allowed to be wrong about the walks
 * it names, and it never is, because the counts come from the walks it was
 * written from.
 */
export async function writeProviderBriefing(
  db: Database,
  input: {
    readonly kind: AccountKind
    readonly provider: string
    readonly claims: readonly ProviderBriefingClaim[]
    readonly model: string
  },
): Promise<void> {
  const provider = await canonicalProvider(db, input.provider)
  const isThisProvider = and(
    eq(providerBriefings.kind, input.kind),
    eq(providerBriefings.provider, provider),
  )

  if (input.claims.length === 0) {
    await db.delete(providerBriefings).where(isThisProvider)
    return
  }

  const at = new Date().toISOString()
  const written = {
    claims: [...input.claims],
    model: input.model,
    writtenAt: at,
    dirty: false,
    updatedAt: at,
  }

  await db
    .insert(providerBriefings)
    .values({ kind: input.kind, provider, ...written })
    .onConflictDoUpdate({
      target: [providerBriefings.kind, providerBriefings.provider],
      set: written,
    })
}

/**
 * One provider's briefing, or nothing.
 *
 * **Serves a stale briefing without complaint**, which is the degradation
 * contract `provider-briefing.ts` states in core: with the synthesis down a
 * reader gets the last good briefing with its age visible, never an error and
 * never a fallback to the walk prose behind it. A row marked dirty but never
 * written answers `undefined` — *not written up yet* is a different answer from
 * an empty one, and neither is an error.
 */
export async function readProviderBriefing(
  db: Database,
  where: ProviderKey,
): Promise<ProviderBriefing | undefined> {
  const provider = await canonicalProvider(db, where.provider)

  const [row] = await db
    .select({
      kind: providerBriefings.kind,
      provider: providerBriefings.provider,
      claims: providerBriefings.claims,
      model: providerBriefings.model,
      writtenAt: providerBriefings.writtenAt,
    })
    .from(providerBriefings)
    .where(and(eq(providerBriefings.kind, where.kind), eq(providerBriefings.provider, provider)))
    .limit(1)

  if (row === undefined || row.writtenAt === null || row.model === null) return undefined

  /**
   * Which claims still stand in the foreground.
   *
   * **Computed on read, not stored**, for `readBriefing`'s reason: whether a
   * claim is current is a fact about how much has happened since it was last
   * confirmed, and that changes with every walk that finishes. One extra query
   * per briefing read is the honest price.
   */
  const window = {
    oldestCurrentWalk: await oldestCurrentWalk(db, { kind: where.kind, provider }),
    now: currentTime(),
  }

  /**
   * **A stored claim that no longer validates costs that claim, never the
   * provider** (`#729`). The failure direction the task side had to learn the
   * hard way: a briefing is guidance, and a reader losing one sentence of it is
   * incomparably better than losing the whole Atlas entry it hangs off. So each
   * claim is validated on its own and one that fails is dropped rather than
   * thrown on — silently, because this package logs nowhere and the loud half
   * belongs where the unservable claim is written.
   */
  const claims = row.claims
    .map((claim) =>
      ServedProviderBriefingClaimSchema.safeParse({
        ...claim,
        current: isCurrentProviderClaim(claim, window),
      }),
    )
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)

  return ProviderBriefingSchema.parse({
    kind: row.kind,
    provider: row.provider,
    claims,
    model: row.model,
    writtenAt: toTimestamp(row.writtenAt),
  })
}

/**
 * Every briefing at one provider, by `figureKey(kind, provider)`.
 *
 * **The shape an Atlas entry reads**, and keyed the way its figures already are
 * so a surface holding both looks them up the same way. An entry is a provider
 * and its rows are its kinds, so this answers all of them in one call.
 *
 * **Read on an entry and never on the catalogue.** `atlasQuests.naming` took the
 * same decision for the same reason: the index shows no briefing, and a read
 * that walked four hundred providers to render none of them is a cost paid on
 * the page that does not spend it.
 *
 * One query for the kinds and then {@link readProviderBriefing} per kind — an
 * entry has one to three rows, and the alternative is a second copy of the
 * currency rule that can disagree with the first.
 */
export async function providerBriefingsAt(
  db: Database,
  provider: string,
): Promise<ReadonlyMap<string, ProviderBriefing>> {
  const canonical = await canonicalProvider(db, provider)

  const rows = await db
    .select({ kind: providerBriefings.kind })
    .from(providerBriefings)
    .where(and(eq(providerBriefings.provider, canonical), isNotNull(providerBriefings.writtenAt)))

  const briefings = await Promise.all(
    rows.map(async (row) =>
      readProviderBriefing(db, {
        kind: AccountKindSchema.parse(row.kind),
        provider: canonical,
      }),
    ),
  )

  return new Map(
    briefings
      .filter((briefing) => briefing !== undefined)
      .map((briefing) => [figureKey(briefing.kind, briefing.provider), briefing]),
  )
}

/**
 * When the oldest walk still inside the recency window finished, or `null`.
 *
 * `null` means the provider has had fewer than {@link CURRENT_PROVIDER_CLAIM_WALKS}
 * finished walks, so nothing has been pushed out of the window and every claim is
 * inside it by definition.
 *
 * `offset` rather than a count per claim: one query answers the bound for every
 * claim at once, and the bound is a property of the provider rather than of any
 * claim.
 *
 * **Every finished walk counts, moderated or not.** The bound measures how much
 * has happened at this provider since a claim was last confirmed, and a walk
 * whose words were refused still happened. Counting only the servable ones would
 * make a provider look quieter than it is and hold demotion off for claims the
 * world has moved past.
 *
 * The provider reaching here is already canonical — both callers resolve it — so
 * this does not resolve it again.
 */
async function oldestCurrentWalk(db: Database, where: ProviderKey): Promise<string | null> {
  const [row] = await db
    .select({ finishedAt: accountWalks.finishedAt })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, where.provider),
        isNotNull(accountWalks.finishedAt),
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .offset(CURRENT_PROVIDER_CLAIM_WALKS - 1)
    .limit(1)

  return row?.finishedAt == null ? null : toTimestamp(row.finishedAt)
}

/**
 * Wire an approved walker `about` onto the entry's identity columns (`#1297`).
 *
 * **Fills gaps only.** An existing curator `about` and a synthesised
 * `description` win; this closes the aggregation gap where walks already carry
 * about and the measured entry still reads as content-empty on public/MCP
 * surfaces.
 *
 * **Description is dropped when over-length, never truncated** (`#1120`). The
 * about column still receives the sentence up to its own bound.
 *
 * Returns which columns this call actually wrote.
 */
export async function promoteWalkerAboutToEntryIdentity(
  db: Database | Transaction,
  input: {
    readonly kind: AccountKind
    readonly provider: string
    readonly about: string
  },
): Promise<{ readonly about: boolean; readonly description: boolean }> {
  const about = firstWalkerAbout([input.about])
  if (about === null) return { about: false, description: false }

  const provider = await canonicalProvider(db, input.provider)
  const [row] = await db
    .select({
      about: providerRecipes.about,
      description: providerRecipes.description,
    })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.kind, input.kind), eq(providerRecipes.provider, provider)))
    .limit(1)

  if (row === undefined) return { about: false, description: false }

  const fillAbout = row.about === null || row.about.trim() === ''
  const fillDescription =
    (row.description === null || row.description.trim() === '') &&
    descriptionFromWalkerAbout([about]) !== null
  const description = fillDescription ? descriptionFromWalkerAbout([about]) : null

  if (!fillAbout && description === null) return { about: false, description: false }

  await db
    .update(providerRecipes)
    .set({
      ...(fillAbout ? { about } : {}),
      ...(description !== null ? { description } : {}),
    })
    .where(and(eq(providerRecipes.kind, input.kind), eq(providerRecipes.provider, provider)))

  return { about: fillAbout, description: description !== null }
}

/**
 * Write the Colony's one sentence about a provider onto its entry (`#1120`).
 *
 * **A separate call from {@link writeProviderBriefing}, and that is the whole
 * design.** A synthesis that produces no claims deletes the briefing row
 * (`#611`); a description folded into that write would be deleted with it, and a
 * provider whose walls happen to be unquotable this week would lose the sentence
 * saying what it *is* — which has nothing to do with its walls. The two writes
 * are independent because the two facts are.
 *
 * **An update and never an insert.** The key is `(kind, provider)` on
 * `provider_recipes`, so a provider with no entry row gets nothing rather than a
 * row with a description and no recipe in it: the description describes an entry,
 * and an entry nobody has written is not one to describe.
 *
 * **`null` clears it**, which is what an empty corpus asks for.
 */
export async function writeProviderDescription(
  db: Database,
  input: {
    readonly kind: AccountKind
    readonly provider: string
    readonly description: string | null
  },
): Promise<boolean> {
  const provider = await canonicalProvider(db, input.provider)

  const updated = await db
    .update(providerRecipes)
    .set({ description: input.description })
    .where(and(eq(providerRecipes.kind, input.kind), eq(providerRecipes.provider, provider)))
    .returning({ id: providerRecipes.id })

  return updated.length > 0
}

/** What the Colony last wrote about a provider, or nothing where it never has. */
export async function readProviderDescription(
  db: Database,
  where: ProviderKey,
): Promise<string | null> {
  const provider = await canonicalProvider(db, where.provider)

  const [row] = await db
    .select({ description: providerRecipes.description })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.kind, where.kind), eq(providerRecipes.provider, provider)))
    .limit(1)

  return row?.description ?? null
}

/**
 * How many providers have a briefing, and how many are waiting on one.
 *
 * The one figure `#611` says an empty-row policy has to keep answerable: with a
 * row deleted rather than emptied, *how many providers has the Colony written up*
 * is no longer the row count of anything, and a reader of the moderation health
 * page would otherwise have to infer it.
 */
export async function providerBriefingCounts(
  db: Database,
): Promise<{ readonly written: number; readonly stale: number }> {
  const [row] = await db
    .select({
      written: sql<number>`count(*) filter (where ${providerBriefings.writtenAt} is not null)::int`,
      stale: sql<number>`count(*) filter (where ${providerBriefings.dirty})::int`,
    })
    .from(providerBriefings)

  return { written: Number(row?.written ?? 0), stale: Number(row?.stale ?? 0) }
}
