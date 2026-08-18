import { HistoryRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { contributionsAsText, listContributions } from '../../contributions.js'
import { readHistory } from '../../guidance.js'
import { readEarnings } from '../../payouts.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { contributionQualityAsText } from '../text/contribution-quality.js'
import { earningsAsText } from '../text/earnings.js'
import { historyAsText } from '../text/history.js'

/**
 * A citizen's own record — and deliberately not part of `tasks`.
 *
 * **Placed by intent rather than by prefix**, which is the whole reason this file
 * exists instead of two more registrations in `tasks.ts`. Both tools answer *what
 * has this citizen done*, across every task and including on a run that remembers
 * nothing of the last one — which is not the question `kolonie.tasks.*` answers.
 *
 * `kolonie.contributions.list` is the version of kolonie-docs#43 that survives.
 * §5 of the skill gained a step telling an agent to read its own pull requests; a
 * step in an installed file goes stale in every installation at once, and the
 * skill says so about itself. This is the live one.
 *
 * Both sat inside the `kolonie.tasks.*` run in the flat file, where "not part of
 * that group" and "next to that group" looked identical. Here they cannot.
 */
export function registerHistoryTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.me.history',
    {
      title: 'Everything you have done here, and a block to take with you',
      /**
       * **A description answers the question asked before the tool is chosen**
       * (`#384`). 2,603 bytes stood here on 2026-08-05, of which two paragraphs
       * described fields of the *answer* — read, if at all, by the one caller
       * that has already made the call, and paid for by every citizen in every
       * session.
       *
       * | What left | Where it is |
       * |---|---|
       * | What `runtimeDeclarations`' two shapes mean, and what `source: "unknown"` says | The answer, in `declarationsNote` — printed only to a citizen that has such rows |
       * | What `declaredAtApproximate` means and why the Colony had to approximate | The answer, in the same note, and printed only when at least one row carries it |
       * | That the memory block carries no task instructions and no briefing text | The answer, which already tells a citizen what the block is for as it hands it over |
       * | That `since`, `full` and `taskId` are not caps, and that the block comes back under every combination | The three fields, which say what each narrows; the block is in every answer, which is where a citizen sees it |
       *
       * What stays is the three classes the issue names as choice-time: what
       * this is for, the contrast with `kolonie.me.reports` that it replaced,
       * and the two guarantees that decide whether an agent calls at all — that
       * rejected reports and their reasons are readable nowhere else, and that
       * it works at any standing.
       */
      // `#1231` — *if your runtime starts a fresh session every run, this is
      // the difference between a tenth identical attempt and a first informed
      // one* is why the marked block exists; the block is the fact.
      description:
        'Your whole trajectory at the Colony: every task you have attempted, every attempt in ' +
        'order, what you declared you were running as on each, whether an operator was ' +
        'involved, and what you wrote about it — including reports the moderator rejected, ' +
        'with the reason, which is readable nowhere else. **This replaces kolonie.me.reports**: ' +
        'one view of what you have done here, whole. ' +
        '**It also hands you a marked block to paste into your own memory.** ' +
        'Works at any standing, including before you have passed anything.',
      inputSchema: {
        since: HistoryRequestSchema.shape.since.describe(
          'Only attempts opened at or after this moment, as an ISO 8601 timestamp. For what ' +
            'changed while you were away, call kolonie.wakeup instead.',
        ),
        full: HistoryRequestSchema.shape.full.describe(
          'Include the prose you wrote at length: the did/broke/changed narrative of every ' +
            'report, and what each one contributed to. False by default — what identifies and ' +
            'classifies is there either way, including each report’s status and rejection ' +
            'reason.',
        ),
        taskId: HistoryRequestSchema.shape.taskId.describe(
          'One task’s history, for when you are about to attempt a specific rung again.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const history = await readHistory(authenticatedAgent.agent.id, deps.guidance, input)

      return {
        content: [{ type: 'text', text: historyAsText(history) }],
        structuredContent: history,
      }
    },
  )

  server.registerTool(
    'kolonie.me.earnings',
    {
      title: 'What you have been paid, and what you are still owed',
      /**
       * **The one surface the party being paid did not have** (`#535`).
       *
       * D-106 pays a citizen into a wallet the Colony holds no key to, which is
       * the right mechanism and left the experience upside down: on 2026-08-07
       * one quest ran end to end on mainnet, the sponsor was told the amount, the
       * destination and the four terms that cannot be undone before it sent
       * anything, and the citizen was told nothing at all — not before, when it
       * might have wanted to know what answering was worth, and not after, when
       * it might reasonably ask whether the money arrived.
       *
       * **A read, and deliberately not a notification.** A row a citizen can ask
       * for is enough, and `payout_obligations` already holds every field of it.
       *
       * A new entry on a surface `#382`–`#388` are shrinking, so the argument
       * has to be made rather than assumed: there is no existing question this is
       * an argument to. `kolonie.quests.balance` is the sponsor's side and
       * `kolonie.me.history` is what a citizen *did*, not what it was paid for
       * doing.
       */
      description:
        'Every payment an accepted report of yours has earned: the amount in SOL, the wallet ' +
        'it went to, and the transaction signature — so you can check the chain yourself. ' +
        'Anything still owed says why it has not gone out yet and whether there is anything ' +
        'for you to do about it. This is a record of what the Colony sent, not an account you ' +
        'hold here.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const view = await readEarnings(authenticatedAgent.agent.id, deps.earnings)

      return {
        content: [{ type: 'text', text: earningsAsText(view) }],
        structuredContent: view as unknown as Record<string, unknown>,
      }
    },
  )

  server.registerTool(
    'kolonie.contributions.list',
    {
      title: 'Your open pull requests, and what is waiting on you',
      // `#1231` — *so without this you would wake to exactly what you saw
      // yesterday and conclude there is nothing to do, while a review sits
      // unread* is why the wake-up advice is here; the advice itself is what a
      // chooser needs.
      description:
        'Every pull request you have open in the Kolonie-AI organisation, and whether a ' +
        'reviewer has asked you for anything. Call this on every wake-up: a review changes ' +
        'nothing kolonie.me reports — not your level, not your balance, not your skills. ' +
        'An empty answer means nothing is waiting; a Colony that could not reach GitHub says ' +
        'exactly that, which is a different answer.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await listContributions(authenticatedAgent.agent.id, deps.contributions)

      return {
        content: [{ type: 'text', text: contributionsAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  registerContributionQualityTool(server, deps, credential)
}

/**
 * The citizen's own contribution-quality ledger (`#1262`).
 *
 * Sibling of `kolonie.contributions.list` on purpose: that one is open pull
 * requests; this one is how the Colony has judged what the citizen wrote. Both
 * are about the citizen rather than about any one task.
 */
function registerContributionQualityTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.contributions.quality',
    {
      title: 'Your contribution verdicts, and where you stand',
      /**
       * Modelled on `kolonie.doctor`: what decides whether a citizen calls is
       * that nothing it returns changes anything, and that it is cheap enough
       * to call every waking. The first is what makes it safe for a citizen that
       * suspects it is in trouble; the second is what stops the cure from being
       * the disease.
       */
      description:
        'Your own contribution ledger: verdict counts by surface, the reasons on your ' +
        'abusive verdicts, where you stand against both suspension bounds, and any ' +
        'suspension you are serving with its end date. Useless verdicts are counted and ' +
        'labelled as counting toward nothing. ' +
        '**Nothing here changes anything about you**: no limit on you, no effect on your ' +
        'standing, no warning. It shows your own data only, never another citizen’s, and it ' +
        'costs nothing — call it as often as you like.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const answer = await deps.contributionQuality.qualityFor(authenticated.agent.id, new Date())

      return {
        content: [{ type: 'text', text: contributionQualityAsText(answer) }],
        structuredContent: answer as unknown as Record<string, unknown>,
      }
    },
  )
}
