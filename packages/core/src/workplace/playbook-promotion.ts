import { z } from 'zod'
import {
  WorkplaceBoardIdSchema,
  WorkplaceCardClosureIdSchema,
  WorkplaceCardIdSchema,
} from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { PlaybookDraftSchema, PlaybookSlugSchema } from '../playbook/playbook.js'
import { WorkplaceCardClosureResultSchema } from './workplace.js'

/**
 * Promotion of grounded Workplace card closures into a playbook draft (`#1945`).
 *
 * Explicit promotion requires at least two distinct closures from two distinct
 * cards, visible to the caller, non-legacy, with at least one shipped or
 * failed_experiment outcome.
 */
export const WorkplacePlaybookPromotionRequestSchema = z
  .object({
    closureIds: z.array(WorkplaceCardClosureIdSchema).min(2).max(20),
    playbook: PlaybookDraftSchema.safeExtend({ slug: PlaybookSlugSchema }),
  })
  .strict()
export type WorkplacePlaybookPromotionRequest = z.infer<
  typeof WorkplacePlaybookPromotionRequestSchema
>

export const WorkplacePlaybookProvenanceResultCountsSchema = z
  .object({
    shipped: z.int().min(0),
    failed_experiment: z.int().min(0),
    abandoned: z.int().min(0),
    superseded: z.int().min(0),
  })
  .strict()
export type WorkplacePlaybookProvenanceResultCounts = z.infer<
  typeof WorkplacePlaybookProvenanceResultCountsSchema
>

export const WorkplacePlaybookProvenanceSnapshotSchema = z
  .object({
    sourceCount: z.int().min(0),
    resultCounts: WorkplacePlaybookProvenanceResultCountsSchema,
  })
  .strict()
export type WorkplacePlaybookProvenanceSnapshot = z.infer<
  typeof WorkplacePlaybookProvenanceSnapshotSchema
>

export const WorkplacePlaybookSourceSchema = z
  .object({
    closureId: WorkplaceCardClosureIdSchema,
    cardId: WorkplaceCardIdSchema,
    boardId: WorkplaceBoardIdSchema,
    result: WorkplaceCardClosureResultSchema,
    revision: z.int().min(1),
    createdAt: TimestampSchema,
    read: z
      .object({
        tool: z.literal('kolonie.workplace'),
        arguments: z
          .object({
            act: z.literal('get'),
            subject: z.literal('card'),
            id: WorkplaceCardIdSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
export type WorkplacePlaybookSource = z.infer<typeof WorkplacePlaybookSourceSchema>

/**
 * Provenance attached to an ordinary playbook read (`#1945`).
 *
 * `workplaceSources` is null on public reads and a permission-filtered list on
 * authenticated reads. The promotion snapshot remains readable even when an
 * edge has gone, and `provenanceDegraded` says that happened without revealing
 * which private source disappeared.
 */
export const WorkplacePlaybookProvenanceSchema = z
  .object({
    provenanceAtPromotion: WorkplacePlaybookProvenanceSnapshotSchema,
    provenanceDegraded: z.boolean(),
    workplaceSources: z.array(WorkplacePlaybookSourceSchema).nullable(),
  })
  .strict()
export type WorkplacePlaybookProvenance = z.infer<typeof WorkplacePlaybookProvenanceSchema>
