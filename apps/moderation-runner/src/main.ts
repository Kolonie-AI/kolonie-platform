import {
  approvedOnTask,
  briefingCorpus,
  createDatabase,
  databaseUrlFromEnv,
  detectProviderChange,
  holdReportOnRedLine,
  unclassifiedDirections,
  writeDirectionClassification,
  pendingAnswerModerations,
  unmoderatedProviderReasons,
  markBriefingStale,
  questObstacleCorpus,
  readTaskKind,
  unmoderatedQuestReports,
  recordProviderReasonModeration,
  recordQuestReportModeration,
  pendingQuestModerations,
  pendingReports,
  publishQuest,
  questObstacleBonusPercentInDatabase,
  questsBySameSponsor,
  questsClearedForPublication,
  readTaskText,
  recordModeration,
  recordProviderChange,
  recordQuestModeration,
  settingsReader,
  writeScrubbedAnswers,
  staleBriefings,
  writeBriefing,
} from '@kolonie-ai/db'
import {
  BRIEFING_TICK_MULTIPLIER,
  startBriefingRunner,
  startQuestRunner,
  startRunner,
  synthesiseNow,
  type BriefingStore,
  type Log,
  type ModerationStore,
} from './loop.js'
import type { QuestModerationStore } from './quests.js'
import type { AnswerModerationStore } from './answers.js'
import type { ProviderReasonModerationStore } from './provider-reasons.js'
import type { QuestReportModerationStore } from './quest-reports.js'
import {
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
 * The audit brake and the obstacle share, read here (`#693`).
 *
 * **This process publishes quests now, so it carries what publishing needs.**
 * Both were the API's because the API was the only caller of `publishQuest`;
 * neither is a decision this runner makes. `questAuditPolicy` reads the
 * deployment's two variables and defaults to *off*, which refuses to publish
 * paid work rather than publishing it unguarded — a runner started without
 * `QUEST_AUDIT_ENABLED` behaves like an API started without it, which is the
 * property that matters when the two are wired by the same compose file.
 *
 * The settings reader is this process's one reader, on the API's terms: two
 * would be two answers to *what is the obstacle share* for as long as the caches
 * disagree.
 */
const questAudit = questAuditPolicy()
const settings = settingsReader(db)

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
  // Bounded, for `pendingQuestModerations`' reason: the comparison set is read
  // into a prompt, so its size is what one dedup call costs (`#694`).
  siblings: (taskId) => questsBySameSponsor(db, taskId, QUEST_SIBLINGS_IN_CONTEXT),
  publish: async (taskId) =>
    await publishQuest(db, {
      // No steward, and that is the whole of `#693`: the verdict published it.
      taskId,
      at: now(),
      audit: questAudit,
      // Frozen onto the row at publication and read back at every payout
      // (`#632`), exactly as the quest desk does it.
      obstacleBonusPercent: await questObstacleBonusPercentInDatabase(settings),
    }),
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
 * The scrub between a citizen's sentence about a provider and every citizen that
 * reads the register (`#362`).
 *
 * Fifth pass in the same process, on the same poll, for the reason the third and
 * fourth are here. It is keyed by the row's own primary key because
 * `provider_reports` has no surrogate id, and the text the moderator read
 * travels with the verdict so a citizen that rewrote its report while the pass
 * was thinking does not have the old verdict land on the new sentence.
 */
const providerReasonStore: ProviderReasonModerationStore = {
  pending: (limit) => unmoderatedProviderReasons(db, limit),
  write: async ({ reason, scrubbed }) => {
    await recordProviderReasonModeration(db, {
      ...reason,
      judged: reason.reason,
      decision: 'approved',
      scrubbed,
    })
  },
  refuse: async ({ reason }) => {
    await recordProviderReasonModeration(db, {
      ...reason,
      judged: reason.reason,
      decision: 'rejected',
    })
  },
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

const runner = startRunner(
  {
    store,
    model,
    log,
    tripwire,
    answers: { store: answerStore, model, log },
    questReports: { store: questReportStore, model, log },
    providerReasons: { store: providerReasonStore, model, log },
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
  },
  { pollIntervalMs: POLL_INTERVAL_MS },
)
const questRunner = startQuestRunner(
  // The quest stage gets the client that may not fall back (`#726`).
  { store, model, log, quests: { store: questStore, model: questModel, log } },
  { pollIntervalMs: QUEST_POLL_INTERVAL_MS },
)
const briefingRunner = startBriefingRunner(
  { store: briefings, model, log },
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
