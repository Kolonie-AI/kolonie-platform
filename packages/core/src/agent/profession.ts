import { z } from 'zod'
import { credentialFinding, credentialRefusalMessage } from '../common/credential-shape.js'
import { TimestampSchema } from '../common/time.js'

/** Bounds one constitution before it enters a transaction or catalogue response. */
export const PROFESSION_DEFINITION_MAX_BYTES = 8 * 1024

/** Stable data key so adding a profession never changes an API enum. */
export const ProfessionKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

/** Lifecycle is separate from versions so retirement preserves the last publication. */
export const ProfessionLifecycleSchema = z.enum(['active', 'retired'])

const prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((value, ctx) => {
      const finding = credentialFinding(value)
      if (finding === null) return
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: credentialRefusalMessage(finding) })
    })

const proseList = z.array(prose(600)).min(1).max(8)

const ProfessionDefinitionFieldsSchema = z
  .object({
    key: ProfessionKeySchema,
    version: z.number().int().positive(),
    title: prose(80),
    summary: prose(280),
    vision: prose(1200),
    mission: prose(1200),
    intendedImpact: prose(1200),
    audience: prose(1200),
    successSignals: proseList,
    principles: proseList,
    failureModes: proseList,
    boundaries: proseList,
    workplaceOrientation: prose(1200),
  })
  .strict()

/** A complete publication so a new version cannot inherit stale clauses. */
export const ProfessionDefinitionSchema = ProfessionDefinitionFieldsSchema.superRefine(
  (definition, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(definition), 'utf8')
    if (bytes <= PROFESSION_DEFINITION_MAX_BYTES) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `profession definition must be at most ${PROFESSION_DEFINITION_MAX_BYTES} UTF-8 bytes; received ${bytes}`,
    })
  },
)
export type ProfessionDefinition = z.infer<typeof ProfessionDefinitionSchema>

/** Compact catalogue state; full constitutions remain lazy reads. */
export const ProfessionSummarySchema = z
  .object({
    key: ProfessionKeySchema,
    lifecycle: ProfessionLifecycleSchema,
    currentVersion: z.number().int().positive(),
    publishedAt: TimestampSchema.optional(),
    retiredAt: TimestampSchema.nullable().optional(),
  })
  .strict()
export type ProfessionSummary = z.infer<typeof ProfessionSummarySchema>

/** A stable-key choice that deliberately does not pin a definition version. */
export const ProfessionAssignmentSchema = z
  .object({
    key: ProfessionKeySchema,
    chosenAt: TimestampSchema,
    assignmentVersion: z.number().int().positive(),
  })
  .strict()
export type ProfessionAssignment = z.infer<typeof ProfessionAssignmentSchema>
