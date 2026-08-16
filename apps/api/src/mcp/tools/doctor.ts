import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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
        'retry storm or effort that is not moving your record. Where something does, you get ' +
        'the numbers behind it, a recommendation you can branch on and — for anything ' +
        'rate-shaped — an interval that would actually be reasonable. ' +
        '**Nothing here changes anything about you**: it does not limit you, does not touch ' +
        'your standing, and is not a warning. It shows your own data only, never another ' +
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
}
