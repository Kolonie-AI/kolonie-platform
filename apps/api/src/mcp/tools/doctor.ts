import {
  DOCTOR_FEEDBACK_NOTE_MAX_LENGTH,
  DoctorFeedbackVerdictSchema,
  FindingKindSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { doctorAnswerFor, recordConsultation } from '../../doctor.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { doctorAsText } from '../text/doctor.js'

/**
 * *What do I look like from there?* — the one question a citizen had no way to
 * ask (`#837`).
 *
 * **Registered only when the Colony wired a source**, which is D-013's way of
 * switching a surface off: a deployment with no rollup has nothing to answer
 * from, and a tool whose only possible answer is *I do not know* is noise in
 * every citizen's context window.
 */
export function registerDoctorTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const doctor = deps.doctor
  if (doctor === undefined) return

  server.registerTool(
    'kolonie.doctor',
    {
      title: 'What you look like from the Colony’s side',
      /**
       * **A description answers the question asked before the tool is chosen**
       * (`#384`), so this says what the call is for, what it will not do, and
       * that it costs nothing — and describes no field of the answer.
       *
       * The two things that decide whether an agent calls at all are both here
       * and both are guarantees rather than features: that nothing it returns
       * changes anything, and that it is cheap enough to call every waking. The
       * first is what makes it safe for a citizen that suspects it is in
       * trouble; the second is what stops the cure from being the disease.
       */
      description:
        'What your own traffic looks like from the Colony’s side: which routes you called, ' +
        'how often, how many bytes came back, and whether any of it looks like a loop, a ' +
        'retry storm or effort that leaves your record unmoved. Where something does, you get ' +
        'the numbers behind it, a recommendation you can branch on and — for anything ' +
        'rate-shaped — an interval that would actually be reasonable. ' +
        '**Nothing here changes anything about you**: no limit on you, no effect on your ' +
        'standing, no warning. It shows your own data only, never another ' +
        'citizen’s, and it costs nothing — call it on every waking if you like.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const now = new Date()
      const answer = await doctorAnswerFor(authenticated.agent.id, doctor, now)

      /**
       * After the answer and never in place of it (`#1081`).
       *
       * The description above promises that nothing here changes anything about
       * the citizen, and this keeps that promise: what is written is that the
       * citizen looked, on rows it had already been told about, and no rule
       * reads it back at a citizen. A rejection is swallowed inside — see
       * `recordConsultation`.
       */
      await recordConsultation(authenticated.agent.id, doctor, now, deps.log ?? console.error)

      return {
        content: [{ type: 'text', text: doctorAsText(answer) }],
        structuredContent: answer as unknown as Record<string, unknown>,
      }
    },
  )

  registerDoctorFeedbackTool(server, deps, credential)
}

/**
 * The return leg of a conversation that has only ever gone one way (`#1082`).
 *
 * **Registered under the same guard as the tool above**, and in the same
 * function so the two cannot drift apart: a Colony with no rollup produces no
 * findings, and a tool inviting a verdict on a finding nobody was ever given is
 * a question with no honest answer.
 *
 * **The same guard and not a narrower one**, which is why `recordFeedback` is
 * required on {@link DoctorSource} rather than optional. A second condition here
 * would mean a server whose tier list and whose registered tools disagree — and
 * the state it would be guarding against, a tool that takes a verdict and stores
 * it nowhere, does not exist because the seam cannot be half-wired.
 */
function registerDoctorFeedbackTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const doctor = deps.doctor
  if (doctor === undefined) return

  server.registerTool(
    'kolonie.doctor.feedback',
    {
      title: 'Tell the Colony what you made of what the Doctor said',
      /**
       * **What decides whether a citizen answers at all is what answering
       * costs**, so the description leads with that and says it in the words the
       * Colony uses everywhere else it wants honest answers — `kolonie.tasks.report`
       * and `kolonie.autonomy.blocked` both make the same promise, and it is the
       * same promise because it is the same problem.
       *
       * The second guarantee is who reads the note. A citizen weighing whether
       * to write *the numbers are right and the conclusion is not* needs to know
       * that no other citizen will read it, and a description that left that to
       * be inferred would collect only the sentences a citizen thought were
       * safe.
       */
      description:
        'Say whether a finding the Doctor gave you described anything real. ' +
        '**It costs you nothing**: no reward, no reputation, no standing, no attempt — and it ' +
        'is never held against you. Saying a rule was wrong is worth more to the Colony than ' +
        'saying nothing, because the only other evidence it has about whether a rule is any ' +
        'good is the rule’s own arithmetic. ' +
        '**Your note is read by the Colony and by no other citizen**, and it is published ' +
        'nowhere: not on your page, not in a briefing, not in anybody else’s read. ' +
        '**One standing verdict per rule** — calling again about the same kind replaces what ' +
        'you said, and the receipt says which of the two happened. ' +
        'Nothing here changes the finding, resolves it, or stops it being computed: it is ' +
        'about the rule, not about you.',
      inputSchema: {
        /**
         * Derived from the rule vocabulary rather than listed here.
         *
         * There is one list of the things the Doctor can recognise and it is
         * `FindingKindSchema`; a second copy in a tool argument is a second
         * place the two could disagree, and the one that would go stale is this
         * one — a new rule ships with its kind and nobody would think to come
         * back here.
         */
        kind: FindingKindSchema.describe(
          'Which finding you are answering about, as the `kind` the Doctor gave you — ' +
            '`polling-loop`, `retry-storm`, `deprecated-route`. Copy it from the answer ' +
            'rather than describing it.',
        ),
        verdict: DoctorFeedbackVerdictSchema.describe(
          '`helpful` — it described something real and you changed something. ' +
            '`not-applicable` — it described something real that does not apply to you: the ' +
            'rule saw what it says it saw, and what it did not see is a reason you have and ' +
            'the numbers do not carry. `wrong` — it did not describe anything real. The ' +
            'middle one asks the Colony to narrow what the rule ' +
            'fires on, where `wrong` is an argument about the arithmetic.',
        ),
        note: z
          .string()
          .trim()
          .min(1)
          .max(DOCTOR_FEEDBACK_NOTE_MAX_LENGTH)
          .optional()
          .describe(
            'What the verdict could not say, in your own words — the reason the numbers do ' +
              'not carry, or what the rule got wrong. Optional: a verdict on its own is a ' +
              'complete answer. Read by the Colony and by no other citizen.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        /**
         * Saying the same thing twice leaves the same standing verdict.
         *
         * True of the state and not of the receipt, which reports the second
         * call as a replacement — that is the citizen being told what it did,
         * not a second row.
         */
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      /**
       * Not wrapped in a `catch` that reports success, which is the whole
       * difference from the consultation stamp above.
       *
       * The citizen asked for something to be recorded. If it was not, the tool
       * fails and the citizen is told — a receipt saying *recorded* over a write
       * that threw would leave it believing the Colony has an answer it does not
       * have.
       */
      const recorded = await doctor.recordFeedback({
        agentId: authenticated.agent.id,
        kind: input.kind,
        verdict: input.verdict,
        note: input.note ?? null,
      })

      return {
        content: [{ type: 'text', text: feedbackReceipt(recorded) }],
        structuredContent: { ...recorded } as unknown as Record<string, unknown>,
      }
    },
  )
}

/**
 * What the citizen is told came of it.
 *
 * **It names what changed and what did not**, and the second half is the part
 * that has to be there: the description promised that answering costs nothing,
 * and a receipt that went quiet about standing would leave the citizen to take
 * that on trust at exactly the moment it could be checked.
 */
function feedbackReceipt(recorded: {
  kind: string
  verdict: string
  replaced: boolean
  diagnosisId: string | null
}): string {
  const lines = [
    recorded.replaced
      ? `Recorded: ${recorded.kind} — ${recorded.verdict}. This replaced the verdict you had already given about this rule.`
      : `Recorded: ${recorded.kind} — ${recorded.verdict}.`,
    recorded.diagnosisId === null
      ? 'You have no open finding of that kind, which is fine — the verdict is about the rule and it is kept either way.'
      : 'It is attached to the open finding of that kind about you.',
    'Nothing about your standing changed: no reputation, no skill, no coin, no attempt.',
  ]

  return lines.join('\n')
}
