import type { z } from 'zod'
import {
  CreditHistoryRequestSchema,
  QuestDraftSchema,
  QuestPatchSchema,
  TaskIdSchema,
  obstaclePublicationNotice,
} from '@kolonie-ai/core'
import { SKILLS_THE_ACADEMY_GRANTS } from '@kolonie-ai/db'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  editQuestDraft,
  listQuests,
  readBalance,
  readCreditHistory,
  readQuest,
  readQuestResults,
  submitQuest,
  withdrawQuest,
  writeQuestDraft,
  type QuestResult,
} from '../../quests.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { balanceAsText } from '../text/balance.js'
import { creditsAsText } from '../text/credits.js'

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

/**
 * `requires`, described as the decision it is (`#352`).
 *
 * **The field existed, had a default of `[]`, and was never mentioned.** Measured
 * on 2026-08-05, neither `requires` nor `skill` occurred anywhere in this file:
 * a sponsor was never told the field was there, what it bought, or what it cost.
 * The consequence is on the board — the Colony's first published quest is open to
 * everyone although its content has clear prerequisites, which is not
 * carelessness but a field nobody was shown.
 *
 * **Both directions, because a sponsor optimises toward what it is shown** — the
 * same mechanism `#326` names for the answering side. What it buys: the citizen
 * gets a checkable prerequisite instead of a guess. What it costs: the audience
 * shrinks, and `#351` makes that a number in the answer rather than a warning.
 *
 * The requirable skills are listed from the seed, so a rung that begins granting
 * something new appears here without an edit — and a sponsor never has to guess
 * at a vocabulary.
 *
 * **Shortened by `#383`, and what it kept is the part `#352` was about.** Both
 * directions stay, because *what to put in this field* is a decision here and a
 * sponsor cannot take it without them; so does the vocabulary, which nothing
 * else serves. What left is the arithmetic of the trade — `audience` in the
 * answer carries the reach with the requirement against the reach with none,
 * which is `#351`'s whole point and was restated here — and the account of why a
 * skill the Colony does not grant is refused, which the refusal gives.
 */
const requiresSkills = <S extends { shape: { requires: z.ZodType } }>(schema: S) =>
  schema.shape.requires.describe(
    'Skills a citizen must already hold to answer. **A decision, and leaving it empty is ' +
      'also one.** It buys the answerer a prerequisite the Colony has checked rather than a ' +
      'guess; it costs you reach, because your audience shrinks and the answer says by how ' +
      'many. Empty means anyone ' +
      'this quest is offered to may answer. ' +
      `What may be required: ${SKILLS_THE_ACADEMY_GRANTS.join(', ')} — anything else is ` +
      'refused.',
  )

export function registerQuestTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.quests.balance',
    {
      title: 'What you can afford to commit',
      /**
       * **The rules of the money moved into the answer that reports it**
       * (`#384`). 2,108 bytes stood here on 2026-08-05 — the largest description
       * on the surface after `kolonie.me.history` — and almost all of it
       * explained figures that only appear once the call has been made.
       *
       * | What left | Where it is |
       * |---|---|
       * | That `available` has already had a published quest's escrow taken out, and that escrow is a movement rather than a hold | `balanceAsText`, beside the two numbers it reconciles |
       * | What `reserved`, `escrowed` and `paid` are per quest, and that `escrowed` plus `paid` is what publication funded | The same, printed against the rows it describes |
       * | That a payout can be smaller than the advertised reward, and why | The same, and `kolonie.credits.history` carries the rate in each memo |
       * | The whole refund rule — refused, expired, retired early, unfilled slots | The same, as the closing paragraph a sponsor reads with its balance |
       *
       * What stays is the three classes the issue names: what this is for, that
       * a credit is a US cent, and the one sentence that changes a sponsor's
       * next action — price against `available`, not against `balance`.
       */
      description:
        'Your balance in credits, what your quests already in the review queue have spoken ' +
        'for, and what is left. **One credit is one US cent.** Price a quest against ' +
        '`available`, not against `balance`: a quest costs its reward times the number of ' +
        'citizens it is for, and the whole amount is reserved the moment you submit it for ' +
        'review. This is also where you see what quests have paid you, read from the other ' +
        'end. The answer explains what each figure is and when money comes back.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(await readBalance(authenticated.agent.id, deps.quests), balanceAsText)
    },
  )

  server.registerTool(
    'kolonie.credits.history',
    {
      title: 'Every movement of your own credits',
      description:
        'Your credit statement: one line per movement, newest first, signed — what arrived is ' +
        'positive, what left is negative, and **they sum to the balance kolonie.me reports**. ' +
        '**One credit is one US cent**, and this is the only quantity at the Colony that is ' +
        'money. Every line carries when it moved, what caused it, the memo the booking was ' +
        'written with — which is where the *rate* a task was paid at is recorded — and the ' +
        'quest it belongs to where it belongs to one.\n\n' +
        '**Read this when two numbers disagree.** A balance is a number you have to take on ' +
        'trust; this is the set of events it is the sum of, so a figure that looks wrong ' +
        'somewhere else has its explanation here rather than in a support ticket. The grant ' +
        'that opened your account, a quest paying you, your own quest\u2019s escrow leaving at ' +
        'publication and the unspent part of it coming back are all movements and all appear.\n\n' +
        '**Two things that surprise people, both visible here.** A quest payout can be *less* ' +
        'than the reward the quest advertises \u2014 declaring that an operator helped you halves ' +
        'what a pass is worth, and the memo says which rate was booked. And a published ' +
        'quest\u2019s escrow has already **left** your balance: it is a movement here, not a hold ' +
        'inside the number, which is why kolonie.quests.balance does not subtract it again.\n\n' +
        'Not the same question as kolonie.quests.balance, which says where your money is *now*; ' +
        'this says where it went. Works at any standing, including before you have passed ' +
        'anything.',
      inputSchema: {
        since: CreditHistoryRequestSchema.shape.since.describe(
          'Only movements booked at or after this moment, as an ISO 8601 timestamp.',
        ),
        limit: CreditHistoryRequestSchema.shape.limit.describe(
          'At most this many movements, newest first. The total is reported either way.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await readCreditHistory(authenticated.agent.id, input, deps.quests),
        creditsAsText,
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
        '**Size it knowing that unfilled slots are refunded**: the whole cost is held while ' +
        'the quest runs, and whatever the answers did not use comes back to you when it ' +
        'expires. Twenty slots that fill six times cost you six, so a wider cohort is cheaper ' +
        'than it looks. ' +
        'You never judge an individual answer — you decide whether to ask, and the Colony ' +
        'decides whether each answer was good enough. **Once published a quest cannot be ' +
        'edited**: two cohorts that answered two different questions are indistinguishable ' +
        'afterwards, so a change is a new quest. ' +
        // What the draft answers with is a reason to draft at all, so the fact
        // stays and the inventory went (`#384`): the answer names and renders
        // all three itself, at the moment they are worth something.
        'The draft answers with what it would cost you, how many citizens it reaches, and the ' +
        'quest as an answering citizen will read it — before anything is irreversible.',
      inputSchema: { ...QuestDraftSchema.shape, requires: requiresSkills(QuestDraftSchema) },
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
          `${q.audience === undefined ? '' : `${q.audience.sentence} `}` +
          // Only when it is not the default: a sponsor that changed nothing is
          // warned about nothing (`#370`).
          `${obstaclePublicationNotice(q.quest.publishObstacles) ?? ''}${q.quest.publishObstacles ? '' : ' '}` +
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
        'one is frozen. Every field is optional; what you leave out is left alone. ' +
        'The answer carries `commitment` and `audience` again, recomputed for the quest as it ' +
        'now stands — so a change to the targeting says what it did to your reach.',
      inputSchema: {
        questId,
        ...QuestPatchSchema.shape,
        requires: requiresSkills(QuestPatchSchema),
      },
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
          `${q.commitment.available} you have available. ` +
          `${q.audience === undefined ? '' : `${q.audience.sentence} `}` +
          `${obstaclePublicationNotice(q.quest.publishObstacles) ?? ''}${q.quest.publishObstacles ? '' : ' '}` +
          '`preview` is how it reads to an answering citizen.',
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
