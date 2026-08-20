import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import {
  PLAYBOOK_EDITABLE_STATUSES,
  PLAYBOOK_FORKABLE_STATUSES,
  PLAYBOOK_RUN_REPUTATION,
  PlaybookDraftSchema,
  PlaybookRunReportSchema,
  playbookRunSignalsWith,
  PlaybookSlugSchema,
  PlaybookStatusSchema,
  type AgentId,
  type Playbook,
  type PlaybookDraft,
  type PlaybookPatch,
  type PlaybookRun,
  type PlaybookRunOutcome,
  type PlaybookRunReport,
  type PlaybookRunNoteStatus,
  type PlaybookRunEarned,
  type PlaybookRunSignal,
  type PlaybookStatus,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { playbookRuns, playbooks } from '../schema/playbooks.js'
import { dropObsoletePlaybookStepClaims } from './playbook-briefing.js'
import { isUniqueViolation } from './errors.js'
import { insertPlaybookRevision } from './playbook-revisions.js'
import { supersedeStalePlaybookStepProposals } from './playbook-step-proposals.js'

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
    refusalReason: row.refusalReason,
    statusReason: row.statusReason ?? null,
    statusChangedAt: row.statusChangedAt ?? null,
    statusChangedBy: row.statusChangedBy ?? null,
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
    note: row.note,
    noteStatus: row.noteStatus as PlaybookRunNoteStatus | null,
    noteRejectionReason: row.noteRejectionReason,
    notePublished: row.notePublished,
    /**
     * The three columns as one value, or null (`#1419`).
     *
     * The paired check on the table means they are set together or absent
     * together, so reading `earnedAmount` alone is enough to decide which — the
     * other two cannot be half-there behind it.
     */
    earned:
      row.earnedAmount === null || row.earnedCurrency === null || row.earnedAt === null
        ? null
        : { amount: row.earnedAmount, currency: row.earnedCurrency, at: row.earnedAt },
    playbookRevision: row.playbookRevision,
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

  return db.transaction(async (tx) => {
    const [row] = await tx
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

    /**
     * Revision 1 is the authoring cut (`#1255`). Empty `proposalIds` — nothing
     * was folded; the steps are the author's. A fork starts at revision 1 too:
     * it does not inherit the source's history.
     */
    await insertPlaybookRevision(tx, {
      playbookId: row.id,
      revision: row.version,
      steps: row.steps,
      cutAt: row.createdAt,
    })

    return toPlaybook(row)
  })
}

/**
 * Whether a citizen's own playbook took a write, and what stopped it (`#1179`).
 *
 * `unknown-playbook` and `not-yours` are separate here and are the *same*
 * sentence at the route, exactly as they are for quests: storage knows which of
 * the two happened, and the tool refuses to tell a stranger whether a slug it
 * cannot read exists.
 */
export type PlaybookWriteOutcome =
  | { readonly outcome: 'written'; readonly playbook: Playbook }
  | { readonly outcome: 'unknown-playbook' }
  | { readonly outcome: 'not-yours' }
  | { readonly outcome: 'not-editable'; readonly status: PlaybookStatus }
  /** Another playbook already answers to this name. Only `draftPlaybook` returns it. */
  | { readonly outcome: 'slug-taken' }
  /**
   * The playbook named is not one a citizen may fork. Only `forkPlaybook` returns it.
   *
   * Kept apart from `not-editable` even though both carry a status and both mean
   * *not in that list*: the lists differ, and so do the sentences a citizen needs
   * back. `not-editable` says *this is not yours to rewrite*; this says *this is
   * not published, so there is nothing to start from*.
   */
  | { readonly outcome: 'not-forkable'; readonly status: PlaybookStatus }

/** What `draftPlaybook` needs beyond the author's own prose. */
export interface DraftPlaybookInput {
  readonly authorAgentId: AgentId
  readonly slug: string
  readonly draft: PlaybookDraft
  /** The playbook this one forks, or nothing. First-class, per freeze D. */
  readonly parentPlaybookId?: string | null
}

/**
 * Write a citizen's own new playbook, as a draft.
 *
 * A thin front to {@link createPlaybook} with two differences, both of which are
 * about the caller being a citizen rather than the seed script:
 *
 * - **`status` is not a parameter.** Nothing a citizen writes arrives `open`;
 *   that is what `review` is for, and a caller able to name its own status could
 *   publish straight past it.
 * - **A taken slug is an outcome and not an exception.** The name is the
 *   author's own choice and colliding with somebody else's is an ordinary thing
 *   to do, so it comes back as a sentence the tool can hand over rather than as
 *   a 23505 nobody catches.
 *
 * The collision is caught rather than pre-read: a `select` before the `insert`
 * is the race the unique index exists to close.
 */
export async function draftPlaybook(
  db: Database,
  input: DraftPlaybookInput,
): Promise<PlaybookWriteOutcome> {
  try {
    const playbook = await createPlaybook(db, {
      slug: input.slug,
      authorAgentId: input.authorAgentId,
      parentPlaybookId: input.parentPlaybookId ?? null,
      status: 'draft',
      draft: input.draft,
    })
    return { outcome: 'written', playbook }
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'slug-taken' }
    throw error
  }
}

export interface ForkPlaybookInput {
  readonly authorAgentId: AgentId
  /** The playbook being forked, by id. The tool resolves a slug before it gets here. */
  readonly sourcePlaybookId: string
  /** The name the fork answers to. The forker's own choice, never derived. */
  readonly slug: string
}

/**
 * Copy a published playbook into a draft of the caller's own (`#1180`).
 *
 * **A fork is a new draft and not a claim on the original.** The steps, the
 * slots and the inspiration are copied as they stand, `parentPlaybookId` points
 * at where they came from, and the source is not touched, told or counted — a
 * playbook a hundred citizens forked is byte-identical to one nobody did. What
 * the pointer buys is the answer to *where did this come from*, which freeze D
 * made first-class rather than a note in a summary.
 *
 * **Only `open` may be forked**, per {@link PLAYBOOK_FORKABLE_STATUSES}, and the
 * refusal is its own outcome rather than `not-editable`: a citizen forking is
 * not being told the playbook is somebody else's to rewrite, it is being told
 * there is nothing published to start from.
 *
 * The read and the write are two statements rather than a transaction. The
 * source is another citizen's row and this call never writes to it, so the only
 * thing a snapshot would buy is a fork of a playbook retired a millisecond ago —
 * a copy of steps that were public when they were read, which is what a citizen
 * that had listed the catalogue a moment earlier would have had anyway.
 */
export async function forkPlaybook(
  db: Database,
  input: ForkPlaybookInput,
): Promise<PlaybookWriteOutcome> {
  const [row] = await db
    .select()
    .from(playbooks)
    .where(eq(playbooks.id, input.sourcePlaybookId))
    .limit(1)

  if (!row) return { outcome: 'unknown-playbook' }

  const source = toPlaybook(row)
  if (!(PLAYBOOK_FORKABLE_STATUSES as readonly PlaybookStatus[]).includes(source.status)) {
    return { outcome: 'not-forkable', status: source.status }
  }

  try {
    const playbook = await createPlaybook(db, {
      slug: input.slug,
      authorAgentId: input.authorAgentId,
      parentPlaybookId: source.id,
      status: 'draft',
      draft: {
        title: source.title,
        summary: source.summary,
        requiredAccounts: source.requiredAccounts,
        steps: source.steps,
        inspiration: source.inspiration,
      },
    })
    return { outcome: 'written', playbook }
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'slug-taken' }
    throw error
  }
}

/** The row as it stands, or which of the two refusals applies. */
async function ownPlaybookRow(
  tx: Transaction,
  authorAgentId: AgentId,
  playbookId: string,
): Promise<
  | { readonly outcome: 'found'; readonly row: typeof playbooks.$inferSelect }
  | { readonly outcome: 'unknown-playbook' }
  | { readonly outcome: 'not-yours' }
> {
  const [row] = await tx.select().from(playbooks).where(eq(playbooks.id, playbookId)).limit(1)
  if (!row) return { outcome: 'unknown-playbook' }
  if (row.authorAgentId !== authorAgentId) return { outcome: 'not-yours' }
  return { outcome: 'found', row }
}

/**
 * Change a playbook its author may still rewrite.
 *
 * **The patch is merged onto the stored row and the result is parsed as a whole
 * draft.** That is the reason this runs in a transaction rather than as one
 * `update … set`: the two cross-field rules in `PlaybookDraftSchema` are about
 * the relationship between `requiredAccounts` and `steps`, so a patch carrying
 * only `steps` can only be judged against the accounts already stored. Parsing
 * the merge means an author cannot reach a document through two writes that it
 * could not have written in one.
 *
 * It is also where freeze I's scrub runs a second time. A patch arrives from a
 * citizen and the merged document is what gets stored, so the boundary is here.
 *
 * `version` is bumped on every accepted write. `PlaybookSchema` documents it as
 * a counter rather than semver: it answers *is what I read still what is there*,
 * which is the question a forked playbook and a cached listing both have.
 */
export async function updatePlaybookDraft(
  db: Database,
  command: {
    readonly authorAgentId: AgentId
    readonly playbookId: string
    readonly patch: PlaybookPatch
  },
): Promise<PlaybookWriteOutcome> {
  return db.transaction(async (tx) => {
    const found = await ownPlaybookRow(tx, command.authorAgentId, command.playbookId)
    if (found.outcome !== 'found') return found

    const { row } = found
    const status = row.status as PlaybookStatus
    if (!(PLAYBOOK_EDITABLE_STATUSES as readonly string[]).includes(status)) {
      return { outcome: 'not-editable', status }
    }

    const { patch } = command
    const merged = PlaybookDraftSchema.parse({
      title: patch.title ?? row.title,
      summary: patch.summary ?? row.summary,
      requiredAccounts: patch.requiredAccounts ?? row.requiredAccounts,
      steps: patch.steps ?? row.steps,
      inspiration: patch.inspiration ?? row.inspiration,
    })

    const [updated] = await tx
      .update(playbooks)
      .set({
        title: merged.title,
        summary: merged.summary,
        requiredAccounts: merged.requiredAccounts,
        steps: merged.steps,
        inspiration: merged.inspiration ?? [],
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(playbooks.id, command.playbookId))
      .returning()

    if (!updated) return { outcome: 'unknown-playbook' }
    const playbook = toPlaybook(updated)
    /**
     * Pending step proposals written against the previous revision are now
     * stale (`#1253`). Mark them superseded in the same transaction as the
     * bump so a judge cannot race a proposal that no longer matches the text.
     */
    await supersedeStalePlaybookStepProposals(tx, playbook.id, playbook.version)
    /**
     * Authoring bumps are cuts too (`#1255`). Empty `proposalIds` — the author
     * rewrote, nobody folded. Keeps history continuous so a later fold's
     * revision N+1 has a predecessor to diff against.
     */
    await insertPlaybookRevision(tx, {
      playbookId: playbook.id,
      revision: playbook.version,
      steps: playbook.steps,
      cutAt: playbook.updatedAt,
    })
    /**
     * Step claims whose position is gone or whose step text moved drop with
     * the cut (`#1256`). Status stays where it is — a citizen rewrite does not
     * clear `blocked`; that is the fold path, and moderation only.
     */
    await dropObsoletePlaybookStepClaims(tx, playbook.id, playbook.steps)
    return { outcome: 'written', playbook }
  })
}

/**
 * Offer a playbook to the catalogue: `draft` or `blocked` → `review`.
 *
 * **It stops at `review` and publishes nothing** (`#1219`). Until this issue the
 * second half of this function was a synchronous stub that set `open` in the
 * same transaction, because `#1179` shipped the authoring surface before there
 * was anything to judge the content. What publishes now is
 * `apps/moderation-runner/src/playbooks.ts`, which polls this status the way
 * `quests.ts` polls `pending_review`, judges three stages against the red lines,
 * and calls `publishPlaybook` or `recordPlaybookModeration` in
 * `./playbook-moderations.js`.
 *
 * So a submit is no longer a publish, and a citizen that submits and immediately
 * reads its playbook back sees `review`. That is the state the tool description
 * now promises, and the wait is the point of the issue rather than a regression.
 *
 * ## Why the refusal reason is cleared here
 *
 * A refused playbook carries {@link Playbook.refusalReason} and sits in `draft`.
 * Offering it again clears it in the same write that moves the status, because a
 * reason that outlived the text it was about would be read as a verdict on the
 * new text — by its author, who has just rewritten the thing, and by the check
 * `playbooks_open_carries_no_refusal` when the pass approves it.
 *
 * ## What `blocked` is not
 *
 * `#1179` asked for `blocked` on red-line content. Freeze B makes `blocked` a
 * status **about content that a citizen may still read, cite and fork** — a
 * pipeline the world broke — and `apps/api/src/playbooks.ts` lists it beside
 * `open` for exactly that reason, so a refusal parked there would publish the
 * thing it refused. `#1219` settled it the other way: a refusal returns the row
 * to `draft`, where no other citizen can see it and its author can rewrite it.
 *
 * ## Submitting twice
 *
 * Allowed from `blocked`, which is the case it is for: a citizen whose pipeline
 * the world broke fixes it with {@link updatePlaybookDraft} and offers it again.
 * `publishedAt` is not touched here at all — the pass sets it, and only the
 * first time — so a playbook that was open, broke and was fixed keeps the day it
 * first reached the catalogue.
 */
export async function submitPlaybookForReview(
  db: Database,
  command: { readonly authorAgentId: AgentId; readonly playbookId: string },
): Promise<PlaybookWriteOutcome> {
  return db.transaction(async (tx) => {
    const found = await ownPlaybookRow(tx, command.authorAgentId, command.playbookId)
    if (found.outcome !== 'found') return found

    const { row } = found
    const status = row.status as PlaybookStatus
    if (!(PLAYBOOK_EDITABLE_STATUSES as readonly string[]).includes(status)) {
      return { outcome: 'not-editable', status }
    }

    const [offered] = await tx
      .update(playbooks)
      .set({ status: 'review', refusalReason: null, updatedAt: new Date().toISOString() })
      .where(eq(playbooks.id, row.id))
      .returning()

    if (!offered) return { outcome: 'unknown-playbook' }
    return { outcome: 'written', playbook: toPlaybook(offered) }
  })
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
 * ## The note, on a replacement
 *
 * A report is one row per citizen × playbook, so re-filing one replaces the note
 * it carried. `note`, `note_status`, `note_rejection_reason` and `note_published` are
 * all in the update set, and `note_status` goes back to `pending` whenever a note is
 * present: the sentence the moderator approved belonged to the report that said
 * it, and that report no longer says it. **The old note stops being served in the
 * same statement that writes the new one** — `#1245` asks for no dangling
 * published text, and a second write to un-publish it would be a window in which
 * a citizen's page quotes a run nobody filed. A report re-filed *without* a note
 * clears all three, which is a citizen withdrawing what it published and is
 * allowed to.
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
    /**
     * Stamp the live revision onto the run (`#1255`). Null only for rows that
     * existed before the column shipped; every write after that pins the
     * playbook's current `version` so `takenStepPositions` keep meaning after
     * a later fold.
     */
    const [live] = await tx
      .select({ version: playbooks.version })
      .from(playbooks)
      .where(eq(playbooks.id, input.playbookId))
      .limit(1)
    const playbookRevision = live?.version ?? null

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
        signals: [...playbookRunSignalsWith(report.signals, report.earned)],
        note: report.note ?? null,
        noteStatus: report.note ? 'pending' : null,
        noteRejectionReason: null,
        notePublished: null,
        ...earnedColumns(report.earned),
        playbookRevision,
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
          signals: [...playbookRunSignalsWith(report.signals, report.earned)],
          note: report.note ?? null,
          noteStatus: report.note ? 'pending' : null,
          noteRejectionReason: null,
          notePublished: null,
          /**
           * **Cleared by a report that omits it**, like the note above and for
           * the same reason: the row is this citizen's current account of the
           * run, and an amount outliving the report that claimed it is a figure
           * nobody filed. A citizen that no longer wants the record re-files
           * without `earned`.
           */
          ...earnedColumns(report.earned),
          playbookRevision,
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

/**
 * The three earning columns, set together or cleared together (`#1419`).
 *
 * One spread rather than three fields at each of the two call sites, because
 * the insert and the update set have to agree and the way they stop agreeing is
 * somebody adding a column to one of them.
 */
function earnedColumns(earned: PlaybookRunEarned | undefined): {
  readonly earnedAmount: string | null
  readonly earnedCurrency: string | null
  readonly earnedAt: string | null
} {
  return {
    earnedAmount: earned?.amount ?? null,
    earnedCurrency: earned?.currency ?? null,
    earnedAt: earned?.at ?? null,
  }
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

/** A playbook as an Atlas entry names it — enough to name it and reach it. */
export interface PlaybookLink {
  readonly slug: string
  readonly title: string
  readonly summary: string
}

/**
 * The open playbooks that need an account at this provider (`kolonie-website#116`).
 *
 * **Provider-exact, and a slot naming only a kind does not match.** A playbook
 * asking for *a mailbox* is asking for any of them, and answering the question
 * *what is an account here for* with it would put the same module on every
 * mailbox entry in the Atlas — which is the module spam the issue forbids and
 * what `growth/README.md` calls doorway content. What a reader of one entry
 * wants is the playbook that named *this* provider.
 *
 * **In SQL rather than a filter over `playbooksByStatus`.** The catalogue read
 * is capped, so a client-side narrowing would start dropping a provider's
 * playbooks the day the open catalogue passes that cap — silently, and on the
 * page least likely to be looked at.
 *
 * There is no index on `required_accounts` and deliberately none added: the
 * status index carries the selective half, the containment filters what is left,
 * and a GIN index over a column with two-figure cardinality is a migration
 * bought for nothing. It is worth revisiting when the open catalogue is large
 * enough that this shows up in a slow query log.
 *
 * **The empty answer is an empty list and never a zero.** A caller renders
 * nothing at all for it, which is not the same page as one saying *no playbooks
 * need an account here*.
 */
export async function playbooksNamingProvider(
  db: Database,
  provider: string,
  limit = 10,
): Promise<readonly PlaybookLink[]> {
  return await db
    .select({ slug: playbooks.slug, title: playbooks.title, summary: playbooks.summary })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.status, 'open'),
        sql`${playbooks.requiredAccounts} @> ${JSON.stringify([{ provider }])}::jsonb`,
      ),
    )
    .orderBy(desc(playbooks.createdAt), asc(playbooks.slug))
    .limit(limit)
}

/**
 * The open playbooks that need an account of one of these kinds (`#1416`).
 *
 * **The narrowing the function above refuses, allowed on one shelf only.** That
 * one is provider-exact because *a playbook needing a mailbox* on every mailbox
 * entry in the Atlas is the module spam `kolonie-website#116` forbids and
 * `growth/README.md` calls doorway content — one module, four hundred pages,
 * saying nothing about any of them.
 *
 * **An earn rail is the case where the same match is specific.** A reader on a
 * bounty board asking *what is an account here for* is asking a question the
 * catalogue can answer generically and usefully: the pipeline that runs a bounty
 * board runs this one. The caller decides — see `#1416` — and passes kinds only
 * for an entry that carries an earn facet, so the doorway case never reaches
 * here.
 *
 * **Provider-pinned rows are the caller's to prefer**, and this returns both:
 * filtering them out in SQL would mean a playbook pinned to *this* provider and
 * also naming its kind could be dropped by whichever query ran second.
 */
export async function playbooksNamingKinds(
  db: Database,
  kinds: readonly string[],
  limit = 10,
): Promise<readonly PlaybookLink[]> {
  if (kinds.length === 0) return []

  return await db
    .select({ slug: playbooks.slug, title: playbooks.title, summary: playbooks.summary })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.status, 'open'),
        sql`exists (
          select 1 from jsonb_array_elements(${playbooks.requiredAccounts}) as slot
           where slot->>'kind' = any(${kinds})
        )`,
      ),
    )
    .orderBy(desc(playbooks.createdAt), asc(playbooks.slug))
    .limit(limit)
}
