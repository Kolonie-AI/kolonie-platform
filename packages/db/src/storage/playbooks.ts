import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  PlaybookDraftSchema,
  PlaybookSlugSchema,
  PlaybookStatusSchema,
  type AgentId,
  type Playbook,
  type PlaybookDraft,
  type PlaybookStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbooks } from '../schema/playbooks.js'

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
