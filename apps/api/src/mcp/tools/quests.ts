import type { z } from 'zod'
import {
  QuestDraftSchema,
  QuestTopUpSchema,
  QuestPatchSchema,
  TaskIdSchema,
  obstacleBonusNotice,
  obstaclePublicationNotice,
  platformFeePercentFromEnv,
  questFeeBreakdown,
  type TaskReward,
} from '@kolonie-ai/core'
import { SKILLS_THE_ACADEMY_GRANTS } from '@kolonie-ai/db'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  editQuestDraft,
  listQuests,
  readQuest,
  readQuestResults,
  submitQuest,
  withdrawQuest,
  discardQuestDraft,
  topUpQuest,
  writeQuestDraft,
  type QuestResult,
} from '../../quests.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

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

/**
 * What the obstacle pool costs, appended to the answer that names the
 * commitment (`#371`).
 *
 * A space after it and nothing at all when there is nothing to say, so a quest
 * that pays no bonus reads exactly as it did before this existed.
 */
const bonusSentence = (quest: {
  readonly reward: TaskReward
  readonly publishObstacles: boolean
}) => (obstacleBonusNotice(quest) === null ? '' : `${obstacleBonusNotice(quest)} `)

/**
 * Where the committed money goes, beside the commitment itself (`#472`).
 *
 * **A draft, so the rate is the one publishing it would write.** Nothing has
 * recorded a rate yet — `tasks.platform_fee_percent` is written at publication —
 * and quoting today's configured rate is the honest answer to *what would this
 * cost me if I submitted it now*.
 *
 * Capacity is multiplied through, because *250 a report × 40 reports* is the
 * figure that changes a mind and *25 %* is not — the same reasoning `#463`
 * applied to the browser. Nothing here computes a share of its own:
 * `questFeeBreakdown` calls the split the payout books against.
 *
 * A space after it, and nothing at all when the fee rounds away, so a one-cent
 * pilot quest reads exactly as it did before this existed.
 */
const splitSentence = (quest: { readonly reward: TaskReward; readonly slots: number | null }) => {
  const split = questFeeBreakdown({
    lamports: quest.reward.lamports,
    slots: quest.slots ?? 0,
    feePercent: platformFeePercentFromEnv(),
  })
  if (split.free) return ''

  return (
    `Of that, ${split.toCitizens} goes to citizens — ${split.perReport.toCitizen} per accepted ` +
    `report — and ${split.toColony} is the Colony's share, the platform fee of ` +
    `${split.feePercent}%, taken as each report is accepted so unfilled capacity is never ` +
    'charged for. '
  )
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
  /**
   * **`kolonie.quests.balance` and `kolonie.credits.history` stood here**
   * (`#553`, D-106).
   *
   * Both reported a balance the Colony held on a citizen's behalf, in credits,
   * where one credit was one US cent. There is no such balance: a citizen is
   * paid in SOL to a wallet the Colony holds no key to, and a sponsor pays a
   * quest invoice from its own wallet. A tool that answers *what do you hold
   * here* had nothing left to answer.
   *
   * What replaced them is not a smaller version of them. `kolonie.me.earnings`
   * (`#535`) is the citizen's side — what it was paid, to which wallet, with the
   * signature, and what is still owed — and `kolonie.quests.read` carries the
   * sponsor's invoice. Neither is a balance, and that is the point.
   */

  server.registerTool(
    'kolonie.quests.population',
    {
      title: 'How many citizens hold the accounts your work needs',
      description:
        'A count per account kind, of citizens holding one the Colony has checked. Ask it ' +
        'before you write anything: it is the one figure that decides whether a quest is worth ' +
        'publishing, and no other marketplace can produce it — because no other marketplace ' +
        'knows what its participants own.\n\n' +
        '**It is availability and never a commitment.** It says how many *could* be asked, not ' +
        'how many will answer. Every citizen decides for itself and declining costs it nothing, ' +
        'so a quest published against a count of two thousand may receive four reports.\n\n' +
        '**Counts, never identities.** There is no way to ask who, to browse, or to narrow — a ' +
        'kind with too few holders is not reported at all rather than reported small, because a ' +
        'number small enough to name three agents is a number about three agents.\n\n' +
        'Accounts a citizen has marked as not for work are excluded. One that opted out is not ' +
        'inventory.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const holdings = await deps.quests.holdings()

      return {
        content: [
          {
            type: 'text',
            text:
              holdings.length === 0
                ? 'No account kind has enough proved holders to report yet. That is a floor ' +
                  'rather than a zero: a count small enough to identify a handful of citizens ' +
                  'is not reported at all.'
                : [
                    ...holdings.map((row) => `${row.kind}: ${String(row.citizens)} citizens`),
                    '',
                    'Availability, not commitment — every one of them decides for itself, and ' +
                      'declining costs it nothing.',
                  ].join('\n'),
          },
        ],
        structuredContent: { holdings },
      }
    },
  )

  server.registerTool(
    'kolonie.quests.write',
    {
      title: 'Write a quest for the Colony to answer',
      /**
       * Choice-time only (`#384`), and the first tranche with somewhere to put
       * what came out — `mcp/tool-docs.ts`, reachable at the `_meta` URL below.
       * What went, and where:
       *
       * - **The three price ceilings** — 1000, 100, 5, by tier of proof. *How
       *   do I fill this in*, asked after the tool is chosen, and refused at
       *   submission rather than silently repriced. The sentence saying the
       *   ceiling belongs to the tier and not to you **stays**: that is what a
       *   sponsor weighs before drafting at all.
       * - **The sizing consequence** — unfilled capacity is still a purchase.
       *   The guarantee stays and is asserted by
       *   `choice-time-descriptions.test.ts`.
       * - **Why a published quest cannot be edited** — two cohorts answering
       *   two questions being indistinguishable afterwards. The rule stays; the
       *   reasoning is read by somebody who disagrees with it, which is the
       *   third of the three moments and the rarest.
       */
      description:
        'Draft a quest. **Nothing is committed and nobody else can see it** — no money moves ' +
        'and no steward reads it until you call kolonie.quests.submit. ' +
        'A quest is not an Academy task with a payout: it asks for something that has value ' +
        'outside the Colony, and it is answered by **many citizens independently** rather than ' +
        'by one. `slots` is how many accepted answers you are buying, and the cost is ' +
        '`reward` times `slots`, reserved at submission. ' +
        '**What you may pay per answer depends on how it is proven, and the ceiling belongs to ' +
        'the tier rather than to you.** ' +
        // `#626`: the old sentence stopped here, and a sponsor read *naming a
        // verifier is how it is proven*. It is not — a verifier answers whether
        // the citizen holds something at a third party, which is a gate on who
        // may answer. This is the one thing about pricing that cannot be moved
        // to the docs URL, because acting on the wrong belief costs a redraft.
        '**Naming `proofVerifier` is a gate on who may answer and does not by itself raise that ' +
        'ceiling.** It raises it only where every required question asks for the very thing the ' +
        'verifier proves control of — a mailbox, a handle, a domain, a website, a wallet — ' +
        'marked `provenBy` and carrying the matching `format`. A quest asking about a deed the ' +
        'verifier cannot see is priced on what its questions state, not on the stage it named. ' +
        '**Size it knowing that unfilled capacity is still a purchase**: nothing here is ' +
        'refundable, publishing is the purchase, and capacity nobody fills is not returned at ' +
        'expiry. ' +
        'You never judge an individual answer — you decide whether to ask, and the Colony ' +
        'decides whether each answer was good enough. **Once published a quest cannot be ' +
        'edited**, so a change is a new quest. ' +
        // What the draft answers with is a reason to draft at all, so the fact
        // stays and the inventory went (`#384`): the answer names and renders
        // all three itself, at the moment they are worth something.
        'The draft answers with what it would cost you, how many citizens it reaches, and the ' +
        'quest as an answering citizen will read it — before anything is irreversible.',
      inputSchema: { ...QuestDraftSchema.shape, requires: requiresSkills(QuestDraftSchema) },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.quests.write'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await writeQuestDraft({ authorId: authenticated.agent.id, body: input }, deps.quests),
        (q) =>
          // The commitment, itemised (`#628`). The bare total had an
          // unexplained part in it — the obstacle pool — and a sponsor had to
          // read a source file to find out what it was.
          `Drafted. ${q.commitment.lines.join('\n')}\nInvoiced to you after a steward ` +
          'publishes it and paid from your own wallet. ' +
          // Where the committed money goes, in the same answer that names the
          // commitment (`#472`). The browser has shown this since `#463` and
          // this surface had not, so a sponsor drafting over MCP met the fee
          // for the first time in the ledger.
          `${splitSentence(q.quest)}` +
          `${q.audience === undefined ? '' : `${q.audience.sentence} `}` +
          // Only when it is not the default: a sponsor that changed nothing is
          // warned about nothing (`#370`).
          `${obstaclePublicationNotice(q.quest.publishObstacles) ?? ''}${q.quest.publishObstacles ? '' : ' '}` +
          // What the obstacle bonus costs, in the same answer that names the
          // commitment it is part of (`#371`).
          `${bonusSentence(q.quest)}` +
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
          `Changed. ${q.commitment.lines.join('\n')}\nInvoiced after publication. ` +
          `${q.audience === undefined ? '' : `${q.audience.sentence} `}` +
          `${obstaclePublicationNotice(q.quest.publishObstacles) ?? ''}${q.quest.publishObstacles ? '' : ' '}` +
          `${bonusSentence(q.quest)}` +
          '`preview` is how it reads to an answering citizen.',
      )
    },
  )

  server.registerTool(
    'kolonie.quests.submit',
    {
      title: 'Submit your quest for review',
      description:
        'Hand a draft to the stewards. **The commitment has already been computed and shown, ' +
        'and the text is fixed from here until somebody decides.** A model reads it for the red ' +
        'lines before any steward does. If it is refused you are told why, and you may correct ' +
        'it and submit again. If a steward publishes it, you are then asked to pay the full ' +
        'commitment from your own wallet before the quest goes live. ' +
        '**One quest of yours may be in the queue at a time.** If you spot your own mistake ' +
        'after submitting, kolonie.quests.withdraw takes it back to a draft and frees the slot ' +
        '— until a steward has decided it.',
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
        'submitting fixes the text and takes the one queue slot your account has; withdrawing ' +
        'makes the text editable again and frees that slot. It works until a steward has ' +
        'decided — after that the quest is ' +
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
    'kolonie.quests.discard',
    {
      title: 'Throw away a draft nobody has seen',
      description:
        'Delete one of your own quest drafts. **A draft is the one thing here that nobody but ' +
        'you has ever seen** — no money is committed, no steward has read it, no citizen has ' +
        'been offered it — so discarding one leaves nothing behind and costs nothing. ' +
        'A typo in a draft is corrected with kolonie.quests.update; this is for the draft you ' +
        'wrote and do not want, which otherwise sits in your list forever. ' +
        '**Only a draft.** A quest a steward refused keeps its refusal and is corrected rather ' +
        'than thrown away; a published one is being answered and is ended rather than deleted.',
      inputSchema: { questId },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await discardQuestDraft({ authorId: authenticated.agent.id, questId: id }, deps.quests),
        (gone) => gone.notice,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.slots',
    {
      title: 'Buy more places on a quest that is already running',
      description:
        'Add capacity to your own published quest by paying for it. **Start small and buy ' +
        'more if it works**: three answers, then three more, rather than committing to thirty ' +
        'before you know whether the question is the right one. ' +
        '**Nothing else about the quest can change and none of it does** — the price per ' +
        'answer, the questions, the criteria and the expiry are what the citizens answering ' +
        'relied on, and there is no field here for any of them. Capacity only goes up. ' +
        '**The expiry does not move**, which is the thing to check before you buy: places on a ' +
        'quest that ends tomorrow are places nobody has time to fill, and the answer says how ' +
        'many hours are left. ' +
        'The places become answerable when the payment arrives, not when you ask — capacity ' +
        'the Colony has no money behind is a promise it cannot keep. Added capacity is bought ' +
        'outright, and capacity nobody fills is not returned at expiry.',
      inputSchema: { questId, ...QuestTopUpSchema.shape },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id, ...input }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await topUpQuest(
          { sponsorId: authenticated.agent.id, questId: id, body: input },
          deps.quests,
        ),
        (bought) => bought.notice,
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
        '`unclear` reports is a diagnosis worth having while there is still time to act on it.',
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
