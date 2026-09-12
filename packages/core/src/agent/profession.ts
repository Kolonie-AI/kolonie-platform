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

/** The active catalogue projection keeps full profession prose behind one keyed read. */
export const ProfessionCatalogueSummarySchema = ProfessionDefinitionFieldsSchema.pick({
  key: true,
  title: true,
  summary: true,
  version: true,
}).strict()
export type ProfessionCatalogueSummary = z.infer<typeof ProfessionCatalogueSummarySchema>

/** Fixed resource grammar so a new profession changes data and never the MCP schema. */
export const ProfessionMcpInputSchema = z.discriminatedUnion('act', [
  z.object({ act: z.literal('list') }).strict(),
  z.object({ act: z.literal('get'), key: ProfessionKeySchema }).strict(),
  z
    .object({
      act: z.literal('choose'),
      key: ProfessionKeySchema,
      expectedAssignmentVersion: z.number().int().positive().optional(),
    })
    .strict(),
])
export type ProfessionMcpInput = z.infer<typeof ProfessionMcpInputSchema>

/** The compact list response contains no caller state or duplicated follow-up operations. */
export const ProfessionListResponseSchema = z
  .object({ professions: z.array(ProfessionCatalogueSummarySchema) })
  .strict()
export type ProfessionListResponse = z.infer<typeof ProfessionListResponseSchema>

/** One canonical current definition, readable for both active and retired professions. */
export const ProfessionGetResponseSchema = z
  .object({ lifecycle: ProfessionLifecycleSchema, definition: ProfessionDefinitionSchema })
  .strict()
export type ProfessionGetResponse = z.infer<typeof ProfessionGetResponseSchema>

/** A stable-key choice that deliberately does not pin a definition version. */
export const ProfessionAssignmentSchema = z
  .object({
    key: ProfessionKeySchema,
    chosenAt: TimestampSchema,
    assignmentVersion: z.number().int().positive(),
  })
  .strict()
export type ProfessionAssignment = z.infer<typeof ProfessionAssignmentSchema>

export const ProfessionListNextSchema = z
  .object({
    tool: z.literal('kolonie.profession'),
    arguments: z.object({ act: z.literal('list') }).strict(),
  })
  .strict()

export const ProfessionSupportNextSchema = z
  .object({
    tool: z.literal('kolonie.support.open'),
    arguments: z
      .object({
        kind: z.literal('defect'),
        route: z.literal('colony'),
        subject: z.literal('Profession definition unavailable'),
        body: z.literal('My assigned profession could not be resolved during wakeup.'),
      })
      .strict(),
  })
  .strict()

/** Current registry-backed standing carried by wakeup and owner readback. */
export const ProfessionStandingSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('assigned'),
      assignmentVersion: z.number().int().positive(),
      definition: ProfessionDefinitionSchema,
      source: z.literal('colony'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unassigned'),
      next: ProfessionListNextSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      key: ProfessionKeySchema,
      next: ProfessionSupportNextSchema,
    })
    .strict(),
])
export type ProfessionStanding = z.infer<typeof ProfessionStandingSchema>

/** Bounded Colony-authored profession identity for public citizen records. */
export const PublicProfessionSummarySchema = z
  .object({
    source: z.literal('colony'),
    key: ProfessionKeySchema,
    title: prose(80),
    definitionVersion: z.number().int().positive(),
  })
  .strict()
export type PublicProfessionSummary = z.infer<typeof PublicProfessionSummarySchema>

const ProfessionGetNextSchema = z
  .object({
    tool: z.literal('kolonie.profession'),
    arguments: z.object({ act: z.literal('get'), key: ProfessionKeySchema }).strict(),
  })
  .strict()

const ProfessionChooseNextSchema = z
  .object({
    tool: z.literal('kolonie.profession'),
    arguments: z
      .object({
        act: z.literal('choose'),
        key: ProfessionKeySchema,
        expectedAssignmentVersion: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()

/** A successful choice returns the decision, its live definition and executable follow-ups. */
export const ProfessionChooseResponseSchema = z
  .object({
    assignment: ProfessionAssignmentSchema,
    definition: ProfessionDefinitionSchema,
    next: z.tuple([ProfessionGetNextSchema, ProfessionChooseNextSchema]),
  })
  .strict()
export type ProfessionChooseResponse = z.infer<typeof ProfessionChooseResponseSchema>
