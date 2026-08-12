import {
  AudienceQueryStringSchema,
  AuditDecisionSchema,
  QUEST_AUDIT_OFF,
  QUEST_ENDING_REASON_MAX_LENGTH,
  QUEST_REFUSAL_MIN_LENGTH,
  QUEST_PRICE_FLOOR_LAMPORTS,
  QUEST_TIER_CAPS_LAMPORTS,
  QuestDraftSchema,
  QuestEndingSchema,
  QuestPatchSchema,
  QuestReportSchema,
  QuestTopUpSchema,
  QUEST_MAX_SLOTS,
  QUEST_REFUSAL_LIMIT,
  SubmissionIdSchema,
  TaskIdSchema,
  audienceSentence,
  invoiceNotice,
  now,
  questHeldNotice,
  questCommitmentBreakdown,
  questCommitmentLines,
  platformFeePercentFromEnv,
  questFloorReach,
  questPriceFloorRejection,
  questRewardRejection,
  questSubmissionRejection,
  reportAudience,
  type AgentId,
  type QuestFloorTerms,
  type QuestFunding,
  type QuestPatch,
  questCapacityRejection,
  questFundingRejection,
  questInvoiceLamports,
  type AudienceQuery,
  type AudienceReport,
  type ApiError,
  type QuestAuditPolicy,
  type QuestReportCounts,
  type QuestAudience,
  type QuestReportKind,
  type QuestCommitmentBreakdown,
  type QuestTier,
  type Role,
  type SubmissionId,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import {
  createQuestDraft as createQuestDraftInDatabase,
  listOwnQuests as listOwnQuestsInDatabase,
  listAllQuests as listAllQuestsInDatabase,
  readAnyQuest as readAnyQuestInDatabase,
  type ColonyQuest,
  ownQuestAnswer as ownQuestAnswerInDatabase,
  questAnswerCounts as questAnswerCountsInDatabase,
  questAuditQueue as questAuditQueueInDatabase,
  questDisagreementRate as questDisagreementRateInDatabase,
  questResults as questResultsInDatabase,
  withheldReportCount as withheldReportCountInDatabase,
  withheldReportCounts as withheldReportCountsInDatabase,
  heldRedLineReports as heldRedLineReportsInDatabase,
  resolveHeldRedLine as resolveHeldRedLineInDatabase,
  type HeldReport,
  type RedLineRulingOutcome,
  questsTakenPartIn as questsTakenPartInInDatabase,
  type QuestTakenPartIn,
  fileQuestReport as fileQuestReportInDatabase,
  questReportCounts as questReportCountsInDatabase,
  questReportCountsFor as questReportCountsForInDatabase,
  endQuest as endQuestInDatabase,
  sponsorQuestReports as sponsorQuestReportsInDatabase,
  colonyNumbers as colonyNumbersInDatabase,
  holdingCounts,
  backendSections as backendSectionsInDatabase,
  recentArrivals as recentArrivalsInDatabase,
  tasksWithoutReports as tasksWithoutReportsInDatabase,
  briefingEffect as briefingEffectInDatabase,
  recordAuditDecision as recordAuditDecisionInDatabase,
  questPriceFloorInDatabase,
  questTierCapsInDatabase,
  verifiedSolanaAddress,
  readOwnQuest as readOwnQuestInDatabase,
  SKILLS_THE_ACADEMY_GRANTS,
  countAudience,
  type SettingsReader,
  submitQuestForReview as submitQuestForReviewInDatabase,
  updateQuestDraft as updateQuestDraftInDatabase,
  discardQuestDraft as discardQuestDraftInDatabase,
  topUpQuest as topUpQuestInDatabase,
  withdrawQuestFromReview as withdrawQuestFromReviewInDatabase,
  type AudienceCriteria,
  type Database,
  type OwnQuest,
  type AuditCandidate,
  type AuditRecordOutcome,
  type QuestResult as AcceptedReport,
  type FileQuestReportOutcome,
  type QuestSubmitOutcome,
  type QuestWithdrawOutcome,
  type QuestDiscardOutcome,
  type QuestTopUpOutcome,
  type QuestWriteOutcome,
  type Arrivals,
  type BackendSections,
  type TaskWithoutReports,
  type BriefingEffect,
  type ColonyNumbers,
  type HoldingCount,
  type QuestEndOutcome,
  type SponsorQuestReport,
} from '@kolonie-ai/db'
/**
 * The citizen's own renderer, imported rather than reimplemented (`#323`).
 *
 * It lives under `mcp/text` because that is the surface an answering citizen
 * reads through, and the preview a sponsor is shown has to be *that* text or it
 * is not a preview. `console/sponsor.ts` already states the rule for the browser
 * half — one renderer, two callers — and this is the same rule across one more
 * boundary: a second composition of the quest is a second answer to what it
 * says, and the one that drifts is the one nobody is reading.
 */
import type { PayoutChain } from './payouts.js'
import { taskAsText } from './mcp/text/tasks.js'

/**
 * Writing a quest, reviewing one, and publishing it (`#176`).
 *
 * **Every route here is reachable with a session or an API key, indifferently**
 * (`#172`). That is the mission rather than a convenience: an agent must be able
 * to do everything a human sponsor can, and a surface that quietly required a
 * browser would be the place where that stopped being true. Nothing in this file
 * reads the credential kind, and `callerFor` is what makes that hold.
 */

/**
 * What has happened to one quest, in the five numbers a sponsor can act on
 * (`#778`).
 *
 * **Why it is five and not one.** The quests list showed `accepted of slots`
 * and nothing else, and `0 of 3` is what a sponsor sees whether three citizens
 * claimed it and are still writing, a report is waiting on a verifier, or one
 * crossed a red line and is being held. The three are the same number and
 * different situations, and the sponsor was left to conclude the worst.
 *
 * `withheld` is a number and never the text, which is `withheldReportCount`'s
 * own rule and the reason this type carries no report of any kind.
 */
export interface QuestActivity extends QuestReportCounts {
  /** How many reports the Colony is holding back from this sponsor (`#446`). */
  readonly withheld: number
}

/** Everything the quest surface needs from the outside world. */
export interface QuestDesk {
  /**
   * The Colony's own wallet, where an invoice is paid — D-106 (`#504`).
   *
   * **Optional, and its absence is what stops an invoice being shown.** A
   * deployment with no wallet takes no payments (`#503`), and printing an
   * address for a sponsor to send money to would be the worst possible way to
   * find that out. On the desk rather than read from the environment here, for
   * the reason every other value on it is: this module holds no configuration.
   */
  readonly walletAddress?: string | undefined
  /**
   * What a quest of each tier may pay right now — D-104, `#630`.
   *
   * **Optional, and absent means the constants**, which is the same shape and
   * the same argument as `walletAddress` above: a desk assembled before this
   * existed keeps working, and what it falls back to is the figure
   * `governance/quests.md` has always named rather than the absence of a
   * ceiling. `capsOf` is the one place that reads it.
   *
   * A method rather than a value, because the whole point is that it is read at
   * the moment a quest is priced instead of when the process started.
   */
  tierCaps?(): Promise<Readonly<Record<QuestTier, number>>>
  /**
   * The least a quest may promise a citizen, right now — D-112, `#743`.
   *
   * Optional and defaulted exactly as `tierCaps` above, and absent means
   * `QUEST_PRICE_FLOOR_LAMPORTS` rather than the absence of a floor. `floorOf`
   * is the one place that reads it.
   */
  priceFloor?(): Promise<number>
  /**
   * What the sponsor's proved wallet holds right now (D-115, `#751`).
   *
   * **Optional, and absent means `{ outcome: 'unknown' }` rather than zero** —
   * the same shape `tierCaps` and `priceFloor` take, with the failure direction
   * that matters here spelled out. A desk that cannot ask has not learned that
   * the wallet is empty; it has learned nothing, and a submission goes through.
   */
  sponsorFunding?(agentId: AgentId): Promise<QuestFunding>
  create(input: { readonly authorId: AgentId; readonly draft: unknown }): Promise<OwnQuest>
  update(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly patch: unknown
    readonly at: Timestamp
  }): Promise<QuestWriteOutcome>
  submit(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly at: Timestamp
  }): Promise<QuestSubmitOutcome>
  /** Take it back out of the queue, to `draft` (`#323`). */
  /**
   * Buy more places on a running quest (`#629`).
   *
   * Optional for the reason every recent addition to this desk is: a fake or a
   * deployment assembled before it existed keeps compiling, and absent is
   * answered as `not_found` — which is what a route for a thing this deployment
   * cannot do should say.
   */
  /** Throw a draft away (`#631`). Optional for the reason `topUp` below is. */
  discard?(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
  }): Promise<QuestDiscardOutcome>
  topUp?(input: {
    readonly sponsorId: AgentId
    readonly taskId: TaskId
    readonly slots: number
  }): Promise<QuestTopUpOutcome>
  withdraw(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly at: Timestamp
  }): Promise<QuestWithdrawOutcome>
  /**
   * **`balance` and `movements` stood here** (`#553`, D-106).
   *
   * `balance` answered what a sponsor could still commit and `movements` was
   * the audit it could not be — *a balance is a number a citizen has to believe,
   * and this is the set of events it is the sum of.* Both described credits the
   * Colony held on somebody's behalf, and it holds none: a citizen is paid in
   * SOL to a wallet the Colony has no key to, and a sponsor pays a quest invoice
   * from its own.
   *
   * The audit half is not lost and did not need this desk: `kolonie.me.earnings`
   * (`#535`) is the citizen's record of what it was paid, with the transaction
   * signature, so it can check the chain rather than believe a number.
   */
  /**
   * The same money, decomposed per quest (`#324`).
   *
   * `reserved` is a scalar, and a sponsor with two quests settling could not
   * tell which of them had released what — so the refund rule was unobservable
   * even to somebody watching for it. This is the same rows summed differently
   * rather than a second record of the same fact.
   */
  /**
   * How many citizens this targeting could reach today (`#227`).
   *
   * On the quest desk beside `balance` and for the same reason `#180` put the
   * balance there: a sponsor is choosing an audience, and a criterion whose
   * effect on the audience is invisible until publication is a trap. The
   * criteria are passed rather than the quest, so the same question can be asked
   * of a draft that has not been written yet.
   */
  audience(criteria: AudienceCriteria): Promise<number>
  listOwn(authorId: AgentId): Promise<readonly OwnQuest[]>
  readOwn(authorId: AgentId, taskId: TaskId): Promise<OwnQuest | undefined>
  /**
   * Every quest in the Colony, whoever wrote it (`#776`).
   *
   * **Beside {@link listOwn} rather than a flag on it.** The two answer to
   * different guards — one to *is this yours*, one to `maintainer` — and a
   * reader whose access rule is *pass the right argument* is what the issue
   * behind these was filed about.
   */
  listAll(limit?: number): Promise<readonly ColonyQuest[]>
  /** One quest, whoever wrote it. Behind the same guard as {@link listAll}. */
  readAny(taskId: TaskId): Promise<ColonyQuest | undefined>
  /** The accepted reports on one quest (`#178`). */
  results(taskId: TaskId): Promise<readonly AcceptedReport[]>
  /**
   * How many reports the Colony is withholding from this sponsor (`#446`).
   *
   * A number and never the text. Beside {@link results} rather than inside it,
   * because it is a fact about what is *absent* from that list — and a caller
   * that forgot to ask would show a sponsor a complete-looking set.
   */
  withheld(taskId: TaskId): Promise<number>
  /**
   * {@link reportCounts} and {@link withheld} over a set of quests (`#778`).
   *
   * **Two round trips for a whole list, whatever its length.** The quests list
   * puts these figures on every row, and the singular readers called in a loop
   * are a query count that grows with how many quests somebody has written.
   * Both are the *same* readers underneath — the singular ones are these with
   * one id — so a sponsor's list and its `/quests/:questId/results` cannot
   * disagree about a number they both show.
   *
   * An id with nothing on it is absent from the map rather than zero in it.
   */
  activity(taskIds: readonly TaskId[]): Promise<ReadonlyMap<TaskId, QuestActivity>>
  /**
   * The quests this agent took part in, newest first (`#454`).
   *
   * Beside {@link results}, which answers the sponsor's question — *who
   * answered my quest* — while this answers the agent's operator's: *what has my
   * agent been paid for*. Same store, two directions, and the rows are assembled
   * by `questsTakenPartIn` rather than by a second query written for the page.
   */
  takenPartIn(agentId: AgentId): Promise<readonly QuestTakenPartIn[]>
  /** Counts per option, for the closed questions only. */
  counts(taskId: TaskId): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>>
  /** One citizen's own answers, in the shape the sponsor gets. */
  ownAnswer(input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
  }): Promise<AcceptedReport | undefined>
  /** The verdicts drawn for a second reading (`#221`). */
  auditQueue(stewardId: AgentId): Promise<readonly AuditCandidate[]>
  /** What a steward found. It changes nothing else. */
  audit(input: {
    readonly submissionId: SubmissionId
    readonly stewardId: AgentId
    readonly agrees: boolean
    readonly reason: string
  }): Promise<AuditRecordOutcome>
  /** How often the judge has been overruled lately. */
  disagreement(): Promise<{ readonly rate: number; readonly audited: number }>
  /** Reports a model flagged on a red line, waiting on a steward (`#446`). */
  heldReports(): Promise<readonly HeldReport[]>
  /** A steward ends one of those, in either direction (`#446`). */
  ruleOnHeldReport(input: {
    readonly submissionId: SubmissionId
    readonly stewardId: AgentId
    readonly crossed: boolean
    readonly reason: string
  }): Promise<RedLineRulingOutcome>
  /**
   * A citizen says something about a quest without completing it (`#240`).
   *
   * On this desk rather than on the guidance desk, deliberately: a task report
   * is published to other citizens through a briefing and a quest report is
   * published to nobody, and putting them behind one port is the first step
   * towards one of them being served where the other belongs.
   */
  report(input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly kind: QuestReportKind
    /** The paragraph, on the three kinds that carry one. */
    readonly text?: string
    /** The three answers, on an `obstacle` report (`#367`). */
    readonly did?: string
    readonly broke?: string
    readonly changed?: string
  }): Promise<FileQuestReportOutcome>
  /** The scrubbed `unclear` and `feedback` text, for the sponsor and the steward. */
  reports(taskId: TaskId): Promise<readonly SponsorQuestReport[]>
  /** Claims, accepted reports, and the two counts — visible while the quest runs. */
  reportCounts(taskId: TaskId): Promise<QuestReportCounts>
  /**
   * End a running quest: the sponsor for its own, a steward for any (`#619`).
   *
   * `stewarding` is asserted by the route, which is the only place that knows
   * whether the caller holds the role — the same division `publish` follows.
   */
  end(input: {
    readonly actorId: AgentId
    readonly taskId: TaskId
    readonly reason: string
    readonly at: Timestamp
    readonly stewarding: boolean
  }): Promise<QuestEndOutcome>
  /**
   * The review queue with everything needed to decide a quest on one screen
   * (`#181`).
   *
   * It takes the reader's id because one of the things shown is *you wrote
   * this*: a steward's own quests appear in the queue, marked and not
   * actionable, rather than being filtered out.
   */
  /** The Colony's own numbers, each with the moment it was computed (`#181`). */
  numbers(): Promise<ColonyNumbers>
  /**
   * How many citizens hold a proved account of each kind (`#524`).
   *
   * **On this desk because a sponsor is who asks**, and beside `numbers()`
   * rather than inside it: those are the Colony's figures about itself, gated by
   * `kolonie-docs#216`, and this is a market figure answered to somebody with a
   * reason to ask before it commits money.
   */
  holdings(): Promise<readonly HoldingCount[]>
  /**
   * Who arrived and what is waiting, for `/backend` (`#487`).
   *
   * **Beside `numbers()` rather than inside it.** That one is aggregates
   * entirely — `permissionBlocks` suppresses thin rows in SQL to keep it that
   * way — and these are individual rows. Folding them in would put the change
   * of kind somewhere nobody reviewing an aggregate would look for it.
   */
  backendSections(): Promise<BackendSections>
  /** Who arrived, people and agents, for `/backend` only (`#607`). */
  arrivals(): Promise<Arrivals>
  /** Which tasks the Colony knows nothing about, with attempt counts (`#611`). */
  unreported(): Promise<readonly TaskWithoutReports[]>
  /** Whether a briefing changes an outcome (`#609`). */
  briefingEffect(): Promise<readonly BriefingEffect[]>
}

/** The quest desk, backed by Postgres. */
export function databaseQuests(
  db: Database,
  audit: QuestAuditPolicy = QUEST_AUDIT_OFF,
  /**
   * The Colony's wallet, appended rather than inserted (`#504`).
   *
   * Appended because a mid-signature insertion breaks every caller silently:
   * `audit` already has a default and a third parameter added before it would
   * be read as one. Absent means this deployment shows no invoice, which is the
   * same thing it means everywhere else.
   */
  walletAddress?: string,
  /**
   * The settings reader the tier ceilings are read through (`#630`).
   *
   * Appended for the reason `walletAddress` was, and optional for a narrower
   * one: absent means the constants, which is what every deployment had before
   * the settings existed. It is the process's one reader rather than a new one —
   * two caches would be two answers to *what is the ceiling* for up to thirty
   * seconds after a maintainer changed it.
   */
  settings?: SettingsReader,
  /**
   * The chain, for reading a sponsor's balance before its quest is moderated
   * (D-115, `#751`).
   *
   * Appended for the reason `walletAddress` and `settings` were. Absent means
   * this deployment cannot ask — exactly as an absent `walletAddress` means it
   * shows no invoice — and every submission that was accepted before is still
   * accepted.
   *
   * `Pick<PayoutChain, 'balance'>` and not the whole port: this reads one public
   * balance and holds no key, sends nothing and signs nothing, and a narrower
   * type is what says so to the next reader.
   */
  chain?: Pick<PayoutChain, 'balance'>,
): QuestDesk {
  return {
    ...(walletAddress === undefined ? {} : { walletAddress }),
    ...(settings === undefined
      ? {}
      : {
          tierCaps: () => questTierCapsInDatabase(settings),
          priceFloor: () => questPriceFloorInDatabase(settings),
        }),
    sponsorFunding: async (agentId) => {
      const address = await verifiedSolanaAddress(db, agentId)
      if (address === null) return { outcome: 'no-wallet' }
      if (chain === undefined) return { outcome: 'unknown' }

      /**
       * **A throw is `unknown` and never a zero**, which is the outage rule and
       * the one line of this a future refactor is most likely to break quietly.
       * An endpoint that is down, rate-limited or answering strangely has told
       * the Colony nothing about this sponsor's wallet, and refusing every
       * submission because of it is a worse failure than moderating one unfunded
       * quest.
       */
      try {
        return { outcome: 'known', address, lamports: await chain.balance(address) }
      } catch {
        return { outcome: 'unknown' }
      }
    },
    create: (input) =>
      createQuestDraftInDatabase(db, {
        authorId: input.authorId,
        draft: QuestDraftSchema.parse(input.draft),
      }),
    update: (input) =>
      updateQuestDraftInDatabase(db, {
        authorId: input.authorId,
        taskId: input.taskId,
        patch: QuestPatchSchema.parse(input.patch),
        at: input.at,
      }),
    submit: (input) => submitQuestForReviewInDatabase(db, input),
    withdraw: (input) => withdrawQuestFromReviewInDatabase(db, input),
    topUp: (input) => topUpQuestInDatabase(db, input),
    discard: (input) => discardQuestDraftInDatabase(db, input),
    audience: (criteria) => countAudience(db, criteria),
    listOwn: (authorId) => listOwnQuestsInDatabase(db, authorId),
    readOwn: (authorId, taskId) => readOwnQuestInDatabase(db, authorId, taskId),
    listAll: (limit) => listAllQuestsInDatabase(db, limit),
    readAny: (taskId) => readAnyQuestInDatabase(db, taskId),
    results: (taskId) => questResultsInDatabase(db, taskId),
    withheld: (taskId) => withheldReportCountInDatabase(db, taskId),
    activity: async (taskIds) => {
      const [counts, withheld] = await Promise.all([
        questReportCountsForInDatabase(db, taskIds),
        withheldReportCountsInDatabase(db, taskIds),
      ])

      return new Map(
        [...counts].map(([taskId, row]) => [
          taskId,
          { ...row, withheld: withheld.get(taskId) ?? 0 },
        ]),
      )
    },
    takenPartIn: (agentId) => questsTakenPartInInDatabase(db, agentId),
    counts: (taskId) => questAnswerCountsInDatabase(db, taskId),
    ownAnswer: (input) => ownQuestAnswerInDatabase(db, input),
    auditQueue: (stewardId) => questAuditQueueInDatabase(db, audit, undefined, stewardId),
    audit: (input) => recordAuditDecisionInDatabase(db, input),
    disagreement: () => questDisagreementRateInDatabase(db, audit),
    heldReports: () => heldRedLineReportsInDatabase(db),
    ruleOnHeldReport: (input) => resolveHeldRedLineInDatabase(db, input),
    report: (input) => fileQuestReportInDatabase(db, input),
    reports: (taskId) => sponsorQuestReportsInDatabase(db, taskId),
    reportCounts: (taskId) => questReportCountsInDatabase(db, taskId),
    end: (input) => endQuestInDatabase(db, input),
    numbers: () => colonyNumbersInDatabase(db),
    holdings: () => holdingCounts(db),
    backendSections: () => backendSectionsInDatabase(db),
    arrivals: () => recentArrivalsInDatabase(db),
    unreported: () => tasksWithoutReportsInDatabase(db),
    briefingEffect: () => briefingEffectInDatabase(db),
  }
}

/**
 * File a quest report, and say what happened in the citizen's own terms
 * (`#240`).
 *
 * **The refusals are two and both are about the request.** An unknown quest, and
 * a body that is not one of the three kinds — the second is the schema's, so it
 * never reaches here. There is no refusal about the citizen: any of the three
 * may be filed by somebody that only read the quest, and `unclear` in particular
 * is most valuable from a citizen that never claimed.
 */
export async function fileQuestReport(
  agentId: AgentId,
  input: unknown,
  desk: QuestDesk,
): Promise<{ readonly filed: true; readonly replaced: boolean } | { readonly error: ApiError }> {
  const parsed = QuestReportSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: {
        code: 'validation_failed',
        message:
          'A quest report carries a `taskId` and a `kind`. For `unclear`, `feedback` or ' +
          '`declined`, add the `text` you want to say. For `obstacle`, answer any of `did`, ' +
          '`broke` and `changed` instead and send no `text` — that kind asks the three ' +
          'questions `kolonie.tasks.report` asks, because only one of the three may be shown ' +
          'to another citizen.',
      },
    }
  }

  const result = await desk.report({
    taskId: TaskIdSchema.parse(parsed.data.taskId),
    agentId,
    kind: parsed.data.kind,
    // Spread rather than passed as `undefined`, so the write sets exactly the
    // columns the kind allows and clears the ones it does not (`#367`).
    ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
    ...(parsed.data.did === undefined ? {} : { did: parsed.data.did }),
    ...(parsed.data.broke === undefined ? {} : { broke: parsed.data.broke }),
    ...(parsed.data.changed === undefined ? {} : { changed: parsed.data.changed }),
  })

  if (result.outcome === 'unknown-quest') {
    return {
      error: {
        code: 'not_found',
        message:
          'No quest with that id. This channel is for quests — an Academy rung takes ' +
          '`kolonie.tasks.report` instead.',
      },
    }
  }

  /**
   * **Nothing is said about a bonus any more** (D-114, `#752`). A report told
   * its author whether it would earn one, because an obstacle from a citizen
   * that had never attempted the quest was welcome and unpaid, and finding that
   * out from a payment that never arrived was the wrong way to learn it. No
   * report is paid now, so there is nothing to withhold and nothing to explain.
   */
  return { filed: true, replaced: result.replaced }
}

/**
 * What this quest would commit, against what the account has (`#323`).
 *
 * **Echoed at every step and not only at the one that spends it.** The
 * arithmetic is `reward.credits × slots` and a sponsor can do it — the one that
 * reported this did, correctly, for its whole balance. What it could not do is
 * find out that it had done it right before the irreversible step: the first
 * confirmation the Colony gave was the reservation appearing *after* submission,
 * which is also the step that freezes the text and takes the queue slot. A
 * mistyped `200` for `20` failed at submission with an unpayable-quest error,
 * one step after the moment it could have been corrected for free.
 *
 * **`cost` is computed by `questCommitment`**, the same function
 * `submitQuestForReview` checks against. An echo derived a second way would be a
 * number that agrees until it does not, and the failure would be a sponsor
 * shown an affordable quest and refused it.
 */
export interface QuestCommitment {
  /**
   * What the quest will cost — price × slots.
   *
   * **The only field left, and the three that went are the point** (`#553`,
   * D-106). It carried `balance`, `reserved` and `affordable` as well, because
   * `#174` reserved a sponsor's credits at submission and the form had to show
   * whether they covered the quest. There is no balance: a sponsor pays an
   * invoice from its own wallet **after** a steward publishes, and the Colony
   * has no key to that wallet and does not watch it.
   *
   * So *can you afford this* is not a question the Colony can answer, and a
   * boolean computed from a number it does not have would be a guess with an
   * air of authority. What it can say is what the quest costs, which is this.
   */
  readonly cost: number
  /**
   * What that figure is made of (`#628`).
   *
   * **`cost` alone was a number with an unexplained part in it.** A draft of
   * three answers at 0.01 SOL costs 0.045: thirty million for the answers and
   * fifteen million of obstacle pool that appeared on no surface a sponsor
   * reads. The design was right and documented — in a source file.
   */
  readonly breakdown: QuestCommitmentBreakdown
  /**
   * The same thing as a person reads it.
   *
   * **Here rather than composed per surface**, so the browser, the MCP answer
   * and the REST body cannot itemise one commitment three ways. A caller that
   * wants its own layout has `breakdown`.
   */
  readonly lines: readonly string[]
}

/**
 * What a sponsor is told about its own quest.
 *
 * The task as everybody else would read it, plus the things only its author is
 * entitled to: why a steward refused it, whether it is still waiting on the
 * moderation stage, what it would cost, and how it reads from the other side.
 * The moderation flag is there so a sponsor watching a quest that has not
 * reached the queue is not left wondering whether anything is happening.
 */
/**
 * What a caller is told when it ends a quest (`#619`).
 *
 * **Three facts, and the last two exist because a sponsor would otherwise have
 * to guess at them**: the quest as it now stands, how many citizens were still
 * working it when it stopped, and what happened to the money.
 *
 * `escrow` is a word rather than a number because there is no number to report:
 * nothing moves. It is stated anyway, in the same field every time, so that *the
 * money did not move* is an answer the Colony gave rather than an absence a
 * sponsor read something into.
 */
export interface QuestEndedResponse {
  readonly quest: OwnQuestResponse
  /** How many live claims survived the ending. Counted, never named. */
  readonly attemptsStillOpen: number
  /** What became of what the sponsor paid. `not-returned` is the only value D-106 allows. */
  readonly escrow: 'not-returned'
  /** The same two facts as a sentence, for a surface that shows one line. */
  readonly notice: string
}

export interface OwnQuestResponse {
  readonly quest: Task
  readonly rejectionReason: string | null
  readonly awaitingModeration: boolean
  /**
   * That the Colony is holding this quest back, and since when (`#759`).
   *
   * **The third thing `pending_review` meant, and the only one a sponsor had no
   * word for.** *Being read* and *read and refused* were already answerable;
   * *read, cleared, and not published by us* looked exactly like the first, so a
   * sponsor whose quest sat still for fourteen hours was shown what a sponsor
   * whose quest arrived a minute ago was shown, and had no question it could ask
   * that would separate them.
   *
   * **The sentence names no mechanism, and that is the point.** Why the Colony
   * is holding it is the Colony's business — a configuration of ours is not a
   * fact about the sponsor's quest, and printing it would invite a sponsor to
   * act on something it cannot change. What is the sponsor's business is that
   * the wait is ours and that there is nothing for it to do, and `notice` says
   * both.
   *
   * Absent while nothing is holding the quest, so the ordinary case carries no
   * field a reader has to interpret as *not held*.
   */
  readonly held?: {
    readonly since: Timestamp
    readonly notice: string
  }
  readonly commitment: QuestCommitment
  /**
   * The quest as an answering citizen reads it (`#323`).
   *
   * **The same renderer `kolonie.tasks.get` uses, and that is the whole of why
   * it can be trusted.** A preview composed separately is a second answer to
   * *what does this say*, and the one that drifts is the one nobody is reading
   * — which is the failure the sponsor console already avoids by making its
   * preview and the citizen's view one function.
   *
   * It matters most at the step that cannot be undone. `update` is refused once
   * a quest is `pending_review` and a published quest is frozen for a reason
   * `#178` is right about — two cohorts that answered two different questions
   * are indistinguishable afterwards — so the last moment a sponsor can fix its
   * wording was, until this field, the first moment it could see it.
   */
  readonly preview: string
  /**
   * What the requirement set reaches, and what requiring it cost (`#351`).
   *
   * **Beside `commitment`, and for the same reason.** The cost of the money is
   * stated at the moment the money is committed; the cost of a requirement was
   * stated nowhere, at no moment — a sponsor adding `requires` learned that it
   * went from forty possible answerers to four when nobody answered, weeks
   * later, with no way to attribute the silence.
   *
   * **Absent on a listing, present on every answer to a write.** It costs two
   * counted queries, which is right where a sponsor has just changed the
   * targeting and wrong once per row of a list of its quests. `listQuests` is
   * the only caller that leaves it out, and a client reading a list has the
   * quest's id to ask about.
   */
  readonly audience?: QuestAudience | undefined
  /**
   * What this quest costs and what has been paid, while it waits — D-106
   * (`#504`).
   *
   * **Present only on a quest that is waiting for its money.** The four facts a
   * sponsor would otherwise find out afterwards are in `notice`, in one
   * sentence-block, because they are read at the moment the sponsor decides
   * whether to send — not in a document it would have to go and find.
   */
  readonly invoice?: {
    readonly lamports: number
    readonly paidLamports: number
    readonly outstandingLamports: number
    readonly walletAddress: string
    readonly notice: string
  }
}

/** The persisted before and after values that make an edit answer self-contained. */
export interface QuestFieldChange {
  readonly field: keyof QuestPatch
  readonly from: unknown
  readonly to: unknown
}

/** The full quest remains available to REST while MCP can report only what moved. */
export interface QuestEditedResponse {
  readonly quest: OwnQuestResponse
  readonly changes: readonly QuestFieldChange[]
}

export type QuestResult<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const invalid = (message: string): ApiError => ({ code: 'validation_failed', message })

/**
 * *No such quest* and *not yours* are one answer, deliberately.
 *
 * A distinguishable refusal would let anybody holding a credential enumerate
 * which task ids are quests and who owns them — the same argument the sign-in
 * route makes about a known address, and the reason `readOwnTicket` answers one
 * way too.
 */
const NO_SUCH_QUEST: ApiError = {
  code: 'not_found',
  message: 'No quest of yours has that id.',
}

const notFound = <T>(): QuestResult<T> => ({ outcome: 'rejected', error: NO_SUCH_QUEST })

/**
 * One shape for every answer about a sponsor's own quest.
 *
 * **A balance was passed in until `#553`**, so a list of quests cost one read of
 * it rather than one per row. There is no balance under D-106, and what is left
 * — the cost — is computed from the quest itself, so this function is now what
 * its comment always claimed: an assembly with no questions of its own.
 */
const respond = (
  quest: OwnQuest,
  audience?: QuestAudience,
  walletAddress?: string,
): OwnQuestResponse => {
  /**
   * **Itemised as well as totalled** (`#628`). The sponsor was shown one figure
   * and had to read `quest.ts` to learn what the part above capacity × price
   * was. `questCommitmentBreakdown` derives both from the functions the escrow
   * uses, so the lines cannot sum to something other than what is taken.
   */
  const priced = {
    reward: quest.task.reward,
    slots: quest.task.slots ?? 0,
  }
  const breakdown = questCommitmentBreakdown(priced, {
    // The rate a draft *would* be published under: nothing has recorded one yet,
    // and `tasks.platform_fee_percent` is written at publication.
    feePercent: quest.task.platformFeePercent ?? platformFeePercentFromEnv(),
  })
  const cost = breakdown.total

  return {
    quest: quest.task,
    rejectionReason: quest.rejectionReason,
    awaitingModeration: quest.awaitingModeration,
    ...(quest.heldSince === null
      ? {}
      : { held: { since: quest.heldSince, notice: questHeldNotice(quest.heldSince, now()) } }),
    commitment: {
      cost,
      breakdown,
      /** The same thing as a person reads it, so no surface writes its own. */
      lines: questCommitmentLines(breakdown),
    },
    /**
     * Rendered with the citizen's own renderer, called as it is called for a
     * citizen that has never attempted this: no struggle count, no briefing
     * written yet (`#78`), first attempt, nothing withheld. A preview that
     * quietly rendered a different variant would be answering a question the
     * sponsor did not ask.
     */
    preview: taskAsText(quest.task, 0, false, 1, false),
    ...(audience === undefined ? {} : { audience }),
    /**
     * The invoice, and it is deliberately silent when there is no wallet
     * configured: a deployment that cannot take payments must not print an
     * address for a sponsor to send money to.
     */
    ...(quest.invoice === undefined || walletAddress === undefined
      ? {}
      : {
          invoice: {
            lamports: quest.invoice.lamports,
            paidLamports: quest.invoice.paidLamports,
            outstandingLamports: Math.max(0, quest.invoice.lamports - quest.invoice.paidLamports),
            walletAddress,
            notice: invoiceNotice({
              lamports: quest.invoice.lamports,
              paidLamports: quest.invoice.paidLamports,
              walletAddress,
            }),
          },
        }),
  }
}

/**
 * What this quest's targeting reaches, and what requiring skills cost it
 * (`#351`).
 *
 * **Two counts, asked as one question.** The second is the same targeting with
 * the requirement removed and every other axis left alone, because the sentence
 * is about what the *requirement* cost — a comparison against no criteria at all
 * would quietly bill the activity window for a narrowing it did not do.
 *
 * A quest that requires nothing asks once and answers itself: the two numbers
 * are the same number, and the second query would be a query for a difference
 * that cannot exist.
 */
const audienceOf = async (task: Task, desk: QuestDesk): Promise<QuestAudience> => {
  const criteria = {
    audience: task.audience,
    requires: task.requires,
    minReputation: task.minReputation,
    minActivityDays: task.minActivityDays,
  }

  const reached = await desk.audience(criteria)
  const unrestricted =
    task.requires.length === 0 ? reached : await desk.audience({ ...criteria, requires: [] })

  const reports = {
    reach: reportAudience(reached),
    unrestricted: reportAudience(unrestricted),
    requires: task.requires,
  }

  return { ...reports, sentence: audienceSentence(reports) }
}

/** The same, for the calls that have the quest and need its audience. */
const responding = async (quest: OwnQuest, desk: QuestDesk): Promise<OwnQuestResponse> => {
  const audience = await audienceOf(quest.task, desk)

  return respond(quest, audience, desk.walletAddress)
}

/**
 * The ceilings in force, or the constants where a desk does not carry them.
 *
 * One reader, so the fallback is decided once rather than at each of the two
 * call sites that price a quest.
 */
const capsOf = async (desk: QuestDesk): Promise<Readonly<Record<QuestTier, number>>> =>
  desk.tierCaps === undefined ? QUEST_TIER_CAPS_LAMPORTS : await desk.tierCaps()

/**
 * What this sponsor's wallet holds, or that the Colony could not ask (D-115,
 * `#751`).
 *
 * `capsOf`'s reader, with the fallback that matters spelled out: **a desk with
 * no `sponsorFunding` answers `unknown` and not an empty wallet.** A deployment
 * with no RPC endpoint cannot ask this question, which is a different fact from
 * the sponsor failing it, and one reader is what keeps the two from being
 * conflated at each of the two call sites.
 */
const fundingOf = async (desk: QuestDesk, agentId: AgentId): Promise<QuestFunding> =>
  desk.sponsorFunding === undefined ? { outcome: 'unknown' } : await desk.sponsorFunding(agentId)

/**
 * The floor in force and the two rates it is measured against (D-112, `#743`).
 *
 * One reader for `capsOf`'s reason, and it assembles both figures because the
 * floor is a statement about what arrives: the fee decides what an accepted
 * answer is paid, and that is the whole of what a quest pays (D-114, `#752`).
 *
 * **The fee is the rate a draft *would* be published under**, which is what
 * `respond` above already uses for the sponsor's preview. A published quest
 * carries its own on the row and passes it, so a rate change never re-prices a
 * quest whose money is already committed.
 */
const floorOf = async (desk: QuestDesk, feePercent?: number): Promise<QuestFloorTerms> => ({
  lamports: desk.priceFloor === undefined ? QUEST_PRICE_FLOOR_LAMPORTS : await desk.priceFloor(),
  feePercent: feePercent ?? platformFeePercentFromEnv(),
})

/**
 * Why this caller may not publish a quest that pays no lamports, or `undefined`
 * (D-112, `#744`).
 *
 * **Zero has to stay available and must not be available to everyone.** The
 * Colony needs to ask its citizens something without invoicing itself; a citizen
 * publishing for nothing can publish without limit, and the cost is the only
 * thing standing between the quest list and a list of asking. So the gate is a
 * role rather than an account type — `AccountTypeSchema` has no `colony` member
 * and inventing one to answer this would be a much larger change than the rule
 * warrants.
 *
 * **`steward`, and that was decided rather than weighed here.** It is already the
 * quest-domain role, it is granted only by another steward — held to that in the
 * database by `tasks_only_colony_grants_roles`, so nothing an ordinary citizen
 * can do opens this gate — and the conflict-of-interest bans that travel with it
 * (D-052) mean the *steward publishes its own quest* case is already answered.
 * `governor` was the alternative and was rejected: it would hold a quest power it
 * has no other reason to exercise, while a steward would lack one it obviously
 * should.
 *
 * **Here rather than in `packages/core`.** `questRewardRejection` takes a quest
 * and knows nothing about who is asking, and giving it a caller would put an
 * authorisation question inside the domain model. It reads the roles beside that
 * call instead, so a sponsor still gets one sentence about its reward.
 *
 * **Off when the floor is off.** `questPriceFloor` reads `0` as *this rule is not
 * in force*, and gating zero while a one-lamport quest is waved through would be
 * theatre — a deployment that turned the floor off has said it is not policing
 * what a quest promises.
 */
const unpaidQuestRejection = (
  quest: {
    readonly publishObstacles?: boolean | undefined
    readonly reward: { readonly lamports: number }
  },
  roles: readonly Role[],
  floor: QuestFloorTerms,
): string | undefined => {
  if (quest.reward.lamports > 0 || floor.lamports <= 0) return undefined
  if (roles.includes('steward')) return undefined

  const smallest = questFloorReach(floor)

  return (
    "a quest that pays no lamports is the Colony's own to publish, and a citizen publishing one " +
    'pays for it: what a quest costs is what makes a sponsor weigh whether the question is worth ' +
    'asking, and asking for nothing is the one thing a quest list cannot survive much of. ' +
    // Both ways forward, because both are real (`#744`). A citizen with a good
    // question and no role should not have to read *you lack a role* and guess.
    (smallest === null
      ? 'At a platform fee of 100% no price reaches a citizen either, so the only way this quest ' +
        'is published is by the Colony: ask for it with kolonie.support.open, kind proposal.'
      : `There are two ways forward and both are real: price it at ${smallest} lamports or more, ` +
        'which is what reaches the floor a citizen is owed; or ask the Colony to publish it for ' +
        'you — kolonie.support.open, kind proposal, is where that is asked, and a question the ' +
        'Colony wants answered is one it will pay for itself.') +
    ' Reputation is paid alongside either and is not what this is about.'
  )
}

/** Write a new draft. */
export async function writeQuestDraft(
  input: {
    readonly authorId: AgentId
    /** What the caller holds, for the zero-reward gate (`#744`). */
    readonly roles: readonly Role[]
    readonly body: unknown
  },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const parsed = QuestDraftSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'A quest carries a title, a description, instructions, a reward, the number of ' +
          'citizens it is for, and the moment it expires.',
      ),
    }
  }

  const ungranted = skillsTheAcademyDoesNotGrant(parsed.data.requires)
  if (ungranted !== undefined) return { outcome: 'rejected', error: ungranted }

  /**
   * **The tier ceiling, enforced — which nothing did until `#630`.**
   *
   * `questRewardRejection` was written with `#175`, tested, and named in
   * `governance/quests.md` as the rule that gives the tier names their meaning.
   * It had no caller outside its own test file: every write path reached
   * `createQuestDraft` without it, and a soft quest could be drafted at any
   * price. Making the ceilings turnable without also making them bite would
   * have shipped a dial connected to nothing.
   *
   * **Here rather than in storage**, beside the requirement check, because both
   * are the same kind of refusal — a quest that is well-formed and would be
   * wrong to accept — and this is where the sentence a sponsor reads is written.
   *
   * **Three rules, one sentence** (`#630`, `#743`, `#744`): the ceiling, the floor
   * and who may pay nothing. They are asked in that order and the first to answer
   * wins, so a sponsor reads one thing about its reward rather than three.
   */
  const floor = await floorOf(desk)
  const priced =
    questRewardRejection(parsed.data, await capsOf(desk), floor) ??
    unpaidQuestRejection(parsed.data, input.roles, floor)
  if (priced !== undefined) {
    return { outcome: 'rejected', error: invalid(capitalised(priced)) }
  }

  const quest = await desk.create({ authorId: input.authorId, draft: parsed.data })
  return { outcome: 'ok', response: await responding(quest, desk) }
}

/**
 * The core sentence, as the start of one.
 *
 * `questRewardRejection` returns a clause the seed and the write path each embed
 * in their own error — the shape `rewardRejection` established — so the caller
 * that uses it as the whole message is the one that has to capitalise it.
 */
const capitalised = (sentence: string): string =>
  `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`

/**
 * Why this requirement set cannot be met by anybody, or `undefined` (`#352`).
 *
 * **A requirement naming a skill the Academy does not grant is refused rather
 * than accepted and quietly emptied.** The quest would be well-formed, publish
 * normally, and be offered to nobody — a failure that is silent at every stage
 * and only visible at expiry, by which time the sponsor has paid for a cohort
 * that was never reachable. The console has refused this since `#180`; this is
 * the same refusal on the surface an agent sponsor actually uses.
 *
 * The set is derived from the seeded rungs rather than restated here, so a rung
 * that starts granting something new widens this without an edit.
 */
function skillsTheAcademyDoesNotGrant(requires: readonly string[]): ApiError | undefined {
  const unknown = requires.filter((skill) => !SKILLS_THE_ACADEMY_GRANTS.includes(skill))
  if (unknown.length === 0) return undefined

  return invalid(
    `The Colony does not grant ${unknown.join(', ')}, so no citizen can hold it and this quest ` +
      'would be offered to nobody while looking correct. What may be required: ' +
      `${SKILLS_THE_ACADEMY_GRANTS.join(', ')}.`,
  )
}

/** Change a draft, or correct a refused quest. */
export async function editQuestDraft(
  input: {
    readonly authorId: AgentId
    /** What the caller holds, for the zero-reward gate (`#744`). */
    readonly roles: readonly Role[]
    readonly questId: string | undefined
    readonly body: unknown
    readonly at: Timestamp
  },
  desk: QuestDesk,
): Promise<QuestResult<QuestEditedResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const parsed = QuestPatchSchema.safeParse(input.body)
  if (!parsed.success) {
    return { outcome: 'rejected', error: invalid('That is not a change a quest accepts.') }
  }

  if (parsed.data.requires !== undefined) {
    const ungranted = skillsTheAcademyDoesNotGrant(parsed.data.requires)
    if (ungranted !== undefined) return { outcome: 'rejected', error: ungranted }
  }

  /**
   * **An edit is revalidated against the quest it produces** (`#631`).
   *
   * `#630` wired the tier ceiling into the write and the submit and said plainly
   * that it could not be checked here: a patch is a subset of fields, and the
   * tier depends on the price, the verifier and every question at once. So the
   * current quest is read and the patch applied to it, and the merged shape is
   * judged exactly as a fresh draft would be.
   *
   * **A read this path did not do before**, and it costs one query on an edit —
   * which is the cheapest of the surfaces here and the one where a refusal is
   * most useful, because the author is still typing.
   */
  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return notFound()

  const merged = { ...own.task, ...parsed.data }
  const floor = await floorOf(desk)
  /**
   * **The zero gate on the merged quest, not on the patch** (`#744`). A draft
   * priced above the floor and then edited down to nothing is the way past a gate
   * that only reads the write path, and it is the fourth case the issue names.
   */
  const priced =
    questRewardRejection(merged, await capsOf(desk), floor) ??
    unpaidQuestRejection(merged, input.roles, floor)
  if (priced !== undefined) {
    return { outcome: 'rejected', error: invalid(capitalised(priced)) }
  }

  const result = await desk.update({
    authorId: input.authorId,
    taskId,
    patch: parsed.data,
    at: input.at,
  })

  switch (result.outcome) {
    case 'written': {
      const before = own.task as unknown as Readonly<Record<string, unknown>>
      const after = result.quest.task as unknown as Readonly<Record<string, unknown>>
      const changes = (Object.keys(parsed.data) as (keyof QuestPatch)[]).flatMap((field) =>
        JSON.stringify(before[field]) === JSON.stringify(after[field])
          ? []
          : [{ field, from: before[field], to: after[field] }],
      )
      return {
        outcome: 'ok',
        response: { quest: await responding(result.quest, desk), changes },
      }
    }
    case 'not-editable':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: frozen(result.status),
        },
      }
    default:
      return notFound()
  }
}

/** A draft that is gone, and the id it was (`#631`). */
export interface QuestDiscardedResponse {
  readonly questId: TaskId
  readonly discarded: true
  readonly notice: string
}

/**
 * Throw away an unseen draft, or a refused draft whose correction thread is spent.
 *
 * **Only its author's, and only before publication.** A refused quest is
 * normally corrected rather than discarded. After three refusals, deleting it
 * is the point of the limit: the accumulated thread goes away and a new draft
 * starts free.
 */
export async function discardQuestDraft(
  input: { readonly authorId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<QuestDiscardedResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()
  if (desk.discard === undefined) return notFound()

  const result = await desk.discard({ authorId: input.authorId, taskId })

  switch (result.outcome) {
    case 'discarded':
      return {
        outcome: 'ok',
        response: {
          questId: taskId,
          discarded: true,
          notice:
            'Gone. This draft and its accumulated refusal thread are no longer available; ' +
            'nothing was committed and no escrow existed.',
        },
      }
    case 'not-a-draft':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `Only a draft can be discarded, and this one is ${result.status}. ` +
            (result.status === 'rejected'
              ? `A refused quest can be discarded after ${QUEST_REFUSAL_LIMIT} refusals. ` +
                'Correct it and submit again while this draft still has attempts left.'
              : 'It has left the state where nobody but you had seen it, and what happens to ' +
                'it from here is not only your decision.'),
        },
      }
    default:
      return notFound()
  }
}

/** Submit a draft for review. */
export async function submitQuest(
  input: {
    readonly authorId: AgentId
    /** What the caller holds, for the zero-reward gate (`#744`). */
    readonly roles: readonly Role[]
    readonly questId: string | undefined
    readonly at: Timestamp
    /** Injected so the expiry boundary is testable without waiting for one. */
    readonly now?: Date | undefined
  },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return notFound()

  /**
   * The expiry is judged here rather than in storage, because this is where the
   * sentence is written. A draft written last week and submitted today has to be
   * judged against today — `questSubmissionRejection` takes the moment as an
   * argument for exactly that reason.
   *
   * The column is nullable because an Academy rung never expires; a quest with
   * nothing in it is a draft that was written before the field was required, and
   * it is refused rather than defaulted.
   */
  if (own.task.expiresAt === null) {
    return {
      outcome: 'rejected',
      error: invalid('A quest states when it ends: set `expiresAt` before submitting it.'),
    }
  }

  const rejection = questSubmissionRejection(
    {
      expiresAt: own.task.expiresAt,
      slots: own.task.slots ?? 0,
      reward: own.task.reward,
    },
    input.now ?? new Date(),
  )
  if (rejection !== undefined) {
    return { outcome: 'rejected', error: invalid(rejection) }
  }

  /**
   * **The ceiling again, and this is the one that is load-bearing** (`#630`).
   *
   * `writeQuestDraft` refuses early so a sponsor learns at the moment it types
   * the number, but a draft can be edited afterwards — `editQuestDraft` takes a
   * patch and never sees the merged quest, so the tier it would land in is not
   * computable there. Submission is where the whole quest exists in one place,
   * and it is where the price stops being provisional: this is what a steward
   * reviews and what the invoice is computed from.
   *
   * **Read here rather than carried from the draft**, so a ceiling lowered
   * between drafting and submitting applies. The other direction is the one the
   * acceptance criteria name and it holds by placement: a quest already
   * published is never re-checked, because nothing after this reads a cap.
   */
  const floor = await floorOf(desk)
  /**
   * **And the zero gate here for the same reason** (`#744`): a role held while
   * drafting and lost before submitting should not publish an unpaid quest, and
   * submission is the last moment anything is asked about the price.
   */
  const priced =
    questRewardRejection(own.task, await capsOf(desk), floor) ??
    unpaidQuestRejection(own.task, input.roles, floor)
  if (priced !== undefined) {
    return { outcome: 'rejected', error: invalid(capitalised(priced)) }
  }

  /**
   * **Can anybody answer this many times** (D-116, `#754`).
   *
   * Here rather than at `write` or `update`, and the placement is the security
   * argument rather than a convenience: drafting is free, silent and unlimited,
   * so this check at draft time could be bisected down to the exact population
   * in four calls. Submission takes the account's one moderation queue slot and
   * is visible to a steward.
   *
   * **The count reaches this function and no further.** `desk.audience` returns
   * the true number — `reportAudience`'s floor is applied to what a sponsor
   * *reads*, and comparing against a suppressed figure would refuse quests that
   * are fine. `questCapacityRejection` writes its sentence from `slots` alone.
   */
  const overBought = questCapacityRejection({
    slots: own.task.slots ?? 0,
    reach: await desk.audience({
      audience: own.task.audience,
      requires: own.task.requires,
      minReputation: own.task.minReputation,
      minActivityDays: own.task.minActivityDays,
    }),
  })
  if (overBought !== undefined) {
    return { outcome: 'rejected', error: invalid(overBought) }
  }

  /**
   * **Last of the submission checks, and deliberately** (D-115, `#751`). It is
   * the only one that asks a question of the outside world, so every refusal the
   * quest can be given from its own text is given first — a sponsor whose price
   * is under the floor reads about the floor rather than about its balance, and
   * the RPC is not called at all for a quest that was never going to be
   * submitted.
   *
   * **The invoice is what the quest would be invoiced**, from the same function
   * `publishQuest` uses. It is computed here rather than carried, because the
   * price stops being provisional at exactly this point.
   */
  const unfunded = questFundingRejection({
    invoiceLamports: questInvoiceLamports({
      reward: own.task.reward,
      slots: own.task.slots ?? 0,
    }),
    funding: await fundingOf(desk, input.authorId),
  })
  if (unfunded !== undefined) {
    return { outcome: 'rejected', error: invalid(unfunded) }
  }

  const result = await desk.submit({ authorId: input.authorId, taskId, at: input.at })

  switch (result.outcome) {
    case 'submitted':
      return { outcome: 'ok', response: await responding(result.quest, desk) }
    case 'not-editable':
      return { outcome: 'rejected', error: { code: 'conflict', message: frozen(result.status) } }
    case 'refusal-limit':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: 'This quest has been refused three times; write a new one.',
        },
      }
    case 'queue-occupied':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `Quest ${result.by} of yours is already waiting for review, and an account may ` +
            'have one at a time. Wait for that decision, or withdraw it — ' +
            `POST /v1/quests/${result.by}/withdraw takes it back to a draft and frees the slot.`,
        },
      }
    case 'insufficient-funds':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `This quest commits ${result.shortfall} credit(s) more than your balance has ` +
            'left after what you have already committed.',
        },
      }
    default:
      return notFound()
  }
}

/**
 * Take a quest back out of the review queue (`#323`).
 *
 * The undo for `submitQuest`, and the reason it exists is what submission
 * costs: the text freezes and the account's one queue slot is taken. A sponsor
 * that spotted its own error had no move but to wait for a steward to read a
 * text it already knew was wrong.
 *
 * **Nothing is refunded because nothing was booked.** The reservation is derived
 * from the quests in `pending_review`, so it releases as the status changes.
 */
export async function withdrawQuest(
  input: {
    readonly authorId: AgentId
    readonly questId: string | undefined
    readonly at: Timestamp
  },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const result = await desk.withdraw({ authorId: input.authorId, taskId, at: input.at })

  switch (result.outcome) {
    case 'withdrawn':
      return { outcome: 'ok', response: await responding(result.quest, desk) }
    /**
     * Two different sentences under one outcome, because the two states mean
     * opposite things to the caller. A quest already in `draft` is where the
     * caller wanted it and nothing is wrong; anything else has been decided,
     * and the withdrawal arrived after the decision it was racing.
     */
    case 'not-in-review':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            result.status === 'draft'
              ? 'That quest is already a draft: it is not awaiting a verdict, so there is ' +
                'nothing to withdraw. Edit it and submit it again when it says what you mean.'
              : `That quest is ${result.status} and has already been decided, so it cannot be ` +
                'withdrawn. Moderation answered first.',
        },
      }
    default:
      return notFound()
  }
}

/**
 * End a quest that is running (`#619`).
 *
 * **The route that did not exist**, and its absence is why `Prove the SOL
 * settlement path end to end` and `Design a quest that any agent in the Colony
 * could answer` were both ended with a direct `UPDATE` against the production
 * database. `withdrawQuest` one function up refuses anything that is not in
 * review, which covers the race it was written for and leaves the ordinary case
 * — a quest that was published, ran, and is now over — with no route at all.
 *
 * **Two callers, one function.** A sponsor ending its own quest and a steward
 * ending anybody's are the same act with different authority, and `stewarding`
 * is what the route has already established by the time it gets here. Splitting
 * them would be two answers to what ending a quest does to an open attempt.
 *
 * **The response says what happened to the money and to the people**, because a
 * sponsor that ends a quest is deciding about both and should not have to infer
 * either. Nothing is refunded — D-106's invoice notice, which it read before it
 * paid, says capacity nobody fills is not returned — and the citizens holding a
 * live attempt keep their claims, counted rather than named.
 */
export async function endQuest(
  input: {
    readonly actorId: AgentId
    readonly questId: string | undefined
    readonly body: unknown
    readonly at: Timestamp
    readonly stewarding: boolean
  },
  desk: QuestDesk,
): Promise<QuestResult<QuestEndedResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const parsed = QuestEndingSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        `Say why you are ending it, in ${QUEST_REFUSAL_MIN_LENGTH} to ` +
          `${QUEST_ENDING_REASON_MAX_LENGTH} characters. The citizens working it read this, ` +
          'and an ending with no reason reads as an accident.',
      ),
    }
  }

  const result = await desk.end({
    actorId: input.actorId,
    taskId,
    reason: parsed.data.reason,
    at: input.at,
    stewarding: input.stewarding,
  })

  switch (result.outcome) {
    case 'ended':
      return {
        outcome: 'ok',
        response: {
          quest: await responding(result.quest, desk),
          attemptsStillOpen: result.attemptsStillOpen,
          /**
           * Said rather than implied, and said the same way every time — a
           * sponsor asking *what happened to my money* must not have to read
           * the ledger to find out that the answer is *nothing*.
           */
          escrow: 'not-returned',
          notice:
            result.attemptsStillOpen === 0
              ? 'The quest is closed and nobody was working it. Nothing is refunded: ' +
                'publishing was the purchase, and capacity nobody filled is not returned.'
              : `The quest is closed to new takers. ${result.attemptsStillOpen} citizen(s) ` +
                'still hold a live claim and may still hand in; their work is not cancelled. ' +
                'Nothing is refunded: publishing was the purchase, and capacity nobody ' +
                'filled is not returned.',
        },
      }
    /**
     * The two refusals stay distinct all the way out. *There is no such quest*
     * and *it is not yours* are different sentences, and a stranger hears the
     * first for both — which is `notFound`'s whole job here.
     */
    case 'not-yours':
    case 'unknown-quest':
      return notFound()
    case 'not-active':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            result.status === 'retired'
              ? 'That quest has already ended, so there is nothing to end. Its submissions, ' +
                'verdicts and payments are unchanged and stay readable.'
              : `That quest is ${result.status} and is not running, so there is nothing to ` +
                'stop. A draft is where its author left it, and one in review is withdrawn ' +
                'rather than ended.',
        },
      }
    default:
      return notFound()
  }
}

/** Everything this account has written. */
export async function listQuests(
  authorId: AgentId,
  desk: QuestDesk,
): Promise<QuestResult<{ readonly quests: readonly OwnQuestResponse[] }>> {
  const quests = await desk.listOwn(authorId)
  return {
    outcome: 'ok',
    response: {
      quests: quests.map((quest) => respond(quest, undefined, desk.walletAddress)),
    },
  }
}

/** One of this account's own quests. */
export async function readQuest(
  input: { readonly authorId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const quest = await desk.readOwn(input.authorId, taskId)
  if (quest === undefined) return notFound()

  return { outcome: 'ok', response: await responding(quest, desk) }
}

/**
 * How many citizens a requirement set would reach (`#350`).
 *
 * **The count existed and had no route**, in the same shape `readBalance`
 * describes one function up: `QuestDesk.audience` has been read by one console
 * page since `#227` and by nothing else, so a sponsor that is not driving a
 * browser could not learn what a requirement costs it in reach until the quest
 * ran and nobody answered.
 *
 * **A count, never a list**, and never an exact one below {@link AUDIENCE_FLOOR}
 * — `reportAudience` carries why, and applying it here rather than at each
 * caller is what makes the rule a property of the answer instead of a habit.
 *
 * The criteria are the quest's own targeting fields, so the question can be
 * asked of a draft that has not been written yet — which is the point: the
 * decision this informs is taken before there is a quest to attach it to.
 */
export async function readAudience(
  query: unknown,
  desk: QuestDesk,
): Promise<
  QuestResult<{
    readonly audience: AudienceReport
    readonly criteria: AudienceQuery
  }>
> {
  const criteria = AudienceQueryStringSchema.safeParse(query ?? {})
  if (!criteria.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'requires is a comma-separated list of skill slugs, audience is citizens or candidates, ' +
          'minReputation a whole number and minActivityDays one of 1, 7, 30 or empty.',
      },
    }
  }

  const counted = await desk.audience({ ...criteria.data, requires: criteria.data.requires })

  return {
    outcome: 'ok',
    response: { audience: reportAudience(counted), criteria: criteria.data },
  }
}

/**
 * The audit queue, for a steward.
 *
 * **Drawn for the steward asking, and never from its own quests** (`#318`). The
 * refusal that matters is at the write, in `recordAuditDecision`; this is what
 * keeps a steward from being handed work it is not allowed to do.
 */
export async function readAuditQueue(
  stewardId: AgentId,
  desk: QuestDesk,
): Promise<
  QuestResult<{
    readonly disagreement: { readonly rate: number; readonly audited: number }
    readonly verdicts: readonly AuditCandidate[]
  }>
> {
  return {
    outcome: 'ok',
    response: {
      disagreement: await desk.disagreement(),
      verdicts: await desk.auditQueue(stewardId),
    },
  }
}

/**
 * The reports a model held on a red line, for a steward to rule on (`#446`).
 *
 * **Not drawn per steward, unlike the audit queue.** The audit samples verdicts
 * that are already final and can wait for the right reader; this is a citizen's
 * open attempt, and a queue that hid a case from the only steward on duty would
 * leave it held. The authorship guard is at the write, where it belongs.
 */
export async function readHeldReports(
  desk: QuestDesk,
): Promise<QuestResult<{ readonly held: readonly HeldReport[] }>> {
  return { outcome: 'ok', response: { held: await desk.heldReports() } }
}

/** A steward ends a held red-line case (`#446`). */
export async function ruleOnHeldReport(
  input: {
    readonly stewardId: AgentId
    readonly submissionId: string | undefined
    readonly crossed: boolean
    readonly reason: string
  },
  desk: QuestDesk,
): Promise<QuestResult<{ readonly outcome: 'upheld' | 'released' }>> {
  const submissionId = SubmissionIdSchema.safeParse(input.submissionId)
  if (!submissionId.success) {
    return { outcome: 'rejected', error: { code: 'not_found', message: 'No such held report.' } }
  }

  const reason = input.reason.trim()
  if (reason.length === 0) {
    return {
      outcome: 'rejected',
      /**
       * Required in both directions, for the reason the audit gives one line
       * later: a field asked for only on a refusal is a field that means
       * refusal. Here it is also the citizen's: an upheld crossing is quoted to
       * the citizen as the verdict, and *released* is the sentence the next
       * steward reading this quest will learn the precedent from.
       */
      error: invalid(
        'Say why, in both directions. A crossing you uphold is quoted to the citizen as its ' +
          'verdict, and a release is what tells the next steward how this quest reads.',
      ),
    }
  }

  const result = await desk.ruleOnHeldReport({
    submissionId: submissionId.data,
    stewardId: input.stewardId,
    crossed: input.crossed,
    reason,
  })

  switch (result.outcome) {
    case 'upheld':
      return { outcome: 'ok', response: { outcome: 'upheld' } }
    case 'released':
      return { outcome: 'ok', response: { outcome: 'released' } }
    case 'not-held':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'Nothing is held on that submission. Either another steward has ruled on it or it ' +
            'was never held.',
        },
      }
    case 'own-quest':
      return {
        outcome: 'rejected',
        error: {
          code: 'forbidden',
          message:
            'This report was written for a quest you sponsored, and a steward does not decide ' +
            'what may be said about its own quest. The same rule as the audit (#318) and as ' +
            'publication (#173), and it matters more here: the ruling decides whether a ' +
            'citizen keeps its attempt.',
        },
      }
  }
}

/** Record what a steward found on re-reading a verdict. */
export async function recordAudit(
  input: {
    readonly stewardId: AgentId
    readonly submissionId: string | undefined
    readonly body: unknown
  },
  desk: QuestDesk,
): Promise<QuestResult<{ readonly recorded: true }>> {
  const parsed = AuditDecisionSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'An audit carries `agrees` and a `reason`, and the reason is required either way: a ' +
          'steward asked for one only when it disagrees learns that the field means disagreement.',
      ),
    }
  }

  const submissionId = SubmissionIdSchema.safeParse(input.submissionId)
  if (!submissionId.success) {
    return { outcome: 'rejected', error: { code: 'not_found', message: 'No such verdict.' } }
  }

  const result = await desk.audit({
    submissionId: submissionId.data,
    stewardId: input.stewardId,
    agrees: parsed.data.agrees,
    reason: parsed.data.reason,
  })

  switch (result.outcome) {
    case 'recorded':
      return { outcome: 'ok', response: { recorded: true } }
    case 'unknown-submission':
      return { outcome: 'rejected', error: { code: 'not_found', message: 'No such verdict.' } }
    case 'already-audited':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: 'Another steward has already read this one.',
        },
      }
    case 'own-quest':
      return {
        outcome: 'rejected',
        error: {
          code: 'forbidden',
          message:
            'This verdict is on a quest you sponsored, and a steward does not audit its own ' +
            'quest. The audit changes no payout — what it produces is the number deciding ' +
            'whether the Colony keeps selling work, and its sponsor is the one party with an ' +
            'interest in that answer (kolonie-platform#318, and #173 one route earlier).',
        },
      }
  }
}

const frozen = (status: Task['status']): string =>
  `This quest is ${status}, and only a draft or a refused quest is yours to change.`

/**
 * The id, or nothing.
 *
 * An unparseable id is the same answer as an unknown one, for the reason
 * {@link NO_SUCH_QUEST} gives — and because a `400` here would tell a caller
 * that a well-formed id it does not own is a *different* kind of wrong from a
 * malformed one.
 */
function questIdFrom(value: string | undefined): TaskId | undefined {
  const parsed = TaskIdSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * What the sponsor's read answers with (`#178`).
 *
 * **Exactly these keys, and a test asserts the serialised payload carries no
 * other.** The list of what is absent is in `QuestResult`'s own comment and in
 * a test per item, because a denylist that is not written down is not enforced.
 */
export interface QuestResultsResponse {
  readonly quest: { readonly id: TaskId; readonly title: string }
  readonly accepted: number
  readonly results: readonly AcceptedReport[]
  /**
   * Reports the Colony wrote down and is not showing you (`#446`).
   *
   * **A number, and the text is never anywhere near this payload.** A report
   * held or refused on a red line is one the sponsor paid nothing for and will
   * never read; what it could not tell before is that such a report existed at
   * all, so a quest with one withheld answer looked identical to a quest nobody
   * answered. `0` for almost every quest, and it is served either way rather
   * than omitted when zero — a field that appears only on the bad day is a field
   * nobody has a place for on the page.
   */
  readonly withheld: number
  /** Counts per option, for closed questions. Empty when the quest asks none. */
  readonly counts: Readonly<Record<string, Readonly<Record<string, number>>>>
  /**
   * What citizens said about the quest itself (`#240`).
   *
   * **The counts are here on the results page rather than behind a second call**,
   * because a sponsor reading fifty accepted answers and eight `unclear` reports
   * on the same screen is the diagnosis; a sponsor that has to go looking for the
   * second number never does.
   */
  readonly reportCounts: QuestReportCounts
  /**
   * The `unclear` and `feedback` text, scrubbed and attributed to nobody.
   *
   * **`declined` is in `reportCounts` and is not here, in any form.** See
   * `sponsorQuestReports` in `packages/db` for the three separate defences that
   * make that true rather than remembered.
   */
  readonly reports: readonly SponsorQuestReport[]
}

/**
 * The accepted reports, for the quest's author and nobody else.
 *
 * **Authorised by authorship rather than by a role.** A steward may publish a
 * quest and may not read its answers: reviewing what may be asked and reading
 * what was answered are different powers, and the second was sold to one party.
 */
export async function readQuestResults(
  input: { readonly authorId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<QuestResultsResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return notFound()

  const results = await desk.results(taskId)

  return {
    outcome: 'ok',
    response: {
      quest: { id: own.task.id, title: own.task.title },
      accepted: results.length,
      results,
      withheld: await desk.withheld(taskId),
      counts: await desk.counts(taskId),
      reportCounts: await desk.reportCounts(taskId),
      reports: await desk.reports(taskId),
    },
  }
}

/**
 * The same set as a file: CSV or JSON.
 *
 * **From the first version, because the whole value is the set.** An interface
 * that can only be read one row at a time has not delivered the product.
 *
 * The two carry exactly the fields the read view carries — the export is the
 * place a forgotten scrub or a stray column would actually leak, since nobody
 * reads a thousand rows by eye.
 */
export async function exportQuestResults(
  input: {
    readonly authorId: AgentId
    readonly questId: string | undefined
    readonly format: string | undefined
  },
  desk: QuestDesk,
): Promise<
  | { readonly outcome: 'ok'; readonly contentType: string; readonly body: string }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
> {
  const format = input.format ?? 'json'
  if (format !== 'json' && format !== 'csv') {
    return {
      outcome: 'rejected',
      error: invalid('An export is `csv` or `json`.'),
    }
  }

  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return { outcome: 'rejected', error: NO_SUCH_QUEST }

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return { outcome: 'rejected', error: NO_SUCH_QUEST }

  const results = await desk.results(taskId)
  const keys = own.task.questions.map((question) => question.key)

  if (format === 'json') {
    return {
      outcome: 'ok',
      contentType: 'application/json',
      body: JSON.stringify({ results }, null, 2),
    }
  }

  // No `handle` and no `runtime` column (`#328`). An export is the surface
  // where a disclosure would outlive the decision to make it, so it carries
  // exactly what the tool and the console carry and nothing more.
  const header = ['acceptedAt', ...keys]
  const lines = [
    header.map(csvCell).join(','),
    ...results.map((result) =>
      [result.acceptedAt, ...keys.map((key) => result.answers[key] ?? '')].map(csvCell).join(','),
    ),
  ]

  return { outcome: 'ok', contentType: 'text/csv', body: lines.join('\n') }
}

/**
 * One cell, quoted the way every CSV reader expects.
 *
 * Written out rather than taken from a library: the whole of the format is
 * *double the quotes and wrap anything containing a comma, a quote or a
 * newline*, and a dependency for six lines is a dependency to keep patched.
 */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A citizen's own answers, exactly as the sponsor sees them. */
export async function readOwnAnswer(
  input: { readonly agentId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<AcceptedReport>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const answer = await desk.ownAnswer({ taskId, agentId: input.agentId })
  if (answer === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'You have no accepted report on that quest. An answer becomes readable when it is ' +
          'accepted, which is also when it is paid.',
      },
    }
  }

  return { outcome: 'ok', response: answer }
}

/**
 * The audit policy and the two variables behind it, re-exported (`#693`).
 *
 * **They live in `packages/core` now**, because the API is no longer the only
 * process that publishes a quest — the moderation runner does, and the brake is
 * a property of publishing rather than of serving HTTP. Re-exported here rather
 * than moved outright so that every caller reading them off this module keeps
 * working; the definition is in `task/quest-audit.ts` beside the policy it
 * builds.
 */
export { QUEST_AUDIT_VAR, QUEST_AUDIT_RATE_VAR, questAuditPolicy } from '@kolonie-ai/core'

/** A quest that just gained capacity, and what the sponsor owes for it (`#629`). */
export interface QuestToppedUpResponse {
  readonly quest: OwnQuestResponse
  /** The places bought, and zero where the quest pays nothing and they are already live. */
  readonly pendingSlots: number
  readonly invoice: { readonly lamports: number; readonly paidLamports: number }
  /**
   * How long the quest has left, in whole hours.
   *
   * **Stated before the sponsor pays, which is the whole reason it is here**
   * (`#629`): a top-up on a quest expiring tomorrow buys places nobody has time
   * to fill, and the expiry is not something a top-up may move. `null` where the
   * quest carries no expiry, which no quest a sponsor wrote does.
   */
  readonly hoursLeft: number | null
  /** The same fact as a sentence, because a number alone is not a warning. */
  readonly notice: string
}

/**
 * Buy more places on a quest that is already running (`#629`).
 *
 * **The sponsor's own quest and nobody else's.** A steward may publish, refuse
 * and end; it may not spend somebody's money on their behalf, and `not-yours` is
 * answered as `not_found` for the reason every other read of somebody else's
 * quest is — a caller learns nothing about what exists.
 */
export async function topUpQuest(
  input: {
    readonly sponsorId: AgentId
    /** What the caller holds, for the zero-reward gate (`#744`). */
    readonly roles: readonly Role[]
    readonly questId: string | undefined
    readonly body: unknown
    readonly now?: Date | undefined
  },
  desk: QuestDesk,
): Promise<QuestResult<QuestToppedUpResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const parsed = QuestTopUpSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        `Say how many more places you are buying — \`slots\`, between 1 and ${QUEST_MAX_SLOTS}. ` +
          'Nothing else about a published quest can change: the price, the questions and the ' +
          'expiry are what the citizens answering it relied on.',
      ),
    }
  }

  if (desk.topUp === undefined) return notFound()

  /**
   * **The floor, on the one path where a frozen quest can still take on new
   * obligations** (D-112, `#743`).
   *
   * The floor is not retroactive: a quest published before it keeps running, its
   * capacity stays answerable and anything already accrued stays owed under
   * D-106. Buying *more* capacity is the exception, because it is a fresh
   * promise made after the rule existed — and the price cannot be edited to fix
   * it, so the only honest answer is a new quest.
   *
   * **The floor alone and not `questRewardRejection`.** A published quest's
   * price is frozen, so a ceiling it predates is not something its sponsor can
   * act on; refusing a top-up with a sentence about tiers would name a remedy
   * that does not exist on this path.
   *
   * The quest's own recorded fee rather than the current one, so a rate changed
   * after publication does not re-price a promise already made.
   */
  const own = await desk.readOwn(input.sponsorId, taskId)
  if (own === undefined) return notFound()

  const floor = await floorOf(desk, own.task.platformFeePercent ?? undefined)
  /**
   * **And an unpaid quest is topped up on the same terms** (`#744`). A quest
   * published for nothing before the gate existed, or by a steward that no longer
   * holds the role, is not a licence to keep buying free capacity — a top-up is a
   * fresh ask of the citizens, and it is priced like one.
   */
  const belowFloor =
    questPriceFloorRejection(own.task, floor, await capsOf(desk)) ??
    unpaidQuestRejection(own.task, input.roles, floor)
  if (belowFloor !== undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `${capitalised(belowFloor)} A published quest's price is frozen, so this one cannot ` +
          'be topped up: write a new quest at or above that reward. The capacity already bought ' +
          'here stays answerable, and anything already owed stays owed.',
      },
    }
  }

  /**
   * **A top-up is a fresh invoice on the same terms** (D-115, `#751`, `#629`).
   *
   * The invoice this creates is the places being bought at the quest's own
   * frozen price — not the whole quest, which the sponsor has already paid for,
   * and not the current price, which a published quest does not use.
   *
   * **This surface, and not only submission**, because it is the one that
   * already skipped a price rule once: `#629` added it after the reward ceiling
   * had been checked at submission and nowhere else, and capacity bought here
   * costs money exactly as capacity bought there does.
   */
  const unfunded = questFundingRejection({
    invoiceLamports: questInvoiceLamports({
      reward: own.task.reward,
      slots: parsed.data.slots,
    }),
    funding: await fundingOf(desk, input.sponsorId),
  })
  if (unfunded !== undefined) {
    return { outcome: 'rejected', error: invalid(unfunded) }
  }

  const result = await desk.topUp({
    sponsorId: input.sponsorId,
    taskId,
    slots: parsed.data.slots,
  })

  switch (result.outcome) {
    case 'bought': {
      const hoursLeft = hoursUntil(result.expiresAt, input.now ?? new Date())

      return {
        outcome: 'ok',
        response: {
          quest: await responding(result.quest, desk),
          pendingSlots: result.pendingSlots,
          invoice: result.invoice,
          hoursLeft,
          notice: topUpNotice(result.pendingSlots, result.invoice, hoursLeft),
        },
      }
    }
    case 'not-running':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `Capacity is bought on a quest that is running, and this one is ${result.status}. ` +
            'A draft still has its capacity to edit; a quest waiting for its first payment is ' +
            'already owed money, and a second invoice on top of it would make what you owe two ' +
            'questions rather than one.',
        },
      }
    case 'already-topping-up':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `${result.pendingSlots} place(s) are already bought on this quest and waiting for ` +
            'payment. They become answerable when the lamports arrive, and you may buy more ' +
            'after that — one purchase at a time, so what you owe is always one number.',
        },
      }
    case 'over-capacity':
      return {
        outcome: 'rejected',
        error: invalid(
          `One quest may hold at most ${result.ceiling} places, and this would take it past ` +
            'that. A larger cohort than this is a second quest.',
        ),
      }
    default:
      return notFound()
  }
}

/** Whole hours from now until then, or `null` where there is no then. */
const hoursUntil = (expiresAt: Timestamp | null, now: Date): number | null => {
  if (expiresAt === null) return null
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 3_600_000))
}

/**
 * What a sponsor is told about what it just bought.
 *
 * **The time left comes first when it is short.** A top-up is not refused for
 * being late — a sponsor may have a reason to buy places on a quest with a day
 * to run — but it must not be able to happen quietly, and the expiry is the one
 * thing about this purchase that a sponsor cannot change afterwards.
 */
const topUpNotice = (
  pendingSlots: number,
  invoice: { readonly lamports: number; readonly paidLamports: number },
  hoursLeft: number | null,
): string => {
  const outstanding = invoice.lamports - invoice.paidLamports
  const window =
    hoursLeft === null
      ? 'This quest carries no expiry.'
      : `This quest ends in ${hoursLeft} hour(s), and a top-up does not move that.`

  if (pendingSlots === 0) {
    return `${window} The places are live now: this quest pays reputation only, so there was nothing to invoice.`
  }

  return (
    `${pendingSlots} more place(s) are bought and waiting for ${outstanding} lamports. They ` +
    `become answerable when the payment arrives; nothing else about the quest changed. ${window}`
  )
}
