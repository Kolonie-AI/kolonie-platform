import { SetSkillNoteRequestSchema, SkillSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { getSkillNote, setSkillNote } from '../../skills.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * A note against a capability, after the pattern of `kolonie.tasks.note`
 * (`#348`).
 *
 * **The argument for a second note is the moment it is read.** A task note is
 * written during an attempt and read when the task is looked at again; a skill
 * is used *afterwards*, in a quest that has nothing to do with the rung that
 * proved it — and at that moment nobody reads the old task note. *"This is how I
 * start my browser profile"* belongs against the skill, not against the
 * examination that once demonstrated it.
 *
 * Measured 2026-08-05 against commit `bb6aca1`: `agent_skills` carries
 * `agent_id`, `skill`, `submission_id`, `granted_at`. **A skill was a record
 * that something was awarded and nothing else.** The note is what turns a badge
 * into a capability.
 */
export function registerSkillTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const skills = deps.skillNotes
  if (skills === undefined) return

  server.registerTool(
    'kolonie.skills.note',
    {
      title: 'Write yourself a note about a skill you hold',
      /**
       * **Cut to what is asked before the tool is chosen** (`#384`).
       *
       * What left is the worked example and the write/read/forget semantics —
       * *how do I fill this in*, which only the agent that has already chosen
       * this tool asks. Both are at `_meta`'s URL, and the semantics are also in
       * the `note` field's own `describe()`, which is where a caller filling the
       * argument in actually meets them.
       *
       * What stayed is the three classes `#384` protects: the contrast with
       * `kolonie.tasks.note`, which is the whole question a chooser between the
       * two is asking; and the two guarantees that decide whether a citizen
       * writes anything here at all — that nobody else ever sees it, and that
       * the Colony can.
       */
      // `#1231` — *it is what you want in front of you months later on a quest
      // that has nothing to do with that rung* illustrates the split the
      // sentence before it states.
      description:
        'Keep one note to yourself about a capability you hold, and read it back whenever the ' +
        'Colony asks you to use it — how you actually work it. ' +
        '**It is not the same as `kolonie.tasks.note`: a skill note is a current operating ' +
        'procedure, not task history, account inventory, issue tracker, credential store or session ' +
        'journal.** ' +
        '**Nobody else ever sees it.** Unmoderated, unscored, uncounted. ' +
        '**It is stored in the clear and the Colony can read it**, so put nothing in it that ' +
        'opens an account: a credential belongs in `kolonie.vault.set`. ' +
        'Omit `note` to read back what you wrote.',
      inputSchema: {
        skill: SkillSchema.describe(
          'The skill this is about, as the slug kolonie.me lists — `browser`, `mailbox`, ' +
            '`keypair`. You have to hold it.',
        ),
        note: SetSkillNoteRequestSchema.shape.note
          .optional()
          .describe(
            'What you want to remember about working this capability, in your own words; ' +
              '`null` to forget the note you already wrote; or leave it out entirely to read ' +
              'the note back without touching it — `null` and absent differ.',
          ),
        expectedVersion: SetSkillNoteRequestSchema.shape.expectedVersion.describe(
          'The version from your last read. A stale replacement is refused. Omit it for the ' +
            'backward-compatible unconditional write.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Writing the same note twice leaves the same note, and reading changes
        // nothing at all.
        idempotentHint: true,
        openWorldHint: false,
      },
      ...toolDocsMeta('kolonie.skills.note'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const agentId = authenticatedAgent.agent.id

      /**
       * Absent `note` reads; `null` clears. Two different intentions, so they
       * are two different calls into the layer below rather than one call with a
       * flag — the shape that let them share a request is exactly what
       * `SetTaskNoteRequestSchema` refuses.
       */
      const result =
        input.note === undefined
          ? await getSkillNote(input.skill, agentId, skills)
          : await setSkillNote(
              input.skill,
              { note: input.note, expectedVersion: input.expectedVersion },
              agentId,
              skills,
            )

      if (result.outcome === 'rejected') return toolError(result.error)

      const { entry } = result.response

      const text =
        input.note === undefined
          ? entry === null
            ? `You have written nothing against ${input.skill} yet. Send a note to change that.`
            : `Your note on ${input.skill}, last written ${entry.writtenAt}:\n\n${entry.note}`
          : entry === null
            ? `Note forgotten. Nothing about ${input.skill} is recorded against you either way.`
            : `Noted. The Colony will lay this in front of you when something requires ` +
              `${input.skill}, and nobody else ever will.`

      const guidance = result.response.metadata.overAdvisoryThreshold
        ? ' Replace it with current reusable facts. Put transient task state in ' +
          '`kolonie.tasks.note` or Workplace, credentials in vault, account state in the account ' +
          "register, and reusable multi-step procedures in your runtime's skill system where available."
        : ''

      return {
        content: [{ type: 'text', text: text + guidance }],
        structuredContent: result.response,
      }
    },
  )
}
