import {
  approvedOnTask,
  briefingCorpus,
  createDatabase,
  databaseUrlFromEnv,
  detectProviderChange,
  heldRedLineReports,
  holdReportOnRedLine,
  resolveRedLineOnReview,
  unclassifiedDirections,
  writeDirectionClassification,
  waitingProfileReviews,
  recordProfileReview,
  deferProfileReview,
  approvedWalkProseWithoutScrub,
  markPublishedDuplicateWalks,
  pendingAnswerModerations,
  unmoderatedWalkProse,
  recordApprovedWalkProseRescrub,
  recordWalkProseModeration,
  requeueRefusedWalkProse,
  markBriefingStale,
  questAuditQueue,
  questObstacleCorpus,
  readTaskKind,
  recordAuditDecision,
  stewardEndedQuests,
  unmoderatedQuestReports,
  recordQuestReportModeration,
  pendingPlaybookModerations,
  pendingPlaybookNotes,
  pendingPlaybookStepProposalsForModeration,
  pendingQuestModerations,
  pendingReports,
  playbooksWithAcceptedUnfoldedProposals,
  cutPlaybookRevision,
  evaluatePlaybookBlocked,
  openPlaybooksForBlockedCheck,
  publishPlaybookAfterReview,
  publishQuest,
  questsBySameSponsor,
  playbooksClearedForPublication,
  questsClearedForPublication,
  questsHeldForPublication,
  readTaskText,
  recordModeration,
  recordProviderChange,
  recordPlaybookModeration,
  recordPlaybookNoteVerdict,
  recordPlaybookStepProposalVerdict,
  recordQuestModeration,
  sweepAbusiveRateSuspensions,
  sweepContributionVerdicts,
  writeScrubbedAnswers,
  staleBriefings,
  writeBriefing,
  providerBriefingCorpus,
  staleProviderBriefings,
  writeProviderBriefing,
  promoteWalkerAboutToEntryIdentity,
  writeProviderDescription,
  playbookBriefingCorpus,
  playbookBriefingSubject,
  readPlaybookBriefingSplit,
  replacePlaybookBriefingClaims,
  atlasCategoriesHeld,
  atlasCategoriesSettled,
  atlasCategoryList,
  atlasCategoryProposalQueue,
  atlasEntryFor,
  openAtlasCategoryProposal,
  recordAtlasModeration,
  unjudgedAtlasProposals,
} from '@kolonie-ai/db'
import {
  BRIEFING_TICK_MULTIPLIER,
  startBriefingRunner,
  startQuestRunner,
  startRunner,
  synthesiseNow,
  synthesisePlaybookNow,
  type BriefingStore,
  type PlaybookBriefingStore,
  type Log,
  type ProviderBriefingStore,
  type ModerationStore,
} from './loop.js'
import type {
  PlaybookBlockedModerationStore,
  PlaybookModerationStore,
  PlaybookNoteModerationStore,
  PlaybookProposalModerationStore,
  PlaybookRevisionModerationStore,
} from './playbooks.js'
import type { QuestModerationStore } from './quests.js'
import type { AnswerModerationStore } from './answers.js'
import type { RedLineReviewStore } from './redline-review.js'
import type { QuestAuditStore } from './quest-audit.js'
import type { QuestEndingsStore } from './quest-endings.js'
import type { WalkProseModerationStore } from './walk-prose.js'
import type { AtlasModerationStore } from './atlas.js'
import type { AtlasCategoryProposalStore } from './atlas-category-proposals.js'
import type { QuestReportModerationStore } from './quest-reports.js'
import {
  AccountKindSchema,
  AccountProviderSchema,
  createLog,
  gatewayFromEnvironment,
  gatewayOnlyFetch,
  gatewayRoutedFetch,
  now,
  questAuditPolicy,
  type TaskId,
} from '@kolonie-ai/core'
import { githubIssues, TRIPWIRE_TOKEN_VAR } from './tripwire.js'
import { openRouterModel, unavailableModel, OPENROUTER_API_KEY_VAR } from './llm.js'
import { openRouterDirectionClassifier, DIRECTION_MODEL_VAR } from '@kolonie-ai/verifiers'
import type { DirectionStore } from './directions.js'
import type { ProfileReviewStore } from './profiles.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the moderation runner.
 *
 * Wiring only, like `verifier-runner/main.ts`: the loop is in `loop.ts`, the
 * three judgements are in files of their own, the SQL is in `packages/db`.
 * Nothing here decides anything, which is why nothing here is tested —
 * everything with behaviour is reachable without starting a process.
 */

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 60_000)
const QUEST_POLL_INTERVAL_MS = Math.min(
  Number(process.env['QUEST_POLL_INTERVAL_MS'] ?? 15_000),
  POLL_INTERVAL_MS,
)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3002)

/**
 * How many of a sponsor's other quests the dedup stage is shown (`#694`).
 *
 * **The bound is what one call costs**, on `RECENT_REPORTS_IN_CONTEXT`'s terms:
 * the set goes into a prompt, so an unbounded one means a sponsor with two
 * hundred quests pays for a two-hundred-entry comparison on every new brief.
 * Oldest first, so what falls off the end is the sponsor's most recent work —
 * which is the half it is least likely to have forgotten it already asked.
 */
const QUEST_SIBLINGS_IN_CONTEXT = 25
const BRIEFING_INTERVAL_MS = Number(
  process.env['BRIEFING_INTERVAL_MS'] ?? POLL_INTERVAL_MS * BRIEFING_TICK_MULTIPLIER,
)

// One JSON object per line, on stdout, with `service` set once here (`#230`).
// The three methods that forwarded to `console` printed prose, and
// `console.error(message, error)` printed a stack through Node's inspector —
// one failure, N lines, and nothing able to rejoin them.
const log: Log = createLog({
  service: 'moderation-runner',
  redactUrls: [process.env['LLM_GATEWAY_BASE_URL']],
})

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

/**
 * The key, read in exactly one file.
 *
 * **A missing key degrades this process; it does not stop it.** The rule
 * `createVerifiers` follows, and it applies more cleanly here than anywhere: an
 * unconfigured moderator leaves entries `pending`, pending entries are never
 * served, and the read endpoints answer empty arrays. Nothing wrong reaches an
 * agent — the Colony simply publishes nothing until the deploy that supplies the
 * key. Refusing to start would instead take down the health endpoint that is how
 * anyone would find out.
 */
const apiKey = process.env[OPENROUTER_API_KEY_VAR] ?? ''

/**
 * What this runner's chat completions talk through (`#674`).
 *
 * The LLM gateway first and OpenRouter on any failure, or — with no
 * `LLM_GATEWAY_API_KEY_MODERATION` set — `fetch` itself, unwrapped. Removing the
 * key is how this one process is put back on OpenRouter, without a code change
 * and without touching the other three services.
 *
 * **The briefing's embeddings are not affected and cannot be.** The gateway has
 * no `/embeddings` endpoint at all — it answers 404 — so the wrapper routes only
 * `POST …/chat/completions` and every other request passes through untouched.
 * That is a property of the wrapper rather than a setting here, which is the
 * only version of it that cannot be switched on by mistake.
 */
const modelFetch = gatewayRoutedFetch(gatewayFromEnvironment('moderation'), {
  log,
})

const model =
  apiKey === ''
    ? unavailableModel(`${OPENROUTER_API_KEY_VAR} not set`)
    : openRouterModel(apiKey, {
        // Configuration rather than a constant, because which model judges is a
        // decision that will be revisited against a real corpus — and the
        // alternative is a code change to try the next one.
        ...(process.env['OPENROUTER_MODEL'] && { model: process.env['OPENROUTER_MODEL'] }),
        ...(process.env['OPENROUTER_EMBEDDING_MODEL'] && {
          embeddingModel: process.env['OPENROUTER_EMBEDDING_MODEL'],
        }),
        // So a reply this cannot read is counted rather than dropped in silence
        // (`#230`).
        log,
        fetch: modelFetch,
      })

/**
 * The quest judge, and it has **no fallback to OpenRouter** (`#726`).
 *
 * Composed with `#693`, the fallback read as: *when the good model is down,
 * publish quests judged by the flash model instead.* Nobody decided that; it is
 * what the two behaviours did together. `gatewayRoutedFetch` wraps the fetch for
 * a whole client, so this is a second client rather than a flag on a call.
 *
 * A gateway failure now surfaces as a provider error, `judgeQuest` records
 * nothing, and the quest stays `pending_review` for the next tick — which is
 * what `#693` already requires of every other way that call can fail.
 *
 * **The other stages keep the fallback, deliberately.** Answer moderation, the
 * red-line hold on a report and the briefing synthesis are not publication
 * decisions, and they are better served late by a weaker model than not at all.
 *
 * With no gateway configured this is the ordinary client's transport and the two
 * are the same thing, which is correct: there is nothing to fall back *from*, and
 * a deployment on OpenRouter alone judges quests on the model it has.
 */
const questModel =
  apiKey === ''
    ? unavailableModel(`${OPENROUTER_API_KEY_VAR} not set`)
    : openRouterModel(apiKey, {
        ...(process.env['OPENROUTER_MODEL'] && { model: process.env['OPENROUTER_MODEL'] }),
        log,
        fetch: gatewayOnlyFetch(gatewayFromEnvironment('moderation'), { log }),
      })

if (apiKey === '') {
  // Loud on purpose. An unconfigured moderator that said nothing would look
  // exactly like a Colony where nobody has written anything yet.
  log.warn(
    `${OPENROUTER_API_KEY_VAR} is not set. ` +
      'Nothing will be published; entries will accumulate as pending.',
    { event: 'config.missing', variable: OPENROUTER_API_KEY_VAR },
  )
}

const store: ModerationStore = {
  pending: (limit) => pendingReports(db, limit),
  approvedOn: (query) => approvedOnTask(db, query),
  record: (input) => recordModeration(db, input),
}

/**
 * The audit brake, read here (`#693`).
 *
 * **This process publishes quests now, so it carries what publishing needs.**
 * It was the API's because the API was the only caller of `publishQuest`; it is
 * not a decision this runner makes. `questAuditPolicy` reads the deployment's
 * two variables and defaults to *off*, which refuses to publish paid work
 * rather than publishing it unguarded — a runner started without
 * `QUEST_AUDIT_ENABLED` behaves like an API started without it, which is the
 * property that matters when the two are wired by the same compose file.
 *
 * **The obstacle share stood beside it until D-114 (`#752`)**, read from a
 * settings reader this process kept for that one question and frozen onto the
 * row at publication. A quest has one price, nothing is frozen, and the reader
 * went with it.
 */
const questAudit = questAuditPolicy()

/**
 * The quest stage (`#176`, `#693`), on its own faster poll.
 *
 * **One process rather than a fifth container**, the same trade the synthesis
 * loop was given: a second deployable would buy isolation this workload does not
 * need, at the cost of a compose service, a health check and a deploy step. A
 * quest queue is a handful of rows a day and one model call each. Its separate
 * timer keeps a sponsor's wait independent of any report already being judged.
 */
const questStore: QuestModerationStore = {
  pending: (limit) => pendingQuestModerations(db, limit),
  record: (input) => recordQuestModeration(db, input),
  cleared: (limit) => questsClearedForPublication(db, limit),
  held: (limit) => questsHeldForPublication(db, limit),
  // Bounded, for `pendingQuestModerations`' reason: the comparison set is read
  // into a prompt, so its size is what one dedup call costs (`#694`).
  siblings: (taskId) => questsBySameSponsor(db, taskId, QUEST_SIBLINGS_IN_CONTEXT),
  publish: async (taskId) =>
    await publishQuest(db, {
      // No steward, and that is the whole of `#693`: the verdict published it.
      taskId,
      at: now(),
      audit: questAudit,
    }),
}

/**
 * The playbook review pass, from the process's side (`#1219`).
 *
 * Four storage calls and no decision of its own, like `questStore` above it. No
 * `siblings`: there is no dedup stage, because freeze D makes a fork of a
 * published playbook a first-class thing to write and a dedup stage would refuse
 * it. No `held`: the audit brake is about paid work, and a playbook pays nobody
 * to be published.
 */
const playbookStore: PlaybookModerationStore = {
  pending: (limit) => pendingPlaybookModerations(db, limit),
  record: (input) => recordPlaybookModeration(db, input),
  cleared: (limit) => playbooksClearedForPublication(db, limit),
  publish: (playbookId) => publishPlaybookAfterReview(db, playbookId),
}

/**
 * The note queue, beside the playbook queue and reading the same table (`#1246`).
 *
 * Two stores rather than four methods on one, because they are two verdicts with
 * two subjects: one decides whether a pipeline may be published, the other
 * whether one sentence about a run of it may be. Nothing either writes is
 * visible to the other.
 */
const playbookNoteStore: PlaybookNoteModerationStore = {
  pending: (limit) => pendingPlaybookNotes(db, limit),
  record: (input) => recordPlaybookNoteVerdict(db, input),
}

/**
 * The step-proposal queue (`#1254`).
 *
 * A third store beside the playbook and note ones: a proposal is neither a
 * pipeline awaiting publication nor a sentence about a run of one. Claims are read from the briefing rows `#1251` stores — merit treats an empty list as a real answer.
 */
const playbookProposalStore: PlaybookProposalModerationStore = {
  pending: (limit) => pendingPlaybookStepProposalsForModeration(db, limit),
  record: (input) => recordPlaybookStepProposalVerdict(db, input),
  claimsFor: async (playbookId, position) => {
    const split = await readPlaybookBriefingSplit(db, playbookId)
    return [...split.current, ...split.demoted]
      .filter((claim) => claim.section === 'step' && claim.stepPosition === position)
      .map((claim) => ({ section: claim.section, text: claim.text }))
  },
}

/**
 * The fold queue (`#1255`).
 *
 * No model: accepted proposals fold deterministically. One cut per playbook
 * per tick, every accepted-unfolded proposal on that playbook in filing order.
 */
const playbookRevisionStore: PlaybookRevisionModerationStore = {
  waiting: (limit) => playbooksWithAcceptedUnfoldedProposals(db, limit),
  cut: async (playbookId) => {
    const result = await cutPlaybookRevision(db, playbookId)
    switch (result.outcome) {
      case 'cut':
        return {
          outcome: 'cut',
          folded: result.folded,
          revision: result.revision.revision,
        }
      case 'incoherent':
        return {
          outcome: 'incoherent',
          reason: result.reason,
          returned: result.returned,
        }
      case 'nothing-to-fold':
      case 'unknown-playbook':
        return { outcome: result.outcome }
    }
  },
}

/**
 * The blocked-threshold pass (`#1256`).
 *
 * No model: the threshold is arithmetic over run outcomes. Clearing is the
 * revision cut, not this store.
 */
const playbookBlockedStore: PlaybookBlockedModerationStore = {
  waiting: (limit) => openPlaybooksForBlockedCheck(db, limit),
  evaluate: async (playbookId) => {
    const result = await evaluatePlaybookBlocked(db, playbookId)
    return {
      outcome: result.outcome,
      blocked: result.threshold.blocked,
      completed: result.threshold.completed,
      window: result.threshold.window,
      revision: result.threshold.revision,
    }
  },
}

/**
 * The synthesis half (#85), in the same process and on a slower tick.
 *
 * **One container rather than two**, and the reason is that a second deployable
 * would buy isolation this workload does not need while costing a compose
 * service, a health check and a deploy step. The two loops share the model, the
 * database handle and the shutdown path; what they do not share is a schedule,
 * which is the only property that mattered — a task that collects two hundred
 * reports must not cost two hundred syntheses.
 *
 * If the synthesis ever needs to scale or fail independently of moderation, this
 * is one file's worth of work to split out, and the store seam is already where
 * the cut would go.
 */
const briefings: BriefingStore = {
  stale: (limit) => staleBriefings(db, limit),
  taskText: (taskId) => readTaskText(db, taskId),
  /**
   * **Two corpora, one synthesis** (`#367`).
   *
   * A quest is a row in `tasks` like a rung is, so its briefing lives in
   * `task_briefings` beside theirs and is written by the same loop against the
   * same prompt. What differs is where the entries come from: a rung's are
   * approved `task_reports`, and a quest's are the published obstacles of
   * approved `quest_reports` — one third of each report, and never the two
   * answers that are method.
   *
   * **The branch is here rather than inside either corpus function**, because
   * this is the seam the loop already depends on and neither table should have
   * to know the other exists. `briefingTick` is unchanged.
   */
  corpus: async (taskId) =>
    (await readTaskKind(db, taskId)) === 'quest'
      ? questObstacleCorpus(db, taskId)
      : briefingCorpus(db, taskId),
  write: (input) => writeBriefing(db, input),
}

/**
 * The provider half of the same loop (`#831`).
 *
 * A second store rather than three more methods on {@link briefings}, on that
 * interface's own argument: one store serving both documents is the seam along
 * which a task's claims eventually land in a provider's row. It is handed to the
 * same runner, so an unreachable model is one outage and one backoff rather than
 * two loops discovering it separately.
 *
 * There is no branch here of the kind the task corpus needs. A provider corpus
 * has one source — the walks, scrubbed — and `moderatedWalkProse` is the only
 * thing that reads them.
 */
const providerBriefings: ProviderBriefingStore = {
  stale: (limit) => staleProviderBriefings(db, limit),
  corpus: (where) => providerBriefingCorpus(db, where),
  write: (input) => writeProviderBriefing(db, input),
  describe: (input) => writeProviderDescription(db, input),
  promoteIdentity: (input) => promoteWalkerAboutToEntryIdentity(db, input),
}

/**
 * Playbook briefing claims (`#1251`).
 *
 * No dirty queue: note approval and revision cuts call `synthesisePlaybookNow`
 * directly. The subject/corpus/write ports keep the synthesis free of SQL.
 */
const playbookBriefings: PlaybookBriefingStore = {
  subject: async (playbookId) => {
    const found = await playbookBriefingSubject(db, playbookId)
    if (found === undefined) return undefined
    return {
      title: found.title,
      summary: found.summary,
      revision: found.revision,
      steps: found.steps,
    }
  },
  corpus: (playbookId) => playbookBriefingCorpus(db, playbookId),
  write: (playbookId, claims, revision) =>
    replacePlaybookBriefingClaims(db, playbookId, claims, now(), revision),
}

const rewritePlaybookBriefing = async (playbookId: string): Promise<void> => {
  await synthesisePlaybookNow(playbookBriefings, questModel, playbookId, log)
}

/**
 * Where a provider belongs in the Atlas, put to a maintainer (`#1106`).
 *
 * **The same corpus function the briefing reads**, and that is the point rather
 * than a saving: a category proposed from a different set of walks than the
 * briefing was written from is a proposal a maintainer cannot check against the
 * page it is about. `providerBriefingCorpus` already applies every rule that
 * matters — scrubbed prose only, finished walks, repeats dropped — and this pass
 * has no reason to want any of them relaxed.
 *
 * It raises nothing on its own authority: `openAtlasCategoryProposal` writes a
 * row with `status = 'open'`, and every shelf in the Atlas still moves only when
 * a maintainer says so.
 */
const categoryProposals: AtlasCategoryProposalStore = {
  queue: (limit) => atlasCategoryProposalQueue(db, limit),
  categories: () => atlasCategoryList(db),
  corpus: (pair) =>
    providerBriefingCorpus(db, {
      kind: AccountKindSchema.parse(pair.kind),
      provider: AccountProviderSchema.parse(pair.provider),
    }),
  settled: (pair) => atlasCategoriesSettled(db, pair),
  held: (pair) => atlasCategoriesHeld(db, pair),
  raise: async (input) => ({ outcome: (await openAtlasCategoryProposal(db, input)).outcome }),
}

/**
 * The provider-change tripwire (#115).
 *
 * `resynthesise` is the *immediate* half — one task's briefing rewritten now
 * rather than on the slow tick, which is the whole reason this exists: the value
 * of the update decays by the hour, and every agent arriving in the meantime is
 * sent at the old wall with the old advice.
 *
 * It reuses `briefingTick`'s own machinery through the same store, so there is
 * one path that turns a corpus into claims rather than two that could disagree
 * about what a briefing is.
 */
const tripwire = {
  detect: (taskId: TaskId) => detectProviderChange(db, taskId),
  record: (taskId: TaskId) => recordProviderChange(db, taskId),
  resynthesise: async (taskId: TaskId) => {
    await synthesiseNow(briefings, model, taskId, log)
  },
  issues: githubIssues(process.env[TRIPWIRE_TOKEN_VAR], log),
}

/**
 * The scrub that stands between a citizen's report and the sponsor (`#177`).
 *
 * Third pass in the same process, on the same poll, for the reason the second
 * one is here: a handful of rows a day and one model call each, against a
 * container, a health check and a deploy step.
 */
const answerStore: AnswerModerationStore = {
  pending: (limit) => pendingAnswerModerations(db, limit),
  write: (input) => writeScrubbedAnswers(db, input),
  hold: (input) => holdReportOnRedLine(db, input),
}

/**
 * What lifts the hold the scrub above writes (`#942`).
 *
 * **Wired here rather than beside the other optional passes, because it is not
 * optional in the same way.** Every other pass absent means a queue nobody reads
 * yet; this one absent means citizens holding open attempts that nothing will
 * ever resolve, since `answerStore.hold` writes `held` whether or not anything
 * is scheduled to move it. The two go in together or the runner is broken.
 *
 * It reuses `tripwire.issues` rather than opening its own client: same token,
 * same repository, same labels, and one place where a missing token turns into
 * *file nothing and carry on* instead of two that could disagree about it.
 */
const redLineReviewStore: RedLineReviewStore = {
  held: (limit) => heldRedLineReports(db, limit),
  resolve: (input) => resolveRedLineOnReview(db, input),
}

/**
 * The second reading of quest verdicts the judge passed (`#221`, `#944`).
 *
 * **`stewardId: null` is the runner's pass, and it is not an exemption.**
 * `recordAuditDecision` refuses a steward auditing its own quest; this pass
 * sponsors nothing, so the guard has nothing to protect against and is skipped
 * rather than worked around. The column has always been nullable — it was
 * written that way for the departing steward whose decisions outlive it — so a
 * reading with no agent behind it is the same fact recorded by nobody in
 * particular, and needed no migration.
 *
 * The queue is drawn without a steward id for the same reason: there is no
 * sponsor to exclude.
 */
const questAuditStore: QuestAuditStore = {
  queue: (limit) => questAuditQueue(db, { rate: questAudit.rate }, limit),
  record: (input) => recordAuditDecision(db, { ...input, stewardId: null }),
}

/**
 * The trace behind the one tool the steward tier still holds (`#944`).
 *
 * **Here rather than at the call.** `apps/api` opens no issues and holds no
 * GitHub token, and giving it one would put a write credential for the Colony's
 * own repository behind every request the API serves — to record an act that
 * happens a handful of times a year. This process already holds that token for
 * the tripwire, and reuses `tripwire.issues` for the same reason
 * `redLineReviewStore` does: one place where a missing token means *file nothing
 * and carry on*.
 */
const questEndingsStore: QuestEndingsStore = {
  endedByLever: (withinDays, limit) => stewardEndedQuests(db, { withinDays }, limit),
}

/**
 * The scrub between what a citizen said about a quest and the sponsor that
 * wrote it (`#240`).
 *
 * Fourth pass in the same process, on the same poll, for the reason the third
 * one is here.
 */
const questReportStore: QuestReportModerationStore = {
  pending: (limit) => unmoderatedQuestReports(db, limit),
  // The payment a published obstacle earns is booked inside that call and is
  // deliberately not this loop's business (`#371`) — it returns what it paid,
  // and the runner does not need to know.
  write: async (input) => {
    await recordQuestReportModeration(db, { ...input, decision: 'approved' })
  },
  refuse: async (input) => {
    await recordQuestReportModeration(db, { ...input, decision: 'rejected' })
  },
  // The same flag a rung's corpus sets on approval (`#367`). A quest's published
  // obstacles are written up by the same synthesis loop, so they enter its queue
  // the same way.
  markStale: (taskId) => markBriefingStale(db, taskId),
}

/**
 * Whether a proposed provider belongs on the map (`#812`).
 *
 * Sixth pass in the same process, on the same poll, for the reason the third,
 * fourth and fifth are here. The store is three functions because the pass is
 * three things: read the queue, ask whether the catalogue already holds it, and
 * write a verdict in the transaction that acts on it.
 */
const atlasStore: AtlasModerationStore = {
  pending: (limit) => unjudgedAtlasProposals(db, limit),
  listed: (provider) => atlasEntryFor(db, provider),
  record: async (input) => {
    const written = await recordAtlasModeration(db, input)

    return { outcome: written.outcome }
  },
}

/**
 * What a walker wrote about the provider it walked (`#810`).
 *
 * Eighth pass in the same process. The text it judged travels back into each
 * write so the verdict lands on the words that were read and not on whatever
 * replaced them since; the second queue is the permanent repair for `#1095`.
 */
const walkProseStore: WalkProseModerationStore = {
  requeueRefused: (limit) => requeueRefusedWalkProse(db, limit),
  pending: (limit) => unmoderatedWalkProse(db, limit),
  approvedWithoutScrub: (limit) => approvedWalkProseWithoutScrub(db, limit),
  write: async ({ walk, scrubbed }) => {
    await recordWalkProseModeration(db, {
      walkId: walk.walkId,
      judged: walk.prose,
      decision: 'approved',
      scrubbed,
    })
  },
  refuse: async ({ walk }) => {
    const { suspended } = await recordWalkProseModeration(db, {
      walkId: walk.walkId,
      judged: walk.prose,
      decision: 'rejected',
    })

    return { suspended }
  },
  rescrub: async ({ walk, ...decision }) => {
    const command =
      decision.decision === 'approved'
        ? {
            walkId: walk.walkId,
            judged: walk.prose,
            decision: 'approved' as const,
            scrubbed: decision.scrubbed,
          }
        : {
            walkId: walk.walkId,
            judged: walk.prose,
            decision: 'rejected' as const,
          }
    const result = await recordApprovedWalkProseRescrub(db, command, decision.markProviderStale)

    return { written: result.outcome === 'written', suspended: result.suspended }
  },
  markDuplicates: (limit) => markPublishedDuplicateWalks(db, limit),
}

/**
 * Reading what citizens said they want to become (`#140`).
 *
 * **Fifth pass in the same process, and the one that costs the least to lose.**
 * The classifier is built from the same key every other model call here uses;
 * without one it answers `null` for every citizen and the pass defers everybody
 * forever, which is exactly the right behaviour — an unclassified citizen has no
 * declared preference, and a listing with no preference is the one the Colony
 * served before any of this existed.
 *
 * `DirectionStore` takes the stance as a plain string, because what the runner
 * has is whatever the classifier answered; narrowing it to the closed set is
 * `writeDirectionClassification`'s job and it does it against the vocabulary in
 * core rather than against a copy here.
 */
const directionStore: DirectionStore = {
  unclassified: (limit) => unclassifiedDirections(db, limit),
  write: (agentId, reading) =>
    writeDirectionClassification(db, agentId, {
      skills: reading.skills,
      stance: reading.stance as never,
    }),
}

/**
 * The profile fields waiting to be read before publication (`#827`).
 *
 * Three storage calls and no decision of its own: the pass decides, this hands
 * it rows. `defer` is the one worth noticing — a read that reached no verdict
 * still stamps the attempt, so an unreachable provider is not re-asked by the
 * next poll fifteen seconds later.
 */
const profileReviewStore: ProfileReviewStore = {
  waiting: (limit) => waitingProfileReviews(db, limit),
  record: (input) => recordProfileReview(db, input),
  defer: (id) => deferProfileReview(db, id),
}

const runner = startRunner(
  {
    store,
    model,
    log,
    tripwire,
    answers: { store: answerStore, model, log },
    redLineReview: { store: redLineReviewStore, model, issues: tripwire.issues, log },
    /**
     * **Wired exactly when the audit is enabled**, which is the one deployment
     * question `QuestAuditPolicy.enabled` answers: *does the Colony currently
     * re-read verdicts?* With it off nothing paid may be published at all, so
     * there is no money resting on a number nobody is producing; with it on, the
     * reading now starts itself instead of waiting on a steward the Colony does
     * not employ.
     */
    questAudit: questAudit.enabled ? { store: questAuditStore, model, log } : undefined,
    questEndings: { store: questEndingsStore, issues: tripwire.issues, log },
    questReports: { store: questReportStore, model, log },
    atlas: { store: atlasStore, model, log },
    walkProse: { store: walkProseStore, model, log },
    directions: {
      directions: directionStore,
      classifier: openRouterDirectionClassifier(
        process.env[OPENROUTER_API_KEY_VAR],
        process.env[DIRECTION_MODEL_VAR],
        modelFetch,
        log,
      ),
      log,
    },
    /**
     * The same model that judges reports reads profile fields (`#827`).
     *
     * One key, one provider, one place a model name is configured. A second
     * model here would be a second thing to keep reachable for a pass that
     * handles a handful of rows a day.
     */
    profiles: { profiles: profileReviewStore, model, log },
  },
  { pollIntervalMs: POLL_INTERVAL_MS },
)
const questRunner = startQuestRunner(
  // The quest stage gets the client that may not fall back (`#726`).
  {
    store,
    model,
    log,
    // The same opener the tripwire files through: a hold nobody lifts is a
    // maintainer's finding, and it goes where the other automated ones go
    // (`#759`).
    quests: { store: questStore, model: questModel, log, issues: tripwire.issues },
    // The playbook pass gets the same client the quests get, for the same
    // reason: it is a citizen's publication waiting on it, and a fallback model
    // that answers differently is not a cheaper verdict but a different one
    // (`#726`, `#1219`).
    playbooks: { store: playbookStore, model: questModel, log },
    playbookNotes: {
      store: playbookNoteStore,
      model: questModel,
      log,
      rewriteBriefing: rewritePlaybookBriefing,
    },
    playbookProposals: { store: playbookProposalStore, model: questModel, log },
    playbookRevisions: {
      store: playbookRevisionStore,
      log,
      rewriteBriefing: rewritePlaybookBriefing,
    },
    playbookBlocked: { store: playbookBlockedStore, log },
    // The ledger's retention sweep, on the slow tick beside the held quests
    // (`#1259`). One bounded delete an hour, and the only pass here whose
    // absence nobody would notice until a year of rows had built up.
    sweepContributionVerdicts: async (at) => await sweepContributionVerdicts(db, at),
    // Daily abusive-rate suspensions (`#1261`): lapse expired ones, then impose
    // new ones when both bounds hold. Shares the quest runner's timer.
    sweepAbusiveRateSuspensions: async (at) => await sweepAbusiveRateSuspensions(db, at),
  },
  { pollIntervalMs: QUEST_POLL_INTERVAL_MS },
)
const briefingRunner = startBriefingRunner(
  { store: briefings, providers: providerBriefings, categories: categoryProposals, model, log },
  { pollIntervalMs: BRIEFING_INTERVAL_MS },
)

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
  // Reported separately and with its own staleness budget, because the two ticks
  // run at different speeds: judging the synthesis loop against the moderation
  // interval would call it stalled during every gap it is supposed to have.
  briefingHealth: () => briefingRunner.health(),
  briefingStaleAfterMs: BRIEFING_INTERVAL_MS * STALE_POLLS,
})

log.info(
  `kolonie-moderation-runner started; polling every ${POLL_INTERVAL_MS}ms, ` +
    `quests every ${QUEST_POLL_INTERVAL_MS}ms, briefings every ${BRIEFING_INTERVAL_MS}ms, ` +
    `health on :${HEALTH_PORT}/health`,
  {
    event: 'service.started',
    pollIntervalMs: POLL_INTERVAL_MS,
    questPollIntervalMs: QUEST_POLL_INTERVAL_MS,
    briefingIntervalMs: BRIEFING_INTERVAL_MS,
    healthPort: HEALTH_PORT,
  },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received; finishing the entry in flight`, {
      event: 'service.stopping',
      signal,
    })
    void Promise.all([runner.stop(), questRunner.stop(), briefingRunner.stop()])
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
