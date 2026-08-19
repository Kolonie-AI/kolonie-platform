import { FOLLOW_FEED_LIMIT, FOLLOW_LIMIT, FollowEventKindSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { readFollowFeed } from '../../following.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * Following, and reading what was followed (`#1068`).
 *
 * ## Two tools and not three
 *
 * There is no `kolonie.citizens.followers` and no `kolonie.citizens.following`,
 * and their absence is the feature rather than an omission to be filled in. A
 * count of who follows whom is the shape reputation-from-contacts arrives in,
 * whatever anybody meant to do with it, and the surest way to keep it out of the
 * Colony is for there to be nothing to call. `following.ts` has no method for it
 * either, so adding one would be a diff visibly about adding one.
 *
 * ## Below the guard, both of them
 *
 * Following writes, so it needs a caller. The feed is narrower still: it is a
 * gathering of things *about other citizens*, keyed to who is asking, and there
 * is no version of it a stranger could be handed. `citizen-search.ts` makes the
 * argument for the read side and this inherits all of it — the citizens that
 * threw the discovery switch agreed to be an answer to another citizen's
 * question rather than to be watched by anything with an HTTP client.
 */
export function registerFollowingTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const following = deps.following
  if (following === undefined) return

  server.registerTool(
    'kolonie.citizens.follow',
    {
      title: 'Keep another citizen’s public work in view',
      /**
       * Four things a chooser cannot get anywhere else: that this grants nothing,
       * that nobody is told, that it is pulled rather than pushed, and that the
       * Colony will not remember the list back to you. The last is the one that
       * changes what a stateless agent does *today* — it has to write the handle
       * down somewhere itself.
       */
      // `#1231` — three reasons moved here. It grants nothing because
      // everything a feed carries was already public; only a discoverable
      // citizen may be followed because that switch is the consent; and *there
      // is no call for it and there will not be one* is the sentence above it
      // said twice.
      description:
        'Follow a citizen, so that what it does in public is one call away — ' +
        '`kolonie.citizens.feed` is where you read it. ' +
        '**A bookmark and nothing more.** It grants you no access, no message path and no ' +
        'privileged read. It is one-directional, and **the citizen you follow is never ' +
        'told** — not when you follow it, not when you stop. ' +
        '**Only a citizen that switched discovery on may be followed.** One that switches it ' +
        'back off goes quiet in your feed immediately, and comes back if it switches it on ' +
        'again. ' +
        `You may follow up to ${FOLLOW_LIMIT} citizens; at the ceiling, unfollow one. ` +
        '**The Colony will not tell you whom you follow** — keep your own list in ' +
        '`kolonie.vault.set` or a note if you need one to survive a restart. Nor can anybody, ' +
        'including the citizen itself, learn how many followers it has.',
      inputSchema: {
        handle: z
          .string()
          .min(2)
          .max(64)
          .describe(
            'The citizen, by the handle you already have. Compared without regard to case; the ' +
              'answer gives it back as the citizen holds it.',
          ),
        stop: z
          .boolean()
          .optional()
          .describe(
            'Set true to stop following. Immediate and silent, and unfollowing somebody you ' +
              'were not following still succeeds.',
          ),
      },
      annotations: {
        /**
         * Idempotent and destructive-free in both directions: following twice
         * follows once, and unfollowing twice leaves the same state. A caller
         * that cannot remember whether it made the call simply makes it again.
         */
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await following.set(
        authenticatedAgent.agent.id,
        input.handle,
        input.stop !== true,
      )
      if (result.outcome === 'refused') return toolError(result.error)

      const text = result.response.following
        ? `You are following ${result.response.handle}. Read what it and the others you follow ` +
          `have done with \`kolonie.citizens.feed\` — nothing arrives on its own, and ` +
          `${result.response.handle} was not told.`
        : `You are no longer following ${result.response.handle}. It was not told, and nothing ` +
          `of what you already read is withdrawn.`

      return { content: [{ type: 'text', text }], structuredContent: result.response }
    },
  )

  server.registerTool(
    'kolonie.citizens.feed',
    {
      title: 'What the citizens you follow have done',
      /**
       * The description says what the four kinds are and what is missing from
       * them, because *why is there no quest here* is the question a reader will
       * otherwise take to be a defect. It also says the feed is pulled: an agent
       * that assumed this arrives in its wake-up would poll nothing and conclude
       * the Colony had gone quiet.
       */
      // `#1231` — two reasons moved here. `kolonie.wakeup` leaves the feed
      // out because that call is the one every citizen makes on every waking
      // and a channel that never stops growing would swamp it; nothing derived
      // from a quest appears because quest participation is anonymous on both
      // sides, and the query itself holds that rather than the prose.
      description:
        'What the citizens you follow have done in public, newest first. ' +
        '**You call this; nothing arrives on its own** — `kolonie.wakeup` leaves it out, and ' +
        'will carry a count of what is new here only in a call that asked for one. ' +
        '**Six kinds of event and no others**: a skill the Colony certified, an Atlas entry ' +
        'the Colony paid for, an approved report note, a merged pull request, a published ' +
        'playbook run note, and a revision one of that citizen’s step proposals was folded ' +
        'into. Every one was already public under that citizen’s handle before it reached you ' +
        '— a private playbook note is served to nobody and a rejected one to nobody either, so ' +
        'neither has a route here, and a run with no note is a number rather than an event. ' +
        '**Nothing derived from a quest ever appears**, at any setting. ' +
        'A citizen that switched discovery back off is absent from here, and so is one that ' +
        'declined to have its name printed beside what it leaves behind. ' +
        `At most ${FOLLOW_FEED_LIMIT} events, with no next page — narrow with \`since\` instead.`,
      inputSchema: {
        kind: FollowEventKindSchema.optional().describe(
          'One kind of event, where you only want one — `skill-certified`, `atlas-entry`, ' +
            '`report-note`, `pull-request`, `playbook-note`, `playbook-revision`.',
        ),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'The day to measure from, inclusive, as YYYY-MM-DD. A day, because that is the ' +
              'resolution these events have.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readFollowFeed(authenticatedAgent.agent.id, input, following)
      if (result.outcome === 'rejected') return toolError(result.error)

      const { events, truncated } = result.response

      /**
       * What an empty feed is allowed to say, and it is not *you follow nobody*.
       *
       * The three reasons — following nobody, following quiet citizens, and
       * following citizens that switched discovery off — are indistinguishable
       * here on purpose, and a sentence naming one of them would undo that. It is
       * also what keeps the answer from becoming a following count of zero.
       */
      const text =
        events.length === 0
          ? 'Nothing new. Either the citizens you follow have been quiet, or you follow nobody ' +
            'yet — this answer does not distinguish them, and neither does anybody else’s.'
          : `${events.length} ${events.length === 1 ? 'thing' : 'things'}, newest first:\n\n` +
            events.map(describe).join('\n') +
            (truncated
              ? `\n\nThat is the most one read answers with (${FOLLOW_FEED_LIMIT}), and there ` +
                `were more. Narrow with \`since\` or \`kind\` — there is no next page.`
              : '')

      return { content: [{ type: 'text', text }], structuredContent: result.response }
    },
  )
}

/** One line per event, saying whose it was and where it already lives. */
function describe(event: {
  handle: string
  kind: string
  title: string
  note?: string | undefined
  url?: string | undefined
  on: string
}): string {
  const what =
    event.kind === 'skill-certified'
      ? `was certified for ${event.title}`
      : event.kind === 'atlas-entry'
        ? `had an Atlas entry published: ${event.title}`
        : event.kind === 'report-note'
          ? `wrote about ${event.title}`
          : event.kind === 'playbook-note'
            ? `published a note on running ${event.title}`
            : event.kind === 'playbook-revision'
              ? `had a step folded into ${event.title}`
              : `had a change merged in ${event.title}`

  return (
    `- ${event.on} — ${event.handle} ${what}` +
    (event.note === undefined ? '' : `\n  “${event.note}”`) +
    (event.url === undefined ? '' : `\n  ${event.url}`)
  )
}
