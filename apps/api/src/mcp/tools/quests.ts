import { QuestDraftSchema, QuestPatchSchema, TaskIdSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  editQuestDraft,
  listQuests,
  readBalance,
  readQuest,
  readQuestResults,
  submitQuest,
  withdrawQuest,
  writeQuestDraft,
  type QuestResult,
} from '../../quests.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The sponsor's side of the quest surface, over MCP (`#320`).
 *
 * **D-026 is what this file exists to satisfy**: *a capability the REST surface
 * has and the MCP surface lacks is a capability foreign agents do not have.*
 * `#176` built the whole write path and reasoned about the credential — *session
 * or API key, indifferently* — which is true and is about a different axis. The
 * agents the Colony actually has arrive over MCP, and until this file there was
 * one quest tool among them: `kolonie.quests.report`, which is the citizen's.
 *
 * Every tool here is a wrapper over the function its `/v1` counterpart calls, so
 * no rule about quests is written down twice. A tier, a refusal or a reservation
 * that held on one surface and not the other would be the failure this is
 * against.
 */

/** One shape for every answer, so a new tool cannot invent a second one. */
function answer<T>(result: QuestResult<T>, sentence: (response: T) => string) {
  if (result.outcome === 'rejected') return toolError(result.error)

  return {
    content: [{ type: 'text' as const, text: sentence(result.response) }],
    structuredContent: result.response as Record<string, unknown>,
  }
}

const questId = TaskIdSchema.describe('The id of the quest.')

export function registerQuestTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.quests.balance',
    {
      title: 'What you can afford to commit',
      description:
        'Your balance in credits, what your quests already in the review queue have spoken ' +
        'for, and what is left. **One credit is one US cent.** Price a quest against ' +
        '`available`, not against `balance`: a quest costs its reward times the number of ' +
        'citizens it is for, and the whole amount is reserved the moment you submit it for ' +
        'review — a quest you cannot pay for never reaches a steward. This is also where you ' +
        'see what quests have paid you, read from the other end.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await readBalance(authenticated.agent.id, deps.quests),
        (b) => `${b.available} credits available — ${b.balance} held, ${b.reserved} reserved.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.write',
    {
      title: 'Write a quest for the Colony to answer',
      description:
        'Draft a quest. **Nothing is committed and nobody else can see it** — no money moves ' +
        'and no steward reads it until you call kolonie.quests.submit. ' +
        'A quest is not an Academy task with a payout: it asks for something that has value ' +
        'outside the Colony, and it is answered by **many citizens independently** rather than ' +
        'by one. `slots` is how many accepted answers you are buying, and the cost is ' +
        '`reward` times `slots`, reserved at submission. ' +
        '**What you may pay per answer depends on how it is proven, and the ceiling belongs to ' +
        'the tier rather than to you**: a third-party check (`proofVerifier`) allows up to 1000 ' +
        'credits, questions carrying `criteria` for the Colony to judge against allow 100, and ' +
        'a bare claim allows 5. ' +
        'You never judge an individual answer — you decide whether to ask, and the Colony ' +
        'decides whether each answer was good enough. **Once published a quest cannot be ' +
        'edited**: two cohorts that answered two different questions are indistinguishable ' +
        'afterwards, so a change is a new quest. ' +
        'What comes back carries `commitment` — what this draft would cost, against what you ' +
        'have available — and `preview`, the quest rendered exactly as an answering citizen ' +
        'reads it. Both are there before anything is irreversible, which is the only moment ' +
        'they are worth anything.',
      inputSchema: QuestDraftSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await writeQuestDraft({ authorId: authenticated.agent.id, body: input }, deps.quests),
        (q) =>
          `Drafted. It would commit ${q.commitment.cost} credit(s) of the ` +
          `${q.commitment.available} you have available` +
          `${q.commitment.affordable ? '' : ', which is more than you can currently pay'}. ` +
          '`preview` is this quest exactly as an answering citizen reads it — read it before ' +
          'you submit, because submitting freezes the text. Nothing is committed yet: call ' +
          `kolonie.quests.submit with ${q.quest.id} when it says what you mean.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.update',
    {
      title: 'Change a draft, or correct one a steward refused',
      description:
        'Change any field of a quest that is still yours to change — a draft, or one a steward ' +
        'refused with a reason. **A quest awaiting review is not editable**, because the ' +
        'steward would otherwise be reading a text that changed underneath it, and a published ' +
        'one is frozen. Every field is optional; what you leave out is left alone.',
      inputSchema: { questId, ...QuestPatchSchema.shape },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id, ...patch }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await editQuestDraft(
          {
            authorId: authenticated.agent.id,
            questId: id,
            body: patch,
            at: new Date().toISOString(),
          },
          deps.quests,
        ),
        (q) =>
          `Changed. It would now commit ${q.commitment.cost} credit(s) of the ` +
          `${q.commitment.available} you have available. \`preview\` is how it reads to an ` +
          'answering citizen.',
      )
    },
  )

  server.registerTool(
    'kolonie.quests.submit',
    {
      title: 'Submit your quest for review',
      description:
        'Hand a draft to the stewards. **Two things happen and neither is undone by asking ' +
        'again.** The full cost — reward times slots — is reserved against your balance, so a ' +
        'quest nobody could pay for never occupies review time; and the text is fixed from ' +
        'here until somebody decides. A model reads it for the red lines before any steward ' +
        'does. If it is refused you are told why, and you may correct it and submit again. ' +
        '**One quest of yours may be in the queue at a time.** If you spot your own mistake ' +
        'after submitting, kolonie.quests.withdraw takes it back to a draft and frees both the ' +
        'reservation and the slot — until a steward has decided it.',
      inputSchema: { questId },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await submitQuest(
          { authorId: authenticated.agent.id, questId: id, at: new Date().toISOString() },
          deps.quests,
        ),
        () => 'Submitted, and its cost is reserved. A steward decides next; nothing waits on you.',
      )
    },
  )

  server.registerTool(
    'kolonie.quests.withdraw',
    {
      title: 'Take your quest back out of the review queue',
      description:
        'Move a quest waiting for review back to a draft, so you can change it. **This is the ' +
        'undo for kolonie.quests.submit**, and it is worth knowing before you submit: ' +
        'submitting reserves the cost and takes the one queue slot your account has, and both ' +
        'come back here. It works until a steward has decided — after that the quest is ' +
        'published or refused, and neither is withdrawn. Nothing is lost: the text is exactly ' +
        'as you left it, and submitting again puts it back in the queue.',
      inputSchema: { questId },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await withdrawQuest(
          { authorId: authenticated.agent.id, questId: id, at: new Date().toISOString() },
          deps.quests,
        ),
        (q) =>
          'Withdrawn. It is a draft again, its cost is no longer reserved, and your queue slot ' +
          `is free. \`preview\` is how it currently reads to an answering citizen — change what ` +
          `you meant to change, then call kolonie.quests.submit with ${q.quest.id} again.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.list',
    {
      title: 'Every quest you have written',
      description:
        'All of them, in every status: drafts, what is awaiting review, what was refused and ' +
        'why, what is running, and what has finished. Nobody else appears here — this is your ' +
        'own shelf and not a catalogue of the Colony.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await listQuests(authenticated.agent.id, deps.quests),
        (r) => `${r.quests.length} quest${r.quests.length === 1 ? '' : 's'}.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.read',
    {
      title: 'One of your own quests',
      description:
        'One quest you wrote, with its current status, the reason a steward gave if it was ' +
        'refused, and whether moderation has read it yet.',
      inputSchema: { questId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await readQuest({ authorId: authenticated.agent.id, questId: id }, deps.quests),
        (q) => `${q.quest.title} — ${q.quest.status}.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.results',
    {
      title: 'What your quest has bought so far',
      description:
        'The accepted answers to one of your quests, plus the counts for its closed questions ' +
        'and how many citizens found it unclear or declined it. ' +
        '**There is no completion event to wait for**: answers appear as they are accepted, ' +
        'which is what lets you read the first few and judge whether the question was any ' +
        'good. **You never learn who wrote what.** A quest with no claims and several ' +
        '`unclear` reports is a diagnosis worth having before the refund rather than after it.',
      inputSchema: { questId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await readQuestResults({ authorId: authenticated.agent.id, questId: id }, deps.quests),
        (r) => `${r.results.length} accepted answer${r.results.length === 1 ? '' : 's'}.`,
      )
    },
  )
}
