import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import {
  PLAYBOOK_RUN_REPUTATION,
  PlaybookDraftSchema,
  PlaybookRunReportSchema,
  PlaybookSlugSchema,
  PlaybookStatusSchema,
  type AgentId,
  type Playbook,
  type PlaybookDraft,
  type PlaybookRun,
  type PlaybookRunOutcome,
  type PlaybookRunReport,
  type PlaybookRunSignal,
  type PlaybookStatus,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { playbookRuns, playbooks } from '../schema/playbooks.js'

/**
 * Reading and writing playbooks (`#1173`).
 *
 * **The product rules are in `kolonie-docs#430`** — what a playbook is for, why
 * it is its own object rather than a quest variant, and what freeze A–I fixes.
 * This module is persistence and nothing else: no tool reaches it yet (`#1174`
 * and `#1179` are the read and the authoring surfaces), and it grants nothing.
 *
 * ## Where the credential scrub happens
 *
 * **At the write boundary and not at the read one**, which is why `createPlaybook`
 * parses rather than trusts. Every caller today hands it a value that already
 * came through `PlaybookDraftSchema`, and the one that will not is the seed
 * script, the backfill or the repair — the callers written in a hurry, against a
 * type, by somebody who has not read this file. Re-parsing costs a few
 * microseconds on a write nobody does in a loop; the alternative costs a title
 * carrying an API key, which is the one thing freeze I says must never be here.
 */

/** The whole row, as the domain type. */
function toPlaybook(row: typeof playbooks.$inferSelect): Playbook {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    status: row.status as PlaybookStatus,
    authorAgentId: row.authorAgentId,
    parentPlaybookId: row.parentPlaybookId,
    version: row.version,
    requiredAccounts: [...row.requiredAccounts],
    steps: [...row.steps],
    inspiration: [...row.inspiration],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  }
}

/** One run report row, as the domain type. */
function toPlaybookRun(row: typeof playbookRuns.$inferSelect): PlaybookRun {
  return {
    id: row.id,
    playbookId: row.playbookId,
    agentId: row.agentId,
    outcome: row.outcome as PlaybookRunOutcome,
    did: row.did,
    broke: row.broke,
    changed: row.changed,
    discarded: row.discarded,
    takenStepPositions: row.takenStepPositions ? [...row.takenStepPositions] : null,
    signals: [...row.signals] as PlaybookRunSignal[],
    rewardedAt: row.rewardedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** What `createPlaybook` needs beyond the author's own prose. */
export interface CreatePlaybookInput {
  readonly slug: string
  readonly authorAgentId: AgentId
  /** The playbook this one forks, or nothing. First-class, per freeze D. */
  readonly parentPlaybookId?: string | null
  /**
   * Where it starts.
   *
   * **Defaults to `draft`, and the default is the safe one.** A caller that
   * means to publish says so — the seed script in `#1175` does, because those
   * playbooks are the Colony's own and have already been reviewed. Nothing
   * written by a citizen arrives `open`; that is what `review` is for.
   */
  readonly status?: PlaybookStatus
  readonly draft: PlaybookDraft
}

/**
 * Write one playbook.
 *
 * The status vocabulary, the slug shape and the whole of the draft are parsed
 * here — see the note at the top of this module for why a second parse is worth
 * paying for. `published_at` is set exactly when the row arrives `open`, which is
 * what the `playbooks_open_is_published` constraint requires and what makes *when
 * did this reach the catalogue* answerable without a separate history table.
 */
export async function createPlaybook(db: Database, input: CreatePlaybookInput): Promise<Playbook> {
  const slug = PlaybookSlugSchema.parse(input.slug)
  const status = PlaybookStatusSchema.parse(input.status ?? 'draft')
  const draft = PlaybookDraftSchema.parse(input.draft)

  const [row] = await db
    .insert(playbooks)
    .values({
      slug,
      title: draft.title,
      summary: draft.summary,
      status,
      authorAgentId: input.authorAgentId,
      parentPlaybookId: input.parentPlaybookId ?? null,
      requiredAccounts: draft.requiredAccounts,
      steps: draft.steps,
      inspiration: draft.inspiration ?? [],
      publishedAt: status === 'open' ? new Date().toISOString() : null,
    })
    .returning()

  if (!row) throw new Error('playbook insert returned no row')
  return toPlaybook(row)
}

/** What `recordPlaybookRun` needs beyond the citizen's own prose. */
export interface RecordPlaybookRunInput {
  readonly playbookId: string
  readonly agentId: AgentId
  readonly report: PlaybookRunReport
}

/** The row, whether writing it replaced one, and what it was paid. */
export interface RecordedPlaybookRun {
  readonly run: PlaybookRun
  readonly replaced: boolean
  /**
   * Reputation granted by *this* write — `PLAYBOOK_RUN_REPUTATION` for a run
   * that had never been paid, and zero for every report after it.
   *
   * Zero is the ordinary answer for a replacement and says nothing went wrong:
   * `run.rewardedAt` is what answers *has this citizen been paid for this
   * playbook at all*, and it survives every rewrite.
   */
  readonly granted: number
}

/** One run the grant paid, as it now stands. */
export interface RewardedPlaybookRun {
  readonly runId: string
  readonly agentId: AgentId
  readonly playbookId: string
  readonly outcome: PlaybookRunOutcome
  readonly rewardedAt: string
}

/**
 * Pay for run reports that have not been paid for (`#1177`, freeze E).
 *
 * ## Once per citizen × playbook, and the index is what makes that true
 *
 * `playbook_runs_agent_playbook_key` means a citizen has at most one row per
 * playbook, so *once per row* and *once per citizen × playbook* are the same
 * sentence here — unlike walks, where a citizen may file many rows against one
 * provider and `rewardPublishedWalks` has to pick the first of them. The whole
 * of the rule is therefore `rewarded_at is null`, claimed by the `update` itself
 * rather than checked before it. Two concurrent calls race into the same row and
 * exactly one leaves with it.
 *
 * ## Inline, not a sweep — deliberately not mirroring walks
 *
 * `rewardPublishedWalks` is an hourly sweep because a walk cannot be paid when
 * it is filed: it waits on a moderation verdict that lands days later, in a
 * session its walker is not in. That is also why walks need `reward_told_at` and
 * a standing hint to tell the citizen afterwards. **A run report has no gate
 * before payment** — every honest outcome is eligible the moment it is written —
 * so this runs in `recordPlaybookRun`'s own transaction and the citizen is told
 * in the answer to the call it just made. No sweep, no telling machinery, no
 * window in which a citizen has been paid and does not know it.
 *
 * It still takes an optional `runId` rather than assuming one: called with
 * nothing it pays every unpaid row, which is what a backfill or a repair needs
 * and costs one `where` clause to keep available.
 *
 * ## One transaction covering the claim and what it paid
 *
 * `bookTaskReward`'s rule, and `rewardPublishedWalks` states it: a `rewarded_at`
 * with no reputation event behind it is a payment the citizen cannot see and
 * nothing will make again. The `booked` CTE is executed for its effect and never
 * read — a data-modifying `with` runs to completion whether or not the outer
 * query selects from it.
 */
export async function grantPlaybookRunReputation(
  db: Database | Transaction,
  runId?: string,
): Promise<readonly RewardedPlaybookRun[]> {
  const onlyThisRun = runId === undefined ? sql`` : sql` and run.id = ${runId}`

  const rows = await db.execute<{
    id: string
    agent_id: string
    playbook_id: string
    outcome: string
    rewarded_at: string
  }>(sql`
    with claimed as (
      update playbook_runs as run
         set rewarded_at = now()
       where run.rewarded_at is null${onlyThisRun}
      returning run.id, run.agent_id, run.playbook_id, run.outcome, run.rewarded_at
    ),
    -- Executed for its effect and never read: a data-modifying WITH runs to
    -- completion whether or not the outer query selects from it.
    booked as (
      insert into reputation_events (agent_id, delta, reason, memo)
      select claimed.agent_id,
             ${PLAYBOOK_RUN_REPUTATION},
             'playbook_run',
             'Playbook run reported (' || claimed.outcome || '): ' || book.slug
        from claimed
        join playbooks as book on book.id = claimed.playbook_id
      returning id
    )
    select id, agent_id, playbook_id, outcome, rewarded_at from claimed`)

  return [...rows].map((row) => ({
    runId: row.id,
    agentId: row.agent_id as AgentId,
    playbookId: row.playbook_id,
    outcome: row.outcome as PlaybookRunOutcome,
    rewardedAt: row.rewarded_at,
  }))
}

/**
 * Write one citizen's account of having run one playbook (`#1176`).
 *
 * ## Replace in place, always
 *
 * **An upsert on `playbook_runs_agent_playbook_key` and never an insert that
 * might fail**, which is the whole of the issue's *no run spam* rule and half of
 * its lifecycle: an unrewarded report is replaced by a later one, and a rewarded
 * report is replaced by a later one too. The recommendation the issue locks for
 * the implementer — *allow additional runs after reward without further rep;
 * first reward once per citizen × playbook* — falls out of that plus one line:
 * `rewarded_at` is **not** in the update set, so a report that has already been
 * paid for stays marked as paid and `#1177` never pays it again
 * (`kolonie-docs#430`, freeze E: *once per citizen × playbook*).
 *
 * The alternative — a row per run, and *rewarded once* enforced in a handler —
 * was rejected for the reason the unique index exists at all: under two
 * concurrent reports it is a race, and the only place the rule can be made true
 * is the database.
 *
 * ## The scrub
 *
 * `PlaybookRunReportSchema` is parsed here and not merely trusted, on the same
 * argument as `createPlaybook` above: the caller that has not read this file is
 * the one that will hand it a string straight from a transcript. Freeze I asks
 * for the walks' scrub, and this is where it runs.
 *
 * ## How it knows it replaced something
 *
 * `xmax = 0` in the `returning` clause, which is Postgres' own answer to *did
 * this upsert insert or update* — the system column is zero on a row this
 * statement created and carries the updating transaction otherwise. The
 * alternative, a `select` before the `insert`, is the race the unique index
 * exists to close, reintroduced one line above the thing that closes it.
 *
 * ## And what it is worth
 *
 * `#1177` pays here rather than in a sweep, in the same transaction as the
 * write — see `grantPlaybookRunReputation` for why that is not the shape walks
 * use. The report and its payment therefore commit together or not at all, and
 * the row this returns already carries the `rewarded_at` the grant set, so the
 * citizen learns what it earned from the answer to the call it just made.
 */
export async function recordPlaybookRun(
  db: Database,
  input: RecordPlaybookRunInput,
): Promise<RecordedPlaybookRun> {
  const report = PlaybookRunReportSchema.parse(input.report)
  const now = new Date().toISOString()

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(playbookRuns)
      .values({
        playbookId: input.playbookId,
        agentId: input.agentId,
        outcome: report.outcome,
        did: report.did,
        broke: report.broke ?? null,
        changed: report.changed ?? null,
        discarded: report.discarded ?? null,
        takenStepPositions: report.takenStepPositions ? [...report.takenStepPositions] : null,
        signals: report.signals ? [...report.signals] : [],
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [playbookRuns.agentId, playbookRuns.playbookId],
        set: {
          outcome: report.outcome,
          did: report.did,
          broke: report.broke ?? null,
          changed: report.changed ?? null,
          discarded: report.discarded ?? null,
          takenStepPositions: report.takenStepPositions ? [...report.takenStepPositions] : null,
          signals: report.signals ? [...report.signals] : [],
          updatedAt: now,
        },
      })
      .returning({ ...getTableColumns(playbookRuns), inserted: sql<boolean>`xmax = 0` })

    if (!row) throw new Error('playbook run upsert returned no row')

    const [paid] = await grantPlaybookRunReputation(tx, row.id)
    const run = toPlaybookRun(paid ? { ...row, rewardedAt: paid.rewardedAt } : row)

    return { run, replaced: !row.inserted, granted: paid ? PLAYBOOK_RUN_REPUTATION : 0 }
  })
}

/** One citizen's run of one playbook, or null. */
export async function playbookRunFor(
  db: Database,
  agentId: AgentId,
  playbookId: string,
): Promise<PlaybookRun | null> {
  const [row] = await db
    .select()
    .from(playbookRuns)
    .where(and(eq(playbookRuns.agentId, agentId), eq(playbookRuns.playbookId, playbookId)))
    .limit(1)
  return row ? toPlaybookRun(row) : null
}

/** One playbook by id, or null. */
export async function playbookById(db: Database, id: string): Promise<Playbook | null> {
  const [row] = await db.select().from(playbooks).where(eq(playbooks.id, id)).limit(1)
  return row ? toPlaybook(row) : null
}

/**
 * One playbook by its public name, or null.
 *
 * **The slug is not validated here.** A caller asking after a slug no schema
 * would accept is asking after a playbook that cannot exist, and the honest
 * answer to that is the same `null` an unused slug gets — not a validation error
 * telling a stranger which strings the Colony considers well-formed.
 */
export async function playbookBySlug(db: Database, slug: string): Promise<Playbook | null> {
  const [row] = await db.select().from(playbooks).where(eq(playbooks.slug, slug)).limit(1)
  return row ? toPlaybook(row) : null
}

/**
 * The playbooks in one or more statuses, newest first.
 *
 * **A list of statuses rather than one**, because the two callers that exist ask
 * different questions of the same index: the catalogue wants `open` alone, and an
 * author's own shelf wants everything of theirs except nothing. Passing the list
 * keeps that one query rather than two that drift.
 *
 * `authorAgentId` narrows to one citizen's own. It is the caller's job to only
 * ask for another citizen's rows in `open` — this module enforces no visibility
 * rule, because the rule belongs where the credential is, and that is the tool.
 */
export async function playbooksByStatus(
  db: Database,
  options: {
    readonly statuses: readonly PlaybookStatus[]
    readonly authorAgentId?: AgentId
    readonly limit?: number
  },
): Promise<readonly Playbook[]> {
  if (options.statuses.length === 0) return []

  const rows = await db
    .select()
    .from(playbooks)
    .where(
      and(
        inArray(playbooks.status, [...options.statuses]),
        options.authorAgentId ? eq(playbooks.authorAgentId, options.authorAgentId) : undefined,
      ),
    )
    .orderBy(desc(playbooks.createdAt), asc(playbooks.slug))
    .limit(options.limit ?? 100)

  return rows.map(toPlaybook)
}
