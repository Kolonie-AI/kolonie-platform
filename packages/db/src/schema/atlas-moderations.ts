import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { AtlasVerdictSchema } from '@kolonie-ai/core'
import { atlasProposals } from './atlas-proposals.js'

const VERDICTS = AtlasVerdictSchema.options

/**
 * Every verdict the Colony reached about a proposed provider, and what decided
 * it (`#812`).
 *
 * **A third table, for the reason `quest_moderations` is a second one.** That
 * file argues that a report and a quest are less alike than they look and that
 * what they share is the *shape* of the record rather than the subject. A
 * proposal is a third subject and is further from either: it is not a citizen's
 * prose at all, it is a question about a third party's product, and the stages
 * that decide it are the Atlas's three admission questions rather than the
 * report pipeline's four.
 *
 * **Append-only, like every other moderation table here.** A refused proposal
 * may be proposed again — a provider that shipped an API since, an entry
 * somebody described badly the first time — and that produces a second verdict
 * about a different claim. The row that refused the first one stays, and
 * `content_sha256` is what tells them apart.
 *
 * **What it is worth keeping.** *Why was this listed* is answerable from a row
 * here in a way *which steward was on duty* never was: the model that answered,
 * the outcome of each question, and the shelf it chose.
 */
export const atlasModerations = pgTable(
  'atlas_moderations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The proposal this verdict judged.
     *
     * `cascade`, matching `quest_moderations.task_id` and for its reason: a
     * verdict about a row that is gone is a record of nothing, and the digest
     * stays checkable by anyone holding a guess at the text.
     */
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => atlasProposals.id, { onDelete: 'cascade' }),

    /** `accepted`, `refused` or `merged`. Never `pending` — see the check below. */
    decision: text('decision').notNull(),

    /**
     * The model that answered, as configured at the moment of the verdict. A
     * copy and not a pointer, exactly as `moderations.model` is: changing
     * `OPENROUTER_MODEL` must not silently restate which model judged last week.
     */
    model: text('model').notNull(),

    /**
     * What each stage answered. `AtlasModerationStagesSchema` in core is the
     * shape, and a stage that did not run says `not-run` rather than being
     * absent — so *question two passed it* and *question two was never reached*
     * are different rows.
     */
    stages: jsonb('stages').notNull(),

    /**
     * The claim this verdict judged, as a digest of the provider and the reason
     * given for it.
     *
     * The same argument `moderations.content_sha256` makes: a proposer may come
     * back with the same provider and a better reason, so one provider
     * accumulates rows and *which claim was this about* has no answer from the
     * row alone.
     */
    contentSha256: text('content_sha256').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'atlas_moderations_decision_is_a_verdict',
      sql`${table.decision} in (${sql.raw(VERDICTS.map((one) => `'${one}'`).join(', '))})`,
    ),
    check('atlas_moderations_content_sha256_shape', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    /** The audit read: every verdict about one proposal, newest first. */
    index('atlas_moderations_proposal_idx').on(table.proposalId, table.createdAt),
  ],
)
