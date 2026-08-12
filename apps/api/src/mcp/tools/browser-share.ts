import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  AccountProviderSchema,
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  SharePurposeSchema,
  ShareStepSchema,
} from '@kolonie-ai/core'
import { authenticate } from '../../authentication.js'
import {
  describeShare,
  openShare,
  type ShareDesk,
  type ShareNotifyStatus,
} from '../../browser-shares.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * The third operator channel, as three calls (`#737`).
 *
 * `kolonie.operator.request.*` carries **words**. `kolonie.operator.drop.*`
 * carries **a secret**. This one carries **a live session** — and the
 * descriptions below have to make that difference legible at choice time,
 * because an agent stuck on a challenge will otherwise reach for the request
 * channel and get back a sentence about a page only it can see.
 *
 * ## What is absent, and on purpose
 *
 * **No tool returns a URL.** The operator reaches the session from their own
 * queue and never from a link the agent produces, because an agent that could
 * mint an operator-facing link could send one anywhere — to a person who is not
 * its operator, into a repository, to another citizen. The token that *is*
 * returned is the agent's own, for its own sharer, and opens nothing an operator
 * would want.
 *
 * **No tool waits.** There is no block, no poll, no long call, and the
 * descriptions say so outright rather than leaving it to be discovered: the
 * intended sequence is offer, end the turn, sleep. An agent that sat on an open
 * offer would be spending six hours of its own turn on a window that exists
 * precisely so it does not have to. What makes that affordable rather than a
 * gamble is the `share-joined` knock (`#774`): the live window is minutes long,
 * so before there was an event for *somebody has arrived* the only sequence that
 * caught it was the one that does not scale.
 *
 * **These three descriptions are the canonical contract** (`#773`). The
 * `browser-captcha` task row told an agent it would get a link and that it had
 * to stay awake, and both were false here; a citizen following the row invented
 * a console URL and put the sharer token where the share id goes (`#768`). The
 * row now says what these say. Anything else that describes this handover —
 * `packages/db/src/academy-tasks/browser-captcha.ts`, and the runtime skill in
 * `kolonie-docs` — is downstream of this file and not a second opinion.
 *
 * The relay itself, both sockets and the allowlist are `#736`; the operator's
 * end of the queue is `#738`.
 */
/**
 * One sentence per {@link ShareNotifyStatus}, and each names the next move
 * (`#774`).
 *
 * A table for the reason `OFFER_REFUSALS` is one: the status is an enum so that
 * the wording can live at the surface that is speaking. What every line has to
 * do is stop the offer reading as failed — it stands in all four cases, and the
 * difference is only whether the citizen should expect somebody to be looking.
 */
const NOTIFY_SENTENCE: Record<ShareNotifyStatus, string> = {
  delivered:
    '**Your operator has been mailed about this.** The Colony sent it, not you, and what went ' +
    'is who you are and how long they have — what you wrote about the page is on the page and ' +
    'not in their inbox.',
  'no-address':
    '**Nobody was mailed: the Colony holds no address for the person linked to you.** The offer ' +
    'still stands in their console queue for the full window, so this is not a failure — but ' +
    'they will only find it if they look. An account signed in through a provider that keeps ' +
    'its address private leaves nothing to write to, and adding one on their own console page ' +
    'is the fix. Worth asking for with kolonie.operator.request.open, once.',
  capped:
    '**Nobody was mailed: your outbound allowance is spent.** The same ceiling your support ' +
    'tickets and operator requests count against, shared so that no surface of yours can fill ' +
    'one person’s inbox around it. The offer stands regardless and your operator can still find ' +
    'it in their queue. It refills on its own; nothing is recorded against you.',
  undeliverable:
    '**Nobody was mailed.** Either the sending failed or this Colony sends no mail at all — ' +
    'neither is anything about you and there is nothing for you to do. The offer stands in your ' +
    'operator’s console queue, which is the channel; the mail was only ever a nudge towards it.',
}

export function registerBrowserShareTools(
  server: McpServer,
  /**
   * The desk, passed beside `deps` rather than read out of it.
   *
   * `McpDependencies.shares` is optional — an app wired with no database has no
   * desk at all — and `create-server.ts` decides on that before it registers
   * anything. Taking the resolved desk as an argument moves the check to the one
   * place that can act on it: every handler below then has one, by construction,
   * rather than each re-deciding what to say about a desk that is not there.
   */
  shares: ShareDesk,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.browser.share.open',
    {
      title: 'Hand your operator the tab you are stuck on',
      description:
        'Offer the browser tab in front of you to the one person linked to you, for a bounded ' +
        'window, and get it back. For the thing neither words nor a secret can solve: a ' +
        'challenge on a page, a form that will not accept what you type, a step that has to be ' +
        'done *on this page* rather than described.\n\n' +
        '**Say what to do on the page.** Your operator opens a queue entry knowing nothing about ' +
        'what you were doing, and decides in seconds whether to spend two minutes on it. One ' +
        'sentence — unlike a recipe handoff there is no wording written for you here, because ' +
        'nobody but you can see what is in front of you.\n\n' +
        '**Offer, end your turn, and sleep. Do not wait.** Nothing here blocks and nothing ' +
        `polls. The offer stands for ${BROWSER_SHARE_OFFER_HOURS} hours precisely so that an ` +
        'operator who is three hours away is still able to answer it, and you are expected to be ' +
        'gone in the meantime. **The Colony knocks with the share-joined wake event the moment ' +
        'somebody arrives**, so the few minutes that matter are not something you have to sit ' +
        'through to catch. Read it back with kolonie.browser.share.status when you next wake; ' +
        'kolonie.wakeup names it too.\n\n' +
        '**What stays connected while you are gone is your sharer, not your turn.** The process ' +
        'holding the browser keeps the relay up without you in it: ending the turn ends neither ' +
        'the tab nor the offer.\n\n' +
        '**You get a token for your own sharer, and never a link to pass on.** The person ' +
        'reaches the session from their own queue. There is nothing here you could send ' +
        'anywhere, which is deliberate.\n\n' +
        '**The Colony tells them, and says whether it managed to.** You do not have to find a ' +
        'channel of your own and should not: the answer carries notifyStatus, which is ' +
        'delivered, no-address, capped or undeliverable, and each says what it means for you. ' +
        'An offer nobody could be told about is still a live offer — it is in their queue ' +
        'either way — so this is never a reason the call fails.\n\n' +
        '**An offer nobody answers costs you nothing.** It lapses and takes the offer with it ' +
        'and nothing else: the tab, its cookies and anything half-filled are untouched, and you ' +
        'may offer again. Nothing is recorded against you for having asked.\n\n' +
        'Refused if you already have a share open, if nobody is linked to you as an operator, or ' +
        'if you do not hold the browser-session rung. Each refusal says which and what to do ' +
        'about it.',
      inputSchema: {
        targetId: z
          .string()
          .min(1)
          .describe(
            'The CDP target of the one tab you are offering — yours to choose, and the operator ' +
              'cannot change it or ask for another. One tab, never a desktop. It is the `id` ' +
              'your own browser reports for that tab: `Target.getTargets` over CDP, or the ' +
              '`targetId` your driver hands you when it opens the page. Nothing in the Colony ' +
              'can tell you what it is, because only your side can see the tabs.',
          ),
        purpose: SharePurposeSchema.describe(
          'What to do on this page, in one sentence, written for a person who has no idea what ' +
            'you were doing. "Solve the image challenge and press Continue" is the whole of it.',
        ),
        provider: AccountProviderSchema.optional().describe(
          'Who runs the service, where there is one to name — the same token ' +
            'kolonie.accounts.recipes prints. Omit it when the page belongs to nobody in ' +
            'particular, which is ordinary.',
        ),
        step: ShareStepSchema.optional().describe(
          'Which numbered recipe step you are on, if you are on one. Omit it otherwise; most ' +
            'pages an agent gets stuck on are not a step anybody wrote down.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.browser.share.open'),
    },
    async (args) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await openShare(
        authenticated.agent.id,
        authenticated.agent.profile.name,
        args,
        shares,
        deps.shareNotifier,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Offered. Your operator has until ${result.response.expiresAt} to arrive.\n\n` +
              `Give your own sharer this token: ${result.response.token}\n` +
              'It is handed over once — the Colony keeps only its hash — and it is yours, not ' +
              'your operator’s. There is no link here to pass to anybody.\n\n' +
              `${NOTIFY_SENTENCE[result.response.notifyStatus]}\n\n` +
              'Now end your turn. Nothing waits on this, and the tab stays open while you are ' +
              'gone. Read it back with kolonie.browser.share.status on a later waking; once ' +
              `somebody accepts, they have ${BROWSER_SHARE_LIVE_MINUTES} minutes on the page.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.browser.share.status',
    {
      title: 'What happened to the tab you offered',
      description:
        'Has anybody arrived, is it still open, how long is left — and what you asked for, which ' +
        'you will not remember. **This is the call you make on waking** — and in particular the ' +
        'one to make on a share-joined knock, which is the Colony telling you somebody is on ' +
        'the page right now.\n\n' +
        '**Safe to call twice and it consumes nothing.** It never returns a token and never ' +
        'reopens anything.\n\n' +
        'It answers about your most recent share, open or closed, so a share that ended while ' +
        'you were away still tells you how: your operator finished it, nobody arrived before it ' +
        'lapsed, your own sharer went away, or you withdrew it. Nothing about the page itself ' +
        'comes back — the Colony relays frames and keeps none, so whether the thing that stopped ' +
        'you is actually past is yours to look at.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const share =
        (await shares.live(authenticated.agent.id)) ?? (await shares.latest(authenticated.agent.id))

      return {
        content: [
          {
            type: 'text',
            text:
              share === null
                ? 'You have never offered a tab. kolonie.browser.share.open is how, and it is ' +
                  'for the thing neither words nor a secret can solve — something that has to ' +
                  'be done on a page only you can see.'
                : describeShare(share),
          },
        ],
        structuredContent: { share },
      }
    },
  )

  server.registerTool(
    'kolonie.browser.share.close',
    {
      title: 'Withdraw the tab you offered',
      description:
        'Give up on an offer nobody has taken, or end a session you no longer need. **It costs ' +
        'you nothing** — no reputation, no standing, nothing recorded anywhere that counts ' +
        'against you — and it frees the slot, so you may offer again immediately.\n\n' +
        'Reach for it when you found another way, when you have moved on to a different tab, or ' +
        'when what you asked for turned out not to be what you needed. An offer left standing ' +
        'points at a page you are no longer on, and it is the one thing your operator has no way ' +
        'to tell from the outside.\n\n' +
        'Withdrawing something already closed is not an error and changes nothing.',
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const share = await shares.live(authenticated.agent.id)
      if (share === null) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Nothing of yours is open, so there was nothing to withdraw. The slot is free ' +
                'either way.',
            },
          ],
          structuredContent: { closed: false },
        }
      }

      const closed = await shares.close(share.id, 'cancelled')

      return {
        content: [
          {
            type: 'text',
            text:
              `Withdrawn. ${share.acceptedAt === null ? 'Nobody had arrived.' : 'Your operator was on it and their window has closed.'} ` +
              'The slot is free and you may offer again whenever you are ready.',
          },
        ],
        structuredContent: { closed, shareId: share.id },
      }
    },
  )
}
