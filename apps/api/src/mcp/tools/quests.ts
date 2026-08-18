import { z } from 'zod'
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
import { readSponsorPayment } from '../../payments.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { paymentAsText } from '../text/payment.js'
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

/**
 * The transaction signature of a payment, as the sponsor copies it (`#760`).
 *
 * The same bound `ObservedPaymentSchema` puts on the field it reads off the
 * chain, so a signature this tool accepts is one that could have been recorded.
 */
const paymentSignature = z
  .string()
  .min(1)
  .max(120)
  .describe(
    'The transaction signature, base58, exactly as your wallet or an explorer shows it — not ' +
      'the address you sent to and not the quest id.',
  )

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
const requiresSkills = <S extends { shape: { requires: z.ZodType } }>(
  schema: S,
): S['shape']['requires'] =>
  schema.shape.requires.describe(
    'Skills a citizen must already hold to answer. **A decision, and leaving it empty is ' +
      'also one.** It buys the answerer a prerequisite the Colony has checked; it costs you ' +
      'reach, because your audience shrinks and the answer says by how much. Empty means ' +
      'anyone ' +
      'this quest is offered to may answer. ' +
      `What may be required: ${SKILLS_THE_ACADEMY_GRANTS.join(', ')} — anything else is ` +
      'refused.',
  )

/**
 * `playbookId`, described as what it is and is not (`#1182`).
 *
 * Both halves, because a sponsor reading the field name alone would reasonably
 * guess the wrong one: it records the pipeline this quest is about, and it does
 * not generate the quest, price it or bind an answer to those steps. The `open`
 * rule is stated rather than left to the refusal — a sponsor that has to draft
 * twice to learn the catalogue must have published it first has paid for the
 * sentence this one saves.
 */
const namedPlaybook = <S extends { shape: { playbookId: z.ZodType } }>(
  schema: S,
): S['shape']['playbookId'] =>
  schema.shape.playbookId.describe(
    'The playbook this quest asks citizens to run, by id. **A reference and not an ' +
      'instruction**: it does not write the quest, price it or bind an answer to those steps — ' +
      'it records which published pipeline you had in mind. Only a playbook the catalogue has ' +
      'published may be named; a draft, one in review and one that is blocked are all refused.',
  )

/** Keep the core schemas' strict boundary when adding MCP-only field descriptions. */
const questDraftInputSchema = QuestDraftSchema.safeExtend({
  requires: requiresSkills(QuestDraftSchema),
  playbookId: namedPlaybook(QuestDraftSchema),
})
const questPatchInputSchema = QuestPatchSchema.safeExtend({
  questId,
  requires: requiresSkills(QuestPatchSchema),
  playbookId: namedPlaybook(QuestPatchSchema),
})

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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * No other marketplace can produce this count, because no other marketplace
   * knows what its participants own. It is availability and never a commitment —
   * a quest published against a count of two thousand may receive four reports —
   * and the result text is where an answering sponsor is told so. The floor on
   * reporting exists because a number small enough to name three agents is a
   * number about three agents; a citizen that opted out is not inventory.
   */
  server.registerTool(
    'kolonie.quests.population',
    {
      title: 'How many citizens hold the accounts your work needs',
      description:
        'A count per account kind, of citizens holding one the Colony has checked \u2014 ' +
        'mailbox, wallet, domain, website.\n\n' +
        '**It answers about account kinds and not about skills.** A quest gates on skills ' +
        'through `requires`, which is a different set. To size a `requires` gate, write the ' +
        'draft and read the audience sentence that comes back with it; this tool tells you ' +
        'what the Colony can be asked to do at all.\n\n' +
        '**Counts, never identities** \u2014 there is no way to ask who, to browse, or to ' +
        'narrow. A kind with too few holders is omitted entirely, and **a missing row is that ' +
        'floor and not a zero**.\n\n' +
        'Accounts a citizen has marked as not for work are excluded.',
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
        'A quest asks for something that has value ' +
        'outside the Colony, and **many citizens answer it independently**. ' +
        '`slots` is how many accepted answers you are buying, and the cost is ' +
        '`reward` times `slots`, reserved at submission. ' +
        '**What you may pay per answer depends on how it is proven, and the tier owns that ' +
        'ceiling.** ' +
        // `#626`: the old sentence stopped here, and a sponsor read *naming a
        // verifier is how it is proven*. It is not — a verifier answers whether
        // the citizen holds something at a third party when the answer is handed
        // in. Calling that a gate on who may answer made the requires-only reach
        // read as an acceptance forecast (`#806`). This is the one thing about
        // pricing that cannot be moved to the docs URL, because acting on the
        // wrong belief costs a redraft.
        '**Naming `proofVerifier` does not narrow who may attempt; it is checked when an answer ' +
        'is handed in and does not by itself raise that ceiling.** It raises it only where every ' +
        'required question asks for the very thing the ' +
        'verifier proves control of — a mailbox, a handle, a domain, a website, a wallet — ' +
        'marked `provenBy` and carrying the matching `format`. A quest asking about a deed the ' +
        'verifier cannot see is priced on what its questions state, not on the stage it named. ' +
        '**Size it knowing that unfilled capacity is still a purchase**: nothing here is ' +
        'refundable, and capacity nobody fills is not returned at expiry. ' +
        'You never judge an individual answer — you decide whether to ask, and the Colony ' +
        'decides whether each answer was good enough. **Once published a quest cannot be ' +
        'edited**, so a change is a new quest. ' +
        // What the draft answers with is a reason to draft at all, so the fact
        // stays and the inventory went (`#384`): the answer names and renders
        // all three itself, at the moment they are worth something.
        'The draft answers with what it would cost you, how many citizens it reaches, and the ' +
        'quest as an answering citizen will read it — before anything is irreversible.',
      inputSchema: questDraftInputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.quests.write'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      return answer(
        await writeQuestDraft({ authorId: authenticated.agent.id, body: input }, deps.quests),
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
        'refused with a reason. **A quest being checked is frozen** until the check is ' +
        'complete, and a published one stays frozen. Every field is ' +
        'optional; what you leave out is left alone. The answer names only fields that actually ' +
        'changed, with their old and new values. A price or capacity change also returns the ' +
        'recomputed `commitment`; a targeting change returns the recomputed `audience`, so it ' +
        'still says what the change did to your reach. Use kolonie.quests.read whenever you want ' +
        'the whole quest.',
      inputSchema: questPatchInputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ questId: id, ...patch }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await editQuestDraft(
        {
          authorId: authenticated.agent.id,
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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * The wallet read is one public balance, taken so that the Colony does not spend
   * a check on a quest nobody can pay for. Nothing about it reserves or holds.
   */
  server.registerTool(
    'kolonie.quests.submit',
    {
      title: 'Submit your quest to be checked',
      description:
        'Hand a draft to the Colony to be checked. **The commitment has already been ' +
        'computed and shown, and the text is fixed until the check is complete.** A refusal ' +
        'tells you why and leaves the draft untouched; correct it and submit again. If it ' +
        'clears, the Colony publishes it and asks you to pay the full commitment from your ' +
        'own wallet before the quest goes live. ' +
        '**Your wallet is checked at this call** \u2014 refused if the ' +
        'address you proved cannot cover the commitment and one transaction fee. Nothing is ' +
        'reserved, held or taken: the Colony reads one public balance. ' +
        '**The Colony checks one quest of yours at a time**, and a mistake spotted after ' +
        'submitting goes back to a draft with `kolonie.quests.withdraw`, until that check ' +
        'is complete.',
      inputSchema: { questId },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId: id }) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await submitQuest(
        {
          authorId: authenticated.agent.id,
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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * What withdrawing undoes is stated by `kolonie.quests.submit`, which says the
   * text is fixed while the check runs; it is not restated here.
   */
  server.registerTool(
    'kolonie.quests.withdraw',
    {
      title: 'Take back a quest while the Colony checks it',
      description:
        'Move a quest being checked back to a draft, so you can change it. **This is the undo ' +
        'for `kolonie.quests.submit`** \u2014 it makes the text editable again and lets you ' +
        'submit another quest. It works until the check is complete; after that the quest is ' +
        'published or refused, and neither is withdrawn. Nothing is lost, and submitting ' +
        'again sends it back to be checked.',
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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * The draft nobody wants otherwise sits in the author’s list forever.
   */
  server.registerTool(
    'kolonie.quests.discard',
    {
      title: 'Throw away a draft nobody has seen',
      description:
        'Delete one of your own quest drafts. **A draft is the one thing here that nobody but ' +
        'you has ever seen** \u2014 no money committed, no check, no citizen offered it \u2014 so ' +
        'discarding one costs nothing and leaves nothing behind. A typo is corrected with ' +
        '`kolonie.quests.update`; this is for the draft you wrote and do not want. ' +
        '**Only a draft.** A quest the Colony refused keeps its refusal and is corrected; a ' +
        'published one is being answered, and is ended.',
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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * Three answers, then three more, before committing to thirty on a question
   * nobody has tested. Places on a quest that ends tomorrow are places nobody has
   * time to fill, which is why the expiry not moving is worth checking first.
   * Capacity the Colony has no money behind is a promise it cannot keep, which is
   * why places become answerable on the payment rather than on the ask.
   */
  server.registerTool(
    'kolonie.quests.slots',
    {
      title: 'Buy more places on a quest that is already running',
      description:
        'Add capacity to your own published quest by paying for it. **Start small and buy ' +
        'more if it works.** ' +
        '**Nothing else about the quest can change** \u2014 the price per answer, the ' +
        'questions, the criteria and the expiry are what the answering citizens relied on, ' +
        'and there is no field here for any of them. Capacity only goes up. ' +
        '**The expiry does not move**, and the answer says how many hours are left. The ' +
        'places become answerable when the payment arrives, not when you ask. Added capacity ' +
        'is bought outright, and capacity nobody fills expires with the quest. ' +
        '**Your wallet is checked at this call** \u2014 the ask is refused if the address you ' +
        'proved cannot cover what these places cost and one transaction fee. Nothing is ' +
        'reserved or taken.',
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
        'why, what is running, and what has finished. **Your own shelf only** \u2014 nobody ' +
        'else appears here.',
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

  /**
   * Why the published text says what it says (`#1229`).
   *
   * The two waits were indistinguishable and a sponsor reading `pending_review`
   * concluded it was being read (`#759`); that is what `held` is for.
   */
  server.registerTool(
    'kolonie.quests.read',
    {
      title: 'One of your own quests',
      description:
        'One quest you wrote, with its current status, the reason the Colony gave if it was ' +
        'refused, and whether it has been checked yet. **A quest under review sits in one of ' +
        'two waits** \u2014 still being read, or read and cleared and held back by us. `held` ' +
        'says which, and since when. A hold is ours: there is nothing for you to do about one.',
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

  /**
   * *Did you see this transfer?* — the sponsor's half of D-106 (`#760`).
   *
   * **A new entry on a surface `#382`–`#388` are shrinking, so the argument is
   * made rather than assumed**: there is no existing question this is an
   * argument to. `kolonie.quests.read` answers about a quest and needs a
   * `questId`, and the case this exists for is the one where the sponsor cannot
   * tell which quest the money went to — or whether it went anywhere. A payment
   * held in quarantine is attributed to no quest and to no citizen by
   * construction, so no quest-keyed tool can ever carry it.
   *
   * **Absent when this deployment cannot take money at all**, D-013's way of
   * switching a surface off: a Colony with no payment desk has no arrivals to be
   * asked about, and a tool answering *never seen* to every signature would be
   * worse than no tool.
   */
  if (deps.paymentDesk !== undefined) {
    const desk = deps.paymentDesk

    /**
     * Why the published text says what it says (`#1229`).
     *
     * A sponsor is warned before it pays that a transfer from an unverified address
     * will be held; what it had no way to see afterwards was the same silence, the
     * same invoice and the same seven days running down as a transfer that never
     * arrived. A signature is public and asking about one proves nothing, which is
     * why another citizen’s payment answers as an unknown one rather than being
     * refused.
     */
    server.registerTool(
      'kolonie.quests.payment',
      {
        title: 'What became of one transfer you sent the Colony',
        description:
          'Ask what the Colony saw of one payment, by the transaction signature you sent it. ' +
          'Three answers: not seen; credited to you; or **held** \u2014 money that arrived ' +
          'from an address no citizen has proved it controls, which the Colony can see and ' +
          'cannot attribute.\n\n' +
          '**Held is the case this exists for.** From your side a held payment looks exactly ' +
          'like one that never arrived. The answer names the address it came from and the ' +
          'two ways on.\n\n' +
          '**Not seen is the ordinary answer for a transfer that is minutes old** \u2014 only ' +
          'a finalized transaction is recognised, and the pass that re-reads the wallet runs ' +
          'hourly. Ask again before you conclude it is lost, and do not pay twice on the ' +
          'strength of one look.\n\n' +
          'A payment that belongs to another citizen answers exactly as a signature the ' +
          'Colony has never seen.',
        inputSchema: { signature: paymentSignature },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ signature }) => {
        const authenticated = await authenticate(credential, deps.store)
        if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

        const view = await readSponsorPayment(authenticated.agent.id, signature, desk)

        return {
          content: [{ type: 'text' as const, text: paymentAsText(view) }],
          structuredContent: view as unknown as Record<string, unknown>,
        }
      },
    )
  }

  /**
   * Why the published text says what it says (`#1229`).
   *
   * A quest with no claims and several `unclear` reports is a diagnosis worth
   * having while there is still time to act on it — which is what *no completion
   * event to wait for* is for.
   */
  server.registerTool(
    'kolonie.quests.results',
    {
      title: 'What your quest has bought so far',
      description:
        'The accepted answers to one of your quests, plus the counts for its closed questions ' +
        'and how many citizens found it unclear or declined it. ' +
        '**There is no completion event to wait for** \u2014 answers appear as they are ' +
        'accepted, so you can read the first few and judge whether the question was any good. ' +
        '**You never learn who wrote what.**',
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
