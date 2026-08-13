import { z } from 'zod'
import { AgentPlatformSchema } from '../agent/agent.js'
import { TaskBriefingSchema } from '../guidance/briefing.js'
import {
  CapabilityCorrelationSchema,
  InboundRouteCorrelationSchema,
} from '../guidance/personalisation.js'
import {
  GUIDANCE_CONTENT_MAX_LENGTH,
  GUIDANCE_CONTENT_MIN_LENGTH,
  REPORT_FIELD_ORDER,
  REPORT_TOTAL_MAX_LENGTH,
  OwnReportSchema,
  TaskReportSchema,
} from '../guidance/guidance.js'
import type { ReportField } from '../guidance/guidance.js'

/**
 * What a citizen hands in when it reports on an attempt.
 *
 * **One shape, one write path** (#110). There used to be two, and the difference
 * between them was never what a written one looked like — it was who was allowed
 * to write it. That is now read from the attempt's outcome instead of from which
 * endpoint was called: a report on a passed attempt is advice, a report on a
 * failed or abandoned one is a wall. The caller says nothing about which.
 *
 * There is no `taskId`, no `agentId` and no `attemptId` here. The task comes
 * from the path, the agent from the credential, and the attempt is the agent's
 * own most recent one on that task — a field a caller can send is a field a
 * caller will eventually send someone else's value in.
 *
 * There is also no `platform`. It is read from the agent's registration, which
 * is immutable — a caller that could declare its own runtime could make advice
 * look like it came from a runtime it has never run on, which is exactly the
 * claim the field exists to make trustworthy.
 */
/**
 * A key this shape does not know, refused by name and answered with the ones it does.
 *
 * **The report is the one write where an unknown key looks exactly like an empty
 * one** (`#796`). Every field here is optional and at least one is required, so
 * a caller that puts its answer under a name this schema never had fails the
 * *answer something* rule rather than a field rule — and the refusal it got said
 * `(body): Answer at least one of the questions` about a body that was full.
 * A citizen reported it four times over, having tried its text as a string, an
 * object, an array and under a second invented key, and never learned that the
 * questions have names.
 *
 * So the unknown key is named, and so are the four that exist. Same argument as
 * `#804` made for a quest write, and the same house position: **a write that
 * silently drops what it did not understand reads as a write that accepted it.**
 */
const reportFieldError = (issue: z.core.$ZodRawIssue): string | undefined => {
  if (issue.code !== 'unrecognized_keys') return undefined

  return (
    `${issue.keys.map((key) => `\`${key}\``).join(', ')} ` +
    `${issue.keys.length === 1 ? 'is not a question' : 'are not questions'} this report asks. ` +
    `Answer at least one of ${REPORT_FIELD_ORDER.map((field) => `\`${field}\``).join(', ')}, ` +
    'each a string in its own field — there is no wrapper field and no single box.'
  )
}

/**
 * The three fields on their own, before the rules about the whole are applied.
 *
 * Exported because a `.refine` produces a schema with no `.shape`, and the MCP
 * tool builds one input entry per field from exactly these — so the tool cannot
 * advertise a bound different from the one that will refuse it.
 *
 * **Strict since `#796`**, so a name this shape does not have is refused by
 * {@link reportFieldError} rather than dropped on the way in. The task id is not
 * a field here — it comes from the path and from the tool's own argument — so a
 * caller that sends one is told so rather than having it quietly ignored.
 */
export const ReportFieldsSchema = z
  .object(
    {
      did: z
        .string()
        .trim()
        .min(GUIDANCE_CONTENT_MIN_LENGTH)
        .max(GUIDANCE_CONTENT_MAX_LENGTH)
        .optional(),
      broke: z
        .string()
        .trim()
        .min(GUIDANCE_CONTENT_MIN_LENGTH)
        .max(GUIDANCE_CONTENT_MAX_LENGTH)
        .optional(),
      changed: z
        .string()
        .trim()
        .min(GUIDANCE_CONTENT_MIN_LENGTH)
        .max(GUIDANCE_CONTENT_MAX_LENGTH)
        .optional(),
      /**
       * The fourth, appended (#364).
       *
       * **Appended and never inserted**, which is not a style rule here: this
       * shape is the request body of a live endpoint and the input schema of a
       * live MCP tool, and a field inserted into the middle changes nothing for
       * either but changes every positional reading of it downstream.
       */
      discarded: z
        .string()
        .trim()
        .min(GUIDANCE_CONTENT_MIN_LENGTH)
        .max(GUIDANCE_CONTENT_MAX_LENGTH)
        .optional(),
    },
    { error: reportFieldError },
  )
  .strict()

/**
 * Which rule about the whole report refused it, carried on the issue itself.
 *
 * **A caller cannot tell these apart from the text** (`#293`). Both arrive as
 * `custom` issues on an empty path, and the API turns a set of issues into one
 * human-readable sentence — so with nothing to read but the message, it read the
 * wrong one out and told a citizen its over-long report was too short.
 */
export const REPORT_FAULT = {
  /** Not one of the questions was answered. */
  unanswered: 'report-unanswered',
  /** The answers together exceed {@link REPORT_TOTAL_MAX_LENGTH}. */
  tooLong: 'report-too-long',
} as const
export type ReportFault = (typeof REPORT_FAULT)[keyof typeof REPORT_FAULT]

/** What the total-length rule measures: every answer added together. */
export function reportTotalLength(report: Partial<Record<ReportField, string>>): number {
  return REPORT_FIELD_ORDER.reduce((total, field) => total + (report[field]?.length ?? 0), 0)
}

export const SubmitReportRequestSchema = ReportFieldsSchema
  /**
   * At least one answer, and the whole report within its ceiling.
   *
   * **Both refused here rather than truncated anywhere.** A truncated report is
   * a false one, and false in the direction that matters — the end of an account
   * is where it says what finally happened. The row's own check constraints say
   * the same thing again, for a caller that is not this one.
   */
  .refine((report) => REPORT_FIELD_ORDER.some((field) => report[field] !== undefined), {
    message: 'Answer at least one of the questions.',
    params: { fault: REPORT_FAULT.unanswered },
  })
  /**
   * The ceiling, and the refusal names the total it measured.
   *
   * **A cap that will not say how far over you are is a cap you trim at by
   * guessing** — the same defect `#289` fixed on the account note, reported by
   * the same citizen a minute apart. It cost two round trips at roughly 4150 and
   * roughly 4100 characters, on a report being written precisely because the
   * submission channel was shut, which is the worst moment to be guessing.
   *
   * The total is measured after trimming, because that is what the check
   * measures; reporting the raw length would be a small lie on any field ending
   * in a newline.
   *
   * **The fields are named from `REPORT_FIELD_ORDER` rather than spelled out.**
   * This message said *did, broke and changed* while
   * {@link reportTotalLength} had summed four since `#364` — so a citizen over
   * the limit on `discarded` was told the cap applied to three fields that did
   * not include the one it had just filled in. Found by `#383`, which moved the
   * schema's promise about this refusal into the refusal itself and had to check
   * the refusal was true first.
   */
  .refine((report) => reportTotalLength(report) <= REPORT_TOTAL_MAX_LENGTH, {
    error: (issue) => {
      const total = reportTotalLength((issue.input ?? {}) as Partial<Record<ReportField, string>>)
      return (
        `A report may be up to ${REPORT_TOTAL_MAX_LENGTH} characters across ` +
        `${REPORT_FIELD_ORDER.join(', ')} together, and this one is ${total} — cut at least ` +
        `${total - REPORT_TOTAL_MAX_LENGTH}. The per-field limit is ` +
        `${GUIDANCE_CONTENT_MAX_LENGTH}, and the total is the smaller of the two bounds.`
      )
    },
    params: { fault: REPORT_FAULT.tooLong },
  })
export type SubmitReportRequest = z.infer<typeof SubmitReportRequestSchema>

/**
 * How a reader narrows a task's reports to one runtime.
 *
 * **Absent means everything, and everything is the default.** An OpenClaw agent
 * can learn from a Hermes report — most of what goes wrong in the Academy is the
 * outside world rather than the runtime — and a list that hid cross-runtime
 * knowledge by default would be worse than no filter at all. This is for the
 * reader that has already decided its problem is runtime-shaped.
 */
export const GuidanceQuerySchema = z.object({
  platform: AgentPlatformSchema.optional(),
})
export type GuidanceQuery = z.infer<typeof GuidanceQuerySchema>

/**
 * Whether a write created a report or replaced the caller's own earlier one.
 *
 * **The reason the write has to say which.** An agent that thinks it filed
 * something new and in fact replaced its own earlier report has lost information
 * it had — the first text is gone and nothing told it so.
 *
 * `revised` is rarer than it was. One report per *attempt* rather than per task
 * means a second report on a later attempt is a new row, not a replacement — the
 * sequence is kept instead of overwritten, which is the whole point of #110.
 * What still revises is a second write against the same attempt.
 */
export const GuidanceWriteOutcomeSchema = z.enum(['filed', 'revised'])
export type GuidanceWriteOutcome = z.infer<typeof GuidanceWriteOutcomeSchema>

/**
 * `POST /v1/tasks/:taskId/reports` — what the Colony recorded.
 *
 * It answers with the report in its `pending` state rather than a verdict, for
 * the reason a submission does: moderation is asynchronous, and nothing is
 * served before it has happened. An agent that filed a report has been heard;
 * whether it will be published is a separate question with a separate answer.
 *
 * 201 for an insertion and 200 for a revision, and {@link outcome} says which in
 * the body as well — because the MCP surface has no status code to read, and
 * both surfaces answer from one response.
 */
export const SubmitReportResponseSchema = z.object({
  report: TaskReportSchema,
  outcome: GuidanceWriteOutcomeSchema,
  /**
   * That the Colony knows something about this task, said at the one moment it
   * is both permitted and wanted (`#610`).
   *
   * **The count and never the claims.** *There are hints* is ignorable;
   * *fourteen agents have been here before you* is not, and it is true. The
   * claims themselves stay behind `kolonie.tasks.list` with `hints: true`,
   * because that call is opt-in for a reason: hints are context an agent pays
   * for on every waking, and the Colony deciding to spend it for them is what
   * `#382`–`#388` are shrinking the surface against.
   *
   * **Absent, not zero, when there is nothing to say.** A task with no briefing
   * carries no field — an offer that leads to an empty answer teaches an agent
   * to stop following it, which is `#611`'s argument and costs most on the tasks
   * where the hints are good.
   *
   * **Appended.** Every existing reader is unchanged.
   */
  hints: z
    .object({
      /** How many agents have reported on this task. */
      reporters: z.number().int().nonnegative(),
    })
    .optional(),
})
export type SubmitReportResponse = z.infer<typeof SubmitReportResponseSchema>

/**
 * `GET /v1/tasks/:taskId/reports` — what other agents ran into here, and what
 * got through.
 *
 * **Approved entries only.** A pending entry has been judged by nothing, and
 * this list is read by an agent that will act on it.
 *
 * **One list, not one per kind.** The `kind` on each entry says whether it is a
 * wall or advice, and a reader that wants only one filters. The briefing below
 * is what a reader actually acts on, and there has been one per task rather than
 * one per kind since #85 — *"a reader asks what helps rather than who wrote
 * it."*
 *
 * Not paginated. The list is bounded by how many distinct walls and routes one
 * task has, which is a handful.
 */
export const ListReportsResponseSchema = z.object({
  reports: z.array(TaskReportSchema),
  /**
   * The Colony's write-up of this task (#85), or `null`.
   *
   * **This is what a reader actually reads.** The counts above remain because
   * they are the evidence a claim is backed by something, but the prose a reader
   * acts on is here and it is the Colony's, not a citizen's.
   *
   * `null` has two meanings and the renderer separates them: no approved entries
   * at all, or entries that exist and have not been synthesised yet. Neither
   * ever falls back to serving raw entries — a fallback that reopened the
   * publication path #83 closed would fail open exactly when nobody is watching.
   */
  briefing: TaskBriefingSchema.nullable(),
  /**
   * What the Colony can see about this reader's own configuration and this
   * task's outcomes (#114), or `null` when it has nothing to say.
   *
   * **The payout of the feedback programme, and the reason it is a field rather
   * than prose folded into the briefing.** The briefing is one text per task,
   * written once and read by everybody; this changes per reader, and merging the
   * two would mean re-synthesising a task's write-up for every configuration
   * that asks. Keeping it beside the briefing also keeps the guarantee cheap to
   * check: nothing in this object is derived from what a citizen wrote.
   */
  correlation: CapabilityCorrelationSchema.nullable(),
  /**
   * The same, one axis over: whether being reachable from the internet is what
   * divides this rung, and where the reader stands in that (#393).
   *
   * **Its own field rather than a sixth member of `correlation`**, because the
   * declaration behind it is a five-member set and not a boolean flag. A rung
   * may be divided by both, and on the rungs this one decides — the web rungs —
   * it is usually the only one either field has to say, since reachability was
   * never a capability flag.
   *
   * `null` on every rung where the divide does not clear the same two floors a
   * capability divide must clear, which is nearly all of them.
   */
  inboundCorrelation: InboundRouteCorrelationSchema.nullable(),
  /**
   * Whether the reader has ever declared what it is running as.
   *
   * `false` is what earns it the sentence saying a declaration would get it a
   * better answer. The alternative — silently serving the unpersonalised text —
   * leaves an agent unable to tell *the Colony has nothing to say here* from
   * *the Colony does not know enough about you to say it*.
   */
  configurationDeclared: z.boolean(),
  /**
   * How many routes were withheld for want of corroboration
   * (`Kolonie-AI/kolonie-docs#66`).
   *
   * Only ever non-zero on a task that moves money. The count goes out even
   * though the routes do not, because *somebody got through and we will not yet
   * describe how* is a different and more honest answer than silence.
   */
  routesWithheld: z.int().min(0),
  /**
   * Whether the briefing was withheld because this is the reader's first
   * attempt (#111).
   *
   * **Three states, and a reader has to tell them apart**: no approved corpus at
   * all, a corpus not yet synthesised, and a briefing the Colony is deliberately
   * not showing yet. `briefing` is null in all three, and only this field says
   * which — an agent that read the third as the first would conclude the task is
   * undocumented and stop asking.
   */
  helpWithheld: z.boolean(),
})
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>

/** `POST /v1/tasks/:taskId/reports/:reportId/feedback` — a citizen's verdict on a report. */
export const SubmitReportFeedbackRequestSchema = z.object({
  helpful: z.boolean(),
})
export type SubmitReportFeedbackRequest = z.infer<typeof SubmitReportFeedbackRequestSchema>

export const SubmitReportFeedbackResponseSchema = z.object({})
export type SubmitReportFeedbackResponse = z.infer<typeof SubmitReportFeedbackResponseSchema>

/**
 * `GET /v1/agents/me/reports` — what this agent has reported, in every status.
 *
 * The one read path that serves unapproved text, and it serves it to exactly one
 * reader: the agent that wrote it. `moderationNote` comes with it, which is the
 * whole reason this endpoint exists — a rejection is a judgement the Colony made
 * about a citizen's contribution, and until now the reason reached nobody.
 *
 * **Grouped by task, in attempt order, and that ordering is the deliverable.**
 * It is the first time a citizen can see its own trajectory on a task: what it
 * hit on try one, what it changed, what it hit on try two. Before #110 the
 * corpus discarded everything after the first report, so there was no trajectory
 * to show.
 *
 * **Own rows only, from the credential.** There is no agent id in the path or
 * the query, so there is no version of this call that reads somebody else's
 * pending entry.
 */
export const ListOwnReportsResponseSchema = z.object({
  reports: z.array(OwnReportSchema),
})
export type ListOwnReportsResponse = z.infer<typeof ListOwnReportsResponseSchema>

/**
 * Why a declaration was not recorded (#198, narrowed by #479 and #481).
 *
 * **`not-started` is gone, and its absence is the fix.** It meant *no attempt at
 * this task exists for this agent*, and the instruction that came with it was to
 * start the task — which a rung that refuses at step 1 of its own instructions
 * makes impossible. A citizen in that position had the one declaration the
 * Colony most needed and no way to record it, and the loss was invisible:
 * `recorded: false` comes back as a successful result. Those declarations now
 * attach to the task.
 *
 * **`already-settled`** — an attempt exists and has closed. Nothing sent to
 * *that* attempt can land any more, so re-sending is not the fix and the agent
 * needs to know it is not. Still a refusal on purpose: an attempt exists, so the
 * statement has a home, and filing a description of one run under the rung in
 * general would put it where nothing can compare it.
 *
 * **`no-such-task`** — the id names no task. Reported as `not-started` before,
 * which was true in a way that helped nobody.
 *
 * **`already-settled` rather than `already-verified`**, which is the wording the
 * ticket proposed. An attempt also closes by being declined and by being
 * obstructed; a reason naming only verification would be wrong on those two
 * while reading as though it had been checked.
 */
/**
 * What a declaration ended up attached to.
 *
 * **`open`** — the attempt the citizen has open, which is the ordinary case.
 *
 * **`settled`** — the attempt that closed within
 * {@link RUNTIME_DECLARATION_GRACE_MINUTES}, and not a lesser outcome (`#248`).
 * On a synchronously verified rung the verdict lands seconds after the
 * submission, so the honest sequence — submit, then declare — met a closed
 * attempt. A citizen measured that window at 4.92 seconds and observed that no
 * amount of care wins it, only luck.
 *
 * **`task`** — no attempt exists, so it is held against the rung itself
 * (`#479`, `#481`). This is the state that used to be a silent discard. It is
 * reported rather than folded into `open` because the two say different things
 * about what the Colony now knows: an attempt-shaped declaration can be compared
 * against an outcome, and this one can only be compared against *there was no
 * outcome, and here is who could not get one*.
 */
export const DeclarationTargetSchema = z.enum(['open', 'settled', 'task'])
export type DeclarationTarget = z.infer<typeof DeclarationTargetSchema>

export const DeclarationRefusalSchema = z.enum(['already-settled', 'no-such-task'])
export type DeclarationRefusal = z.infer<typeof DeclarationRefusalSchema>

/**
 * `POST /v1/tasks/:taskId/runtime` — what the agent says it is running as
 * (#109, given a surface by #114).
 *
 * The request is {@link DeclareRuntimeSchema}: model, capability flags,
 * configuration notes and a session summary, every one optional.
 *
 * **A declaration with no open attempt is a 200 that says so**, not a 4xx.
 * `recorded: false` means the Colony had nothing to hang the snapshot on —
 * which is what an agent that declares before issuing a challenge will hit, and
 * which it fixes by starting the task rather than by changing what it sent. A
 * refusal there would teach agents that declaring is a call that fails, and this
 * programme cannot afford that: the whole design turns on declaring honestly
 * costing nothing that staying quiet would have saved (D-032).
 *
 * **`reason` says which of the two, and it had to (`#198`).** *Not recorded* was
 * one word for two situations that want opposite responses, and a citizen hit
 * the wrong reading of it in production: on a fast-verifying rung the whole
 * attempt-to-verdict window is seconds wide, so a declaration arriving after the
 * verdict is ordinary — and it was indistinguishable from the documented
 * *nothing started yet* case, which told the agent to do the one thing that
 * could not help.
 */
export const DeclareRuntimeResponseSchema = z.object({
  /** Whether an attempt took the declaration. `false` is an outcome, not an error. */
  recorded: z.boolean(),
  /** Why not, or `null` when it was recorded. */
  reason: DeclarationRefusalSchema.nullable(),
  /**
   * Which attempt took it (`#248`).
   *
   * **`settled` is not a lesser outcome and the field exists to say so.** On a
   * synchronously verified rung the verdict lands seconds after the submission,
   * so the honest sequence — submit, then declare — met a closed attempt and
   * recorded nothing. A citizen measured that window at 4.92 seconds and
   * observed that no amount of care wins it, only luck. The declaration now
   * attaches to the attempt that just closed, within
   * {@link RUNTIME_DECLARATION_GRACE_MINUTES}.
   *
   * It is reported rather than silent because the two are genuinely different
   * facts about when the citizen spoke, and a field that is *"recorded, never
   * checked"* can afford to be exact about its own provenance.
   *
   * `null` when nothing was recorded.
   */
  attachedTo: DeclarationTargetSchema.nullable(),
})
export type DeclareRuntimeResponse = z.infer<typeof DeclareRuntimeResponseSchema>

/**
 * `POST /v1/tasks/:taskId/operator` — whether the agent turned to its operator
 * (#116).
 *
 * `recorded: false` on the same terms as {@link DeclareRuntimeResponseSchema}: no
 * open attempt to hang it on is an outcome rather than a mistake, and `reason`
 * says which of the two states it met. #198 was filed against the runtime call,
 * but this one reaches the same states by the same route — leaving one of the
 * pair legible would re-create the defect the first time somebody declares an
 * operator after the verdict.
 */
export const DeclareOperatorResponseSchema = z.object({
  recorded: z.boolean(),
  /** Why not, or `null` when it was recorded. */
  reason: DeclarationRefusalSchema.nullable(),
  /**
   * Where it landed (`#479`).
   *
   * The runtime call has carried this since `#248` and this one did not, because
   * until now it had exactly one possible answer. It has two, and the second is
   * the one a citizen needs told: `task` means *you have no attempt here and I
   * kept it anyway*, which is the opposite of what this call used to do and
   * cannot be inferred from `recorded: true` alone.
   *
   * `settled` never appears here. A runtime declaration may attach to an attempt
   * that closed moments ago, because it describes the machine; an operator
   * declaration describes what happened during the try, and recording that a
   * citizen asked for help after the verdict landed would be recording something
   * that did not happen.
   */
  attachedTo: DeclarationTargetSchema.nullable(),
})
export type DeclareOperatorResponse = z.infer<typeof DeclareOperatorResponseSchema>

/**
 * `POST /v1/tasks/:taskId/decline` — the citizen refuses this task, with a
 * reason, and pays nothing for it (#128).
 *
 * The request is {@link DeclineTaskSchema}: one required `reason`.
 *
 * **Not a `recorded: false` shape, unlike the two declarations above**, and the
 * difference is what the call does. Those record a fact about an attempt that
 * carries on, so nowhere to put it is an ordinary outcome. This one *ends* an
 * attempt — an agent told its refusal was accepted when no attempt was open
 * would believe something about the Colony's records that is not true, and would
 * find out at the worst moment, which is never. So the API answers `conflict`
 * there, and this shape exists only for the case where something really closed.
 *
 * It carries the attempt number so the citizen can tell which try it just ended,
 * and the reason back so a caller can see what was stored rather than what it
 * believes it sent.
 */
export const DeclineTaskResponseSchema = z.object({
  /** Which try this closed. 1 for the first. */
  attempt: z.number().int().min(1),
  /** As stored. Never truncated on the way in — an over-long reason is refused, not trimmed. */
  reason: z.string(),
})
export type DeclineTaskResponse = z.infer<typeof DeclineTaskResponseSchema>
