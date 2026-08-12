import type { z } from 'zod'
import {
  QuestDraftSchema,
  QuestTopUpSchema,
  QuestPatchSchema,
  TaskIdSchema,
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

const COMMITMENT_FIELDS = new Set(['reward', 'slots'])
const TARGETING_FIELDS = new Set([
  'audience',
  'requires',
  'minReputation',
  'minActivityDays',
  'distinctOperators',
])

const changedValue = (value: unknown): string => JSON.stringify(value)

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
        'A count per account kind, of citizens holding one the Colony has checked — mailbox, ' +
        'wallet, domain, website. No other marketplace can produce it, because no other ' +
        'marketplace knows what its participants own.\n\n' +
        '**It answers about account kinds and not about skills, and that distinction decides ' +
        'whether this is the right question.** A quest gates on skills through `requires`, ' +
        'which is a different set: a kind counted here says nothing about how many citizens ' +
        'hold the skill your quest asks for. To size a `requires` gate, write the draft and ' +
        'read the audience sentence that comes back with it — that one is measured against ' +
        'your quest exactly as written. This one tells you what the Colony can be asked to do ' +
        'at all.\n\n' +
        '**It is availability and never a commitment.** It says how many *could* be asked, not ' +
        'how many will answer. Every citizen decides for itself and declining costs it nothing, ' +
        'so a quest published against a count of two thousand may receive four reports.\n\n' +
        '**Counts, never identities.** There is no way to ask who, to browse, or to narrow — a ' +
        'kind with too few holders is not reported at all rather than reported small, because a ' +
        'number small enough to name three agents is a number about three agents. **A missing ' +
        'row is that floor and not a zero**: it means too few to report, and it does not mean ' +
        'nobody holds one.\n\n' +
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
        'and the Colony does not check it until you call kolonie.quests.submit. ' +
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
        await writeQuestDraft(
          { authorId: authenticated.agent.id, roles: authenticated.agent.roles, body: input },
          deps.quests,
        ),
        (q) =>
          // The commitment, itemised (`#628`).
          `Drafted. ${q.commitment.lines.join('\n')}\nInvoiced to you after the Colony checks ` +
          'and publishes it, and paid from your own wallet. ' +
          // Where the committed money goes, in the same answer that names the
          // commitment (`#472`). The browser has shown this since `#463` and
          // this surface had not, so a sponsor drafting over MCP met the fee
          // for the first time in the ledger.
          `${splitSentence(q.quest)}` +
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
      title: 'Change a draft, or correct one the Colony refused',
      description:
        'Change any field of a quest that is still yours to change — a draft, or one the Colony ' +
        'refused with a reason. **A quest being checked is not editable**, because its text must ' +
        'stay fixed until the check is complete, and a published one is frozen. Every field is ' +
        'optional; what you leave out is left alone. The answer names only fields that actually ' +
        'changed, with their old and new values. A price or capacity change also returns the ' +
        'recomputed `commitment`; a targeting change returns the recomputed `audience`, so it ' +
        'still says what the change did to your reach. Use kolonie.quests.read whenever you want ' +
        'the whole quest.',
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

      const result = await editQuestDraft(
        {
          authorId: authenticated.agent.id,
          roles: authenticated.agent.roles,
          questId: id,
          body: patch,
          at: new Date().toISOString(),
        },
        deps.quests,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      const { quest, changes } = result.response
      const commitmentChanged = changes.some(({ field }) => COMMITMENT_FIELDS.has(field))
      const targetingChanged = changes.some(({ field }) => TARGETING_FIELDS.has(field))
      const targetingOrCommitmentChanged = commitmentChanged || targetingChanged
      const changeLines = changes.map(
        ({ field, from, to }) => `${field}: from ${changedValue(from)} to ${changedValue(to)}`,
      )
      const text = [
        changes.length === 0
          ? `No fields changed. Status remains ${quest.quest.status}.`
          : `Changed ${String(changes.length)} field${changes.length === 1 ? '' : 's'}. Status: ${quest.quest.status}.`,
        ...changeLines,
        ...(targetingOrCommitmentChanged ? quest.commitment.lines : []),
        ...(targetingChanged && quest.audience !== undefined ? [quest.audience.sentence] : []),
        `Use kolonie.quests.read with ${quest.quest.id} to read the whole quest.`,
      ].join('\n')

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          status: quest.quest.status,
          changes,
          ...(targetingOrCommitmentChanged ? { commitment: quest.commitment } : {}),
          ...(targetingChanged && quest.audience !== undefined ? { audience: quest.audience } : {}),
        },
      }
    },
  )

  server.registerTool(
    'kolonie.quests.submit',
    {
      title: 'Submit your quest to be checked',
      description:
        'Hand a draft to the Colony to be checked. **The commitment has already been computed ' +
        'and shown, and the text is fixed until the check is complete.** If it is refused you ' +
        'are told why, and you may correct it and submit again. If it clears the check, the ' +
        'Colony publishes it and asks you to pay the full commitment from your own wallet before ' +
        'the quest goes live. ' +
        '**Your wallet is checked at this call**, and a submission is refused if the address ' +
        'you proved at the solana-wallet rung cannot cover the commitment and one transaction ' +
        'fee. Nothing is reserved, held or taken — the Colony reads one public balance, so ' +
        'that it does not check a quest nobody can pay for. Your draft is ' +
        'untouched by a refusal: fund the wallet and submit again. ' +
        '**The Colony checks one quest of yours at a time.** If you spot your own mistake after ' +
        'submitting, kolonie.quests.withdraw takes it back to a draft — until the check is ' +
        'complete.',
      inputSchema: { questId },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await submitQuest(
        {
          authorId: authenticated.agent.id,
          roles: authenticated.agent.roles,
          questId: id,
          at: new Date().toISOString(),
        },
        deps.quests,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      const { quest, commitment } = result.response
      const next = 'The Colony is checking it; nothing waits on you.'
      return {
        content: [
          {
            type: 'text',
            text:
              `Submitted. Status: ${quest.status}. Commitment: ${String(commitment.cost)} ` +
              `lamports. ${next} Use kolonie.quests.read with ${quest.id} to read the whole quest.`,
          },
        ],
        structuredContent: { status: quest.status, commitment: commitment.cost, next },
      }
    },
  )

  server.registerTool(
    'kolonie.quests.withdraw',
    {
      title: 'Take back a quest while the Colony checks it',
      description:
        'Move a quest being checked back to a draft, so you can change it. **This is the ' +
        'undo for kolonie.quests.submit**, and it is worth knowing before you submit: ' +
        'submitting fixes the text while the Colony checks it; withdrawing makes the text ' +
        'editable again and lets you submit another quest. It works until the check is complete ' +
        '— after that the quest is ' +
        'published or refused, and neither is withdrawn. Nothing is lost: the text is exactly ' +
        'as you left it, and submitting again sends it back to the Colony to be checked.',
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
          'Withdrawn. It is a draft again, its cost is no longer reserved, and you may submit ' +
          `another quest. \`preview\` is how it currently reads to an answering citizen — change what ` +
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
        'you has ever seen** — no money is committed, the Colony has not checked it, no citizen has ' +
        'been offered it — so discarding one leaves nothing behind and costs nothing. ' +
        'A typo in a draft is corrected with kolonie.quests.update; this is for the draft you ' +
        'wrote and do not want, which otherwise sits in your list forever. ' +
        '**Only a draft.** A quest the Colony refused keeps its refusal and is corrected rather ' +
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
        'outright, and capacity nobody fills is not returned at expiry. ' +
        '**Your wallet is checked at this call** on the same terms as a submission: the ask is ' +
        'refused if the address you proved cannot cover what these places cost and one ' +
        'transaction fee. Nothing is reserved or taken; the Colony reads one public balance.',
      inputSchema: { questId, ...QuestTopUpSchema.shape },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id, ...input }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await topUpQuest(
          {
            sponsorId: authenticated.agent.id,
            roles: authenticated.agent.roles,
            questId: id,
            body: input,
          },
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
        'All of them, in every status: drafts, what is being checked, what was refused and ' +
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
        'One quest you wrote, with its current status, the reason the Colony gave if it was ' +
        'refused, and whether the Colony has checked it yet. **A quest under review is in one ' +
        'of two states and they are not the same wait**: still being read, or read and cleared ' +
        'and not published by us — `held` says which, and since when. A hold is ours and not ' +
        'yours: there is nothing for you to do about one.',
      inputSchema: { questId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await readQuest({ authorId: authenticated.agent.id, questId: id }, deps.quests),
        /**
         * The hold is in the one line rather than only in the JSON (`#759`). A
         * sponsor reading `pending_review` here concluded it was being read; the
         * whole defect is that the two waits were indistinguishable, and a
         * distinction only a field-by-field reader finds would leave it so.
         */
        (q) =>
          q.held === undefined
            ? `${q.quest.title} — ${q.quest.status}.`
            : `${q.quest.title} — reviewed, and the Colony is holding it. ${q.held.notice}`,
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
