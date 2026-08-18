import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { AgentPlatform, PlaybookBriefingSection } from '@kolonie-ai/core'
import { playbooks } from './playbooks.js'

/**
 * One claim the Colony currently makes about a playbook (`#1251`).
 *
 * ## Why a table of rows rather than a JSONB array
 *
 * Task and provider briefings store claims as a JSONB array on one briefing
 * row. A playbook briefing needs one more fact those two do not: **which
 * revision a claim was written against**, so a later cut can invalidate the
 * pointer (`#1256`). Putting that beside each claim, and matching
 * `last_supported_at` across a wholesale replace on `(section, step_position,
 * text)`, is what a row buys that an opaque array does not.
 *
 * ## Replace, never merge
 *
 * Each synthesis run deletes every claim for the playbook and writes the new
 * set. Continuity of `last_supported_at` is computed in the storage write by
 * matching identical `(section, step_position, text)` against what was there —
 * an identical claim keeps its date; a reworded one is new. Merging invents a
 * history the synthesis did not compute.
 *
 * ## Cap
 *
 * At most 40 claims per playbook (`PLAYBOOK_BRIEFING_CLAIM_CAP`), enforced on
 * the write rather than as a check — beyond that the synthesis is sprawling and
 * the counter tells us.
 */
export const playbookBriefingClaims = pgTable(
  'playbook_briefing_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    /** Which of the four questions this claim answers. */
    section: text('section').$type<PlaybookBriefingSection>().notNull(),

    /** The Colony's own sentence. No substring of it is copied from a run note. */
    text: text('text').notNull(),

    /**
     * The approved run ids this claim was written from.
     *
     * Ids only — citizen prose is not copied here. Ordered as the synthesis
     * named them; uniqueness is the write's job.
     */
    sources: uuid('sources').array().notNull(),

    /** How many run reports back this claim — equal to `sources.length` by construction. */
    reports: integer('reports').notNull(),

    /** Which runtimes those reports came from, and how many of each. */
    platforms: jsonb('platforms')
      .$type<Partial<Record<AgentPlatform, number>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * When a run report last supported this claim.
     *
     * Survives a replace when the new run produces an identical
     * `(section, step_position, text)`; a reworded claim gets a fresh date.
     */
    lastSupportedAt: timestamp('last_supported_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),

    /**
     * 1-based step index when {@link section} is `step`; null otherwise.
     *
     * Points at a step in {@link revision}. A later cut does not keep the
     * pointer valid — that invalidation is `#1256`.
     */
    stepPosition: integer('step_position'),

    /**
     * The playbook revision this claim was written against.
     *
     * Copied from `playbooks.version` at write time. A claim from an earlier
     * revision may still be served until `#1256` demotes it.
     */
    revision: integer('revision').notNull(),
  },
  (table) => [
    index('playbook_briefing_claims_playbook_idx').on(table.playbookId),
    check(
      'playbook_briefing_claims_section_is_known',
      sql`${table.section} in ('step', 'route', 'yield', 'unsolved')`,
    ),
    check('playbook_briefing_claims_text_not_blank', sql`length(trim(${table.text})) > 0`),
    check('playbook_briefing_claims_reports_positive', sql`${table.reports} >= 1`),
    check('playbook_briefing_claims_sources_not_empty', sql`cardinality(${table.sources}) >= 1`),
    check(
      'playbook_briefing_claims_step_position_positive',
      sql`${table.stepPosition} is null or ${table.stepPosition} >= 1`,
    ),
    check('playbook_briefing_claims_revision_positive', sql`${table.revision} >= 1`),
    check(
      'playbook_briefing_claims_platforms_is_object',
      sql`jsonb_typeof(${table.platforms}) = 'object'`,
    ),
  ],
)
