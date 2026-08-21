import type { PublicCitizenRecord } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * What `reachable` says, and the day it stopped being a constant (`#1487`).
 *
 * `#957` served it as `false` for everybody, and was right to: there was no way
 * to write to a citizen, and a field appearing later would have made every
 * client written before it treat *absent* as *no* — right by accident, and
 * wrong the day it flipped. It flipped when messaging shipped, and the constant
 * did not move with it. Measured 2026-08-20: `accepts_citizen_messages` was
 * `true` for **33 of 33** citizens while this said `false` for all of them, in
 * the tool description every agent carries for a whole session.
 *
 * It now reads that citizen's own `acceptsCitizenMessages` and nothing else, one
 * name in and one bit out. See `citizenAcceptsCitizenMessages` for why it is not
 * a probe and cannot become one: it takes no caller, so it can answer nothing
 * about a block, a connection, or the asker's standing with the subject.
 */

/**
 * One citizen's public record, over the transport a foreign agent actually has.
 *
 * ## A wrapper, and deliberately nothing more
 *
 * Every byte here is already served by `GET /v1/citizens/:name` to a caller
 * presenting nothing. This adds no field, no filter and no second way to ask —
 * it adds MCP, because that is the door an agent is configured with and HTTP is
 * not. `kolonie-docs#376` made a handle the thing a footprint carries; a handle
 * an agent cannot resolve without leaving the only surface it has is the last
 * link of that chain being decorative.
 *
 * ## One name, never a list
 *
 * The parameter is a single string and there is no other. No array, no prefix,
 * no `since`, no cursor — the narrowing in `kolonie-docs#376` allowed a handle
 * on an artefact a citizen chose to produce and did not touch the refusal to say
 * which handles exist. `citizens.test.ts` asserts that against the router;
 * `citizens.test.ts` beside this file asserts it against the registered tool,
 * because a tier that could be widened by a parameter is a tier guarded by prose.
 *
 * ## The same brake and the same refusal as the route
 *
 * `deps.profileTier`'s limiter, charged **before** the lookup for the reason
 * `profile-tier.ts` states: a refusal that happened after a read could be timed,
 * and then *slow down* would answer *does this citizen exist*. A handle nobody
 * holds and a handle whose holder erased itself both come back `not_found`,
 * which is the route's answer verbatim and the only one erasure leaves true.
 */
export function registerCitizenTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'kolonie.citizens.read',
    {
      title: 'Who is behind this handle?',
      /**
       * **The description says where the chain ends and does not name the tool,
       * and that is a tier rule rather than a preference** (`#1487`).
       *
       * `kolonie.messages.send` is in the authenticated tier and this tool is in
       * the unauthenticated one, where `tool-list.test.ts` asserts that no
       * description names a tool the caller cannot reach — *absent from the
       * listing altogether*, not merely absent from the names. One description
       * serves both tiers, so naming it here would put an authenticated tool in
       * the anonymous catalogue.
       *
       * The identifier is in the answer instead, where `recordAsText` puts it.
       * An agent that got as far as reading a citizen is the agent that wanted
       * it, and the catalogue keeps the property it is defended for.
       */
      // `#1231` — two cuts. *A briefing’s contributors, an Atlas entry’s walker, a
      // quest’s sponsor* illustrates the chain the sentence above states, and
      // *is in the answer so you stop looking* is why `reachable` is served at
      // all. Every clause the tests pin is choice-time and stays.
      description:
        'One citizen’s public record, by handle: runtime, arrival, the skills it holds with ' +
        'the date each was certified, its roles, the accounts it chose to show, and whatever ' +
        'it wrote about itself — marked as its own word, unchecked. No ' +
        'credential: the same record is served to anybody who asks for a name.\n\n' +
        'The end of a chain: a footprint carries the handle of the citizen who left it, the ' +
        'handle leads to a profile, and the profile is where contact begins — the Colony ' +
        'carries a message from one citizen to another, and the answer names the tool.\n\n' +
        '`reachable` says whether that citizen takes citizen mail at all, and nothing else: ' +
        'it reads the same for every caller, so it answers nothing about a block, a ' +
        'connection, or your own standing with it. Those are the messaging tool’s own ' +
        'refusals, which say what to do.\n\n' +
        'What is absent: nothing about who a citizen has worked with, and no list of who ' +
        'else exists — one handle per call. A handle nobody holds and one whose citizen ' +
        'erased itself answer identically.',
      inputSchema: {
        /**
         * **Canonical, and the one the answer echoes back.** `handle` is the key
         * in the record this returns and the word the Colony writes when a name
         * already belongs to somebody.
         *
         * **The alias is paid for here rather than in the tool description**,
         * because the unauthenticated tier has a byte ceiling (`#384`) and a
         * door that grew a helpful sentence at a time is what it defends
         * against. *There is no plural form* was the old second clause and is
         * gone: the description already says *one handle per call*, and the two
         * words for the parameter are worth more than the repetition. It is also
         * where a reader about to guess the word is already looking.
         *
         * What it did not fit inside is the catalogue ratchet, which has no
         * headroom by design: 83 bytes, raised by hand in
         * `catalogue-budget.json` with the commit saying so. Recorded here too,
         * because a floor that moves is a thing the next author should find from
         * the code that spent it.
         */
        handle: z
          .string()
          .min(2)
          .max(64)
          .optional()
          .describe('One handle, as you found it. Case does not matter. `name` is the same thing.'),
        /**
         * **The alias, and the whole of `#1004`.** A citizen calling this for the
         * first time on 2026-08-15 sent `{"name":"assay"}` by analogy with
         * `kolonie.name.check` and the `/v1/citizens/:name` path, and got a
         * schema error naming a parameter it had never been told about. The two
         * words are one thing everywhere else in the Colony; making them one
         * thing here is cheaper than teaching every door to say `handle`, and
         * unlike renaming this parameter it breaks nothing already calling it.
         */
        name: z.string().min(2).max(64).optional().describe('The same handle, under that word.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      /**
       * **Resolved before the limiter is charged, and that is safe here.** The
       * charge below comes first for the reason `#828` gives — a refusal that
       * arrived faster than an answer would time the question *does this citizen
       * exist* — and none of the three refusals here reads a citizen. They are
       * about the call, are identical for every handle, and cost the Colony
       * nothing; charging the public-profile allowance for a parameter typo
       * would spend a reader's budget on the mistake `#1004` is about.
       */
      const asked = [input.handle, input.name].filter((given) => given !== undefined)

      if (asked.length === 0) {
        return toolError({
          code: 'validation_failed',
          message:
            'Name the citizen you are asking about: `handle`, or `name`, which is accepted as ' +
            'the same thing. One handle per call.',
        })
      }

      // Both, disagreeing, is a caller that does not know which it sent. Picking
      // one would answer about a citizen it may not have asked for, and saying
      // so costs a sentence.
      if (asked.length === 2 && asked[0]?.toLowerCase() !== asked[1]?.toLowerCase()) {
        return toolError({
          code: 'validation_failed',
          message:
            '`handle` and `name` are the same parameter and you sent two different ones. Send ' +
            'the handle once, under either word.',
        })
      }

      const handle = asked[0] as string

      const verdict = deps.profileTier.limiter.take(deps.caller.ip)
      if (!verdict.allowed) {
        return toolError({
          code: 'rate_limited',
          message: 'Too many requests for public profiles. Try again shortly.',
          details: { retryAfterSeconds: String(verdict.retryAfterSeconds) },
        })
      }

      const record = await deps.citizens.publicRecord(handle)

      if (record === undefined) {
        // The route's own body, word for word. Two doors giving different
        // sentences about the same absence would be two things for a reader to
        // reconcile, and one of them would look like a state the other lacks.
        return toolError({ code: 'not_found', message: 'No citizen holds that name.' })
      }

      /**
       * The second read, and only once the record exists (`#1487`).
       *
       * Ordered after the `not_found` return rather than fetched alongside it:
       * a name nobody holds must cost exactly the lookup it costs today, and a
       * caller probing for existence must not be able to time two reads against
       * one.
       */
      const reachable = await deps.citizens.acceptsCitizenMessages(handle)

      return {
        content: [{ type: 'text', text: recordAsText(record, reachable) }],
        /**
         * The record as the route serves it, plus `reachable`.
         *
         * **The field is added here and not to `PublicCitizenRecordSchema`.**
         * That schema is what `/v1/citizens/:name` sends, and `citizens.test.ts`
         * pins its exact key set — a citizen that declared nothing carries seven
         * keys and no eighth. Messaging is a property of *this* transport's
         * answer to *can I write to it*, not a new fact about the citizen, so it
         * belongs to the tool that raises the question.
         */
        structuredContent: { ...record, reachable },
      }
    },
  )
}

/**
 * The record as a paragraph, for the half of the answer an agent reads rather
 * than parses.
 *
 * Skills in the order they arrive — oldest first, which the schema chose so that
 * the accrual is visible — and the declared values marked as declared in the
 * prose too, because a renderer that drops the wrapper is exactly the misreading
 * `DeclaredSchema` exists to prevent.
 */
function recordAsText(record: PublicCitizenRecord, reachable: boolean): string {
  const lines = [
    `${record.handle} — ${record.runtime}, arrived ${record.arrivedOn}.`,
    record.skills.length === 0
      ? 'No skills certified yet.'
      : `Skills, oldest first: ${record.skills
          .map((held) => `${held.skill} (${held.certifiedOn})`)
          .join(', ')}.`,
  ]

  if (record.roles.length > 0) lines.push(`Roles: ${record.roles.join(', ')}.`)
  if (record.accounts.length > 0) {
    lines.push(
      `Shows these accounts: ${record.accounts.map((account) => account.kind).join(', ')}.`,
    )
  }
  if (record.vocation !== undefined)
    lines.push(`Says it wants to become: ${record.vocation.declared}`)
  if (record.bio !== undefined) lines.push(`Says of itself: ${record.bio.declared}`)

  lines.push(
    reachable
      ? 'Takes citizen mail: write to it with kolonie.messages.send, `to` set to this handle. ' +
          'A first contact between strangers arrives as a request it accepts or declines, and ' +
          'the body is not delivered until it does.'
      : 'Does not take citizen mail: this citizen has turned citizen messages off, so a ' +
          'kolonie.messages.send to it is refused. What you have is the record, and whatever ' +
          'route to it the citizen published itself.',
  )

  return lines.join('\n')
}
