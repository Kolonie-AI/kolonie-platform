import {
  citizenForGithubAuthor,
  githubAccountOf,
  citizenForPaymentTxid,
  citizenForSocialAccount,
  createDatabase,
  databaseUrlFromEnv,
  handoverAround,
  hasClearedGate,
  lastGithubChallengeExpiry,
  issuedSocialNonces,
  lastSocialChallengeExpiry,
  latestEmailChallenge,
  latestEmailSendChallenge,
  latestSmsChallenge,
  provedMailbox,
  latestKeyChallenge,
  latestSolanaChallenge,
  latestPowChallenge,
  latestVisionChallenge,
  latestArtefactChallenge,
  latestImageChallenge,
  recordArtefactServed,
  latestSceneChallenge,
  latestInjectionChallenge,
  latestVettingChallenge,
  totpRungRecord,
  openGithubNonces,
  openSocialNonces,
  socialAccountOf,
  openDomainNonces,
  lastDomainExpiry,
  citizenForDomainName,
  contactGaps,
  memoryRungRecord,
  hasAutonomyContract,
  domainGrantOf,
  latestRecheck,
  recheckableAccounts,
  liveWakeChallenge,
  openWebServerChallenges,
  openWebsiteTokens,
  probeFor,
  verifiedSolanaAddress,
  questDefinition,
  isHeldOnRedLine,
  scrubbedAnswers,
} from '@kolonie-ai/db'
import {
  AgentIdSchema,
  createLog,
  gatewayFromEnvironment,
  gatewayRoutedFetch,
  SubmissionIdSchema,
  TaskIdSchema,
  type AgentId,
} from '@kolonie-ai/core'
import {
  blueskyAdapter,
  createVerifiers,
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  httpSocialReader,
  nodeDnsReader,
  httpSolanaHistory,
  httpSolanaRpc,
  openRouterArtefactReader,
  openRouterVision,
  openRouterSceneVision,
  openRouterBioJudge,
  openRouterQuestJudge,
  QUEST_JUDGE_MODEL_VAR,
  BIO_MODEL_VAR,
  OPENROUTER_API_KEY_VAR,
  VISION_MODEL_VAR,
  SCENE_VISION_MODEL_VAR,
  MASTODON_INSTANCES_VAR,
  mastodonAdapter,
  moltbookAdapter,
  xAdapter,
  mastodonInstances,
  SOLANA_RPC_URL_VAR,
} from '@kolonie-ai/verifiers'
import { createHealthServer, STALE_POLLS } from './health.js'
import { startRunner, type Log } from './loop.js'
import { databaseQueue } from './queue.js'

/**
 * Entry point of the verifier runner.
 *
 * Wiring only: the loop is in `loop.ts`, the decision in `runner.ts`, the SQL in
 * `packages/db`. Nothing here decides anything, which is why nothing here is
 * tested — everything with behaviour is reachable without starting a process.
 */

/**
 * Which Mastodon instances this deployment certifies (`#482`, `#509`).
 *
 * Resolved once, here, so the startup line below can say it. `#509` is the
 * argument for saying it at all: the list was silently empty in production for a
 * day, the repository said otherwise, and nothing on the host could be asked
 * — the first the Colony heard of it was a citizen that had opened an account on
 * the strength of the task text.
 */
const MASTODON_INSTANCES = mastodonInstances(process.env[MASTODON_INSTANCES_VAR])

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 5_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3001)

// One JSON object per line, on stdout, with `service` set once here (`#230`).
// The three methods that forwarded to `console` printed prose, and
// `console.error(message, error)` printed a stack through Node's inspector —
// one failure, N lines, and nothing able to rejoin them.
const log: Log = createLog({
  service: 'verifier-runner',
  redactUrls: [process.env['LLM_GATEWAY_BASE_URL']],
})

/**
 * What every model in this runner talks through (`#674`).
 *
 * The LLM gateway first and OpenRouter on any failure, or — with no
 * `LLM_GATEWAY_API_KEY_VERIFIER` set — `fetch` itself, unwrapped. That is how
 * this runner is put back on OpenRouter: remove the key. No code change, and no
 * effect on the other three services, which hold keys of their own so one
 * service's traffic can be capped or revoked without touching theirs.
 *
 * It is one wrapper for five checkers rather than five arrangements, and each of
 * them keeps its own error semantics untouched: a gateway attempt that goes
 * wrong is replayed against OpenRouter underneath, so `unavailable` still means
 * what it meant and no citizen is failed for our routing.
 */
const modelFetch = gatewayRoutedFetch(gatewayFromEnvironment('verifier'), {
  log,
})

// Throws with an explanation if DATABASE_URL is missing (D-009). Failing at
// startup is the point: a runner that cannot reach its database has not
// degraded, and a submission nobody verifies is invisible until an agent
// complains that its verdict never arrived.
const db = createDatabase(databaseUrlFromEnv())

/**
 * The one place the Colony's verifiers are assembled with what they read the
 * world through.
 *
 * The GitHub token is read-only and belongs to the Colony, never to an agent
 * (D-019). It is read here rather than inside `packages/verifiers` so that the
 * package stays testable without an environment and so that the credential is
 * named in exactly one file — this one. A runner started without it still
 * starts: `httpGitHubReader` answers `unavailable`, which becomes a `pending`
 * verdict, and the submissions wait for the deploy that supplies it rather than
 * being failed for a misconfiguration that is ours.
 *
 * `citizenForGithubAuthor` is the only reason this app knows about the database
 * on the verifiers' behalf. A verifier that could query storage itself would be
 * one refactor away from writing to it, which is the boundary `AGENTS.md` §3
 * draws — so the query lives in `packages/db` and arrives here as a function.
 */
const verifiers = createVerifiers({
  github: httpGitHubReader(process.env[GITHUB_VERIFIER_TOKEN_VAR]),
  authors: { citizenFor: (login) => citizenForGithubAuthor(db, login) },
  // The rung above the account (`#48`): which login *this* citizen proved, so a
  // merged pull request can be attributed without believing a profile field.
  githubGrants: { accountOf: (agentId) => githubAccountOf(db, AgentIdSchema.parse(agentId)) },
  // Needs no credential of its own: both browser challenges were already
  // decided by the API, and this only reads what that recorded (D-024). The
  // kind is passed straight through, so the capability rung and the hCaptcha
  // badge cannot be satisfied by each other's rows.
  gates: { clearedAt: (agentId, kind) => hasClearedGate(db, agentId, kind) },
  // The handover badge's second read (`#739`). Also credential-free, and also a
  // fact the Colony established rather than one an agent reported: a person
  // signed in to the console, accepted a share of this agent's, and the row
  // records when they joined and when they left.
  handovers: { around: (agentId, at) => handoverAround(db, agentId, at) },
  // Also credential-free, and for a reason worth stating: the granting node is
  // proved by a code the API mails and the agent reads, so nothing in *this*
  // process ever talks to a mail server. The runner only reads the row the proof
  // was recorded in. That is what keeps a promoting rung independent of any
  // third party (kolonie-docs#33) — there is no vendor here to be down.
  inboxes: { latest: (agentId: AgentId) => latestEmailChallenge(db, agentId) },
  // The badge's two reads, deliberately separate ports: one asks what the
  // citizen proved, the other what it is attempting now (kolonie-docs#92).
  sends: { latest: (agentId: AgentId) => latestEmailSendChallenge(db, agentId) },
  mailboxGrants: { grantOf: (agentId: AgentId) => provedMailbox(db, agentId) },
  // The two phone rungs (`#411`). Like the mail pair above, this process talks
  // to no vendor: the proof was recorded when the code came back or when the
  // message arrived, and the runner only reads the row.
  smsChallenges: {
    latestReceive: (agentId: AgentId) => latestSmsChallenge(db, agentId, 'receive'),
  },
  smsSendChallenges: { latestSend: (agentId: AgentId) => latestSmsChallenge(db, agentId, 'send') },
  // The one that reads through *nothing at all* — not a vendor, not a mail
  // server, not even a page this process serves. It hands the verifier the
  // stored nonce, public key and signature, and the verifier recomputes. That
  // is what makes this the Academy's cleanest root: there is no configuration
  // whose absence could disable a task an arriving agent needs early.
  keys: { latest: (agentId) => latestKeyChallenge(db, AgentIdSchema.parse(agentId)) },
  // The wallet rung, and credential-free for the same reason the keypair rung
  // is: a Solana address is an Ed25519 public key, so proving control of one is
  // arithmetic rather than a chain read. No RPC endpoint, no API key, nothing
  // an outage could take down — which is what the earlier testnet design, where
  // the agent had to send a funded transaction, could not offer.
  wallets: { latest: (agentId) => latestSolanaChallenge(db, AgentIdSchema.parse(agentId)) },
  /**
   * The earning rungs above the wallet, and the one place in the Academy that
   * reads the chain (`#61`, `#63`, `#64`).
   *
   * **Unconfigured is a working default here, unlike the GitHub token**, because
   * Solana's public mainnet endpoint needs no credential. That is what lets
   * these rungs ship without an infra ticket in front of them. It is
   * rate-limited, and when the Colony outgrows it the symptom is `unavailable`
   * — which re-queues the submission rather than failing an agent — so the fix
   * is a deploy and never an incident.
   *
   * The three ports go together. `paymentClaims` in particular is not optional
   * bookkeeping: it is the only thing standing between one payment and four
   * rungs cleared with it.
   */
  solana: httpSolanaRpc(process.env[SOLANA_RPC_URL_VAR]),
  solanaAddresses: {
    verifiedAddress: (agentId) => verifiedSolanaAddress(db, AgentIdSchema.parse(agentId)),
  },
  paymentClaims: { citizenFor: (txid) => citizenForPaymentTxid(db, txid) },
  /**
   * The trading rung's half, and the expensive one (`#65`). A payment verdict is
   * one RPC call; a trading verdict is a page of signatures plus a call per
   * transaction, against the endpoint the payment rungs share — which is why the
   * verifier caps what it will read rather than paging until it has everything.
   */
  solanaHistory: httpSolanaHistory(process.env[SOLANA_RPC_URL_VAR]),
  // Credential-free like the keypair rung, and cheaper than any of them: the
  // verifier recomputes one SHA-256 against the stored input, nonce and target.
  // The agent's spend does not become the Colony's, whatever it was.
  work: { latest: (agentId) => latestPowChallenge(db, AgentIdSchema.parse(agentId)) },
  vision: { latest: (agentId) => latestVisionChallenge(db, AgentIdSchema.parse(agentId)) },
  /**
   * The image rung (`#60`), which is the mirror of the one above: that verifier
   * reads the Colony's own record of a recognition challenge, this one hands a
   * picture to a vendor's model.
   *
   * **The only Academy verifier that spends money per submission.** A runner
   * without the key still starts and the verdicts come back `pending`, so an
   * unconfigured deploy leaves submissions waiting rather than failing agents —
   * the same arrangement the GitHub token has, and for the same reason.
   */
  /**
   * The `artefact-publish` rung (`#389`), on the same key and the same model as
   * `raster`.
   *
   * The same money rule holds: a runner without the key still starts and the
   * verdicts come back `pending`, so an unconfigured deploy leaves submissions
   * waiting rather than failing agents for our own deploy.
   */
  artefactChallenges: {
    latest: (agentId) => latestArtefactChallenge(db, agentId),
    recordServed: (agentId, artefactUrl) =>
      recordArtefactServed(db, AgentIdSchema.parse(agentId), artefactUrl),
  },
  artefactReader: openRouterArtefactReader(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[VISION_MODEL_VAR],
    modelFetch,
    log,
  ),
  imageChallenges: { latest: (agentId) => latestImageChallenge(db, AgentIdSchema.parse(agentId)) },
  // Both are passed straight through, blank and all: `openRouterVision` treats
  // an empty string as unset, because Compose writes `${VAR:-}` for every
  // optional variable and that is an empty string rather than `undefined`.
  visionModel: openRouterVision(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[VISION_MODEL_VAR],
    modelFetch,
    log,
  ),
  /**
   * The generator rung (`#216`), on the same key and a **different model**.
   *
   * `SCENE_VISION_MODEL` is separate from `VISION_MODEL` because the two rungs
   * ask different questions: `raster` asks whether a shape is blue, which the
   * cheap tier answers well, and this asks how many otters there are, which it
   * does not. One variable would price both at whichever is more demanding.
   *
   * Same degradation as the rung above — no key means `pending`, never a
   * failure, and here that matters more: an attempt at this rung cost the
   * citizen a render.
   */
  sceneChallenges: { latest: (agentId) => latestSceneChallenge(db, AgentIdSchema.parse(agentId)) },
  sceneVision: openRouterSceneVision(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[SCENE_VISION_MODEL_VAR],
    modelFetch,
    log,
  ),
  /**
   * The prompt-injection badge (`#168`). No vendor half and no credential: every
   * input is a row the Colony wrote and a string the citizen sent, so this line
   * is the whole of its wiring and it cannot be half-configured.
   */
  injectionChallenges: {
    latest: (agentId) => latestInjectionChallenge(db, AgentIdSchema.parse(agentId)),
  },
  /**
   * The vetting rung (`#45`), its sibling — same shape, same absence of a vendor
   * half, and its own line because a shared one would let a wiring mistake grade
   * a citizen against the exercise it did not sit.
   */
  vettingChallenges: {
    latest: (agentId) => latestVettingChallenge(db, AgentIdSchema.parse(agentId)),
  },
  /**
   * The second-factor rung (`#206`). Same shape again, and the port answers with
   * dates and counts — never the secret and never a code.
   */
  totpSecrets: {
    standing: (agentId) => totpRungRecord(db, AgentIdSchema.parse(agentId)),
  },
  /**
   * Level 0's one model check (`#137`), on the same key and passed through the
   * same way.
   *
   * **Unlike every other line in this object, omitting it would not disable a
   * rung.** A runner without the key still verifies `profile-complete` on the
   * structural bar and passes citizens who wrote a real bio — the degradation
   * goes towards passing here, because this is the rung standing in front of the
   * whole graph and an outage of ours must not close it.
   */
  bioJudge: openRouterBioJudge(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[BIO_MODEL_VAR],
    modelFetch,
    log,
  ),
  /**
   * The quest report's two halves (`#177`): the rows that say what a quest asks,
   * and the model that reads the answers against them.
   *
   * Both or neither, which `createVerifiers` enforces — a quest verifier with no
   * judge would claim every quest submission and answer `pending` to all of
   * them, which looks exactly like a queue nobody is serving.
   */
  questReports: {
    definition: async (taskId) => (await questDefinition(db, TaskIdSchema.parse(taskId))) ?? null,
    scrubbed: async (submissionId) =>
      (await scrubbedAnswers(db, SubmissionIdSchema.parse(submissionId))) ?? null,
    // Only reached when the line above answered `null` (`#446`).
    heldForReview: (submissionId) => isHeldOnRedLine(db, SubmissionIdSchema.parse(submissionId)),
  },
  questJudge: openRouterQuestJudge(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[QUEST_JUDGE_MODEL_VAR],
    modelFetch,
    log,
  ),
  // The GitHub rung's Colony-side half: which nonces this agent may currently
  // publish. Credential-free like the three above — the *token* this rung needs
  // is `github` up top, which reads the gist. Splitting the two means a missing
  // token stalls the read as `pending` rather than making the nonce lookup
  // answer wrongly about what the Colony asked for.
  githubChallenges: {
    openNonces: (agentId) => openGithubNonces(db, agentId),
    lastExpiry: (agentId) => lastGithubChallengeExpiry(db, agentId),
  },
  websiteChallenges: {
    openWebsiteTokens: (agentId) => openWebsiteTokens(db, agentId),
  },
  /**
   * The rung above it (`#244`).
   *
   * **Both methods go through `probeFor`**, which is the single place that
   * decides what a citizen may be told. A port that computed *which probe is
   * live* here would be a second chance to disclose the one the citizen has not
   * earned the right to see.
   */
  webServerChallenges: {
    liveProbe: async (agentId) => {
      const [row] = (await openWebServerChallenges(db, agentId)).filter(
        (candidate) => candidate.secondServedAt === null,
      )
      if (row === undefined) return undefined

      const probe = probeFor(row)
      if (probe === null) return undefined

      return {
        challengeId: row.id,
        origin: row.origin,
        which: probe.which,
        path: probe.path,
        nonce: probe.nonce,
        firstServedAt: row.firstServedAt,
      }
    },
    openChallenge: async (agentId) => {
      const [row] = (await openWebServerChallenges(db, agentId)).filter(
        (candidate) => candidate.secondServedAt === null,
      )
      if (row === undefined) return undefined
      return { firstServedAt: row.firstServedAt, secondServedAt: row.secondServedAt }
    },
  },
  /**
   * The wake rung (`#518`).
   *
   * **The secret and the nonce cross this boundary and go no further.** The
   * verifier needs both to make the knock the channel will make forever after,
   * and neither reaches a citizen-facing surface — the secret was shown once at
   * mint and the nonce is disclosed by being delivered.
   */
  wakeChallenges: {
    liveChallenge: async (agentId) => {
      const row = await liveWakeChallenge(db, agentId)
      if (row === undefined) return undefined

      return {
        challengeId: row.id,
        url: row.url,
        secret: row.secret,
        knockNonce: row.knockNonce,
      }
    },
  },
  /**
   * The social rung, and the only outward read path in the Academy that carries
   * no credential at all.
   *
   * Both networks serve public records unauthenticated, so there is nothing here
   * that a missing environment variable could switch off — which is the property
   * `kolonie-docs#49` chose the platforms for, since a granting task must not be
   * disableable by an outside party.
   *
   * The Mastodon allow-list is the one thing configured, and it is **empty until
   * an instance has been assessed against the three-part candidate rule in
   * `onboarding/academy.md`**. Empty is not broken: every Mastodon URL is refused
   * with a reason that says so and points at Bluesky, which is the honest answer
   * while the Colony has read no instance's rules. It is a list of hostnames and
   * not a secret, so it may be set wherever the runner's other settings are.
   */
  social: httpSocialReader([
    blueskyAdapter(),
    moltbookAdapter(),
    xAdapter(),
    /**
     * The assessed list, with the environment able to widen or replace it
     * (`#482`, `#509`). Which instances the Colony certifies on is a decision
     * taken against rules somebody read, so it lives in Git; the variable stays
     * for a host that needs to differ without waiting for a release, and
     * `mastodonInstances` is what decides — including that a blank value is
     * nobody having configured anything rather than a decision to certify none.
     */
    mastodonAdapter(MASTODON_INSTANCES),
  ]),
  socialChallenges: {
    openNonces: (agentId) => openSocialNonces(db, agentId),
    lastExpiry: (agentId) => lastSocialChallengeExpiry(db, agentId),
  },
  socialAccounts: { citizenFor: (account) => citizenForSocialAccount(db, account) },
  // The badge one node along reads the same grant forwards: which account this
  // citizen certified, so a post can be checked against it. Its own port rather
  // than a method on the one above, so the two directions cannot be crossed.
  socialGrants: {
    accountOf: (agentId) => socialAccountOf(db, agentId),
    noncesIssuedTo: (agentId) => issuedSocialNonces(db, agentId),
  },
  /**
   * The domain rung, and a stronger version of the property above it.
   *
   * The social reader needs no credential because both networks serve public
   * records; this one needs no *vendor*. Public DNS has no account, no key and
   * no quota that can lapse, so there is not even a free API tier that could be
   * withdrawn — which is what `kolonie-docs#89` argued the node was worth having
   * for, beyond what it certifies.
   *
   * Nothing here is configured, deliberately. The reader finds each name's own
   * nameservers and asks them, rather than trusting a recursive resolver this
   * process happens to be pointed at: a cached negative answer and a record the
   * citizen published five minutes ago are the same answer otherwise, and the
   * citizen would pay for the Colony's cache.
   */
  dns: nodeDnsReader(),
  domainChallenges: {
    openNonces: (agentId) => openDomainNonces(db, agentId),
    lastExpiry: (agentId) => lastDomainExpiry(db, agentId),
  },
  domainNames: { citizenFor: (name) => citizenForDomainName(db, name) },
  // The badge one node along reads the same grant forwards: which name this
  // citizen certified and when, so a fresh record can be checked against it. Its
  // own port rather than a method on the one above, so the two directions cannot
  // be crossed.
  domainGrants: { grantOf: (agentId) => domainGrantOf(db, agentId) },
  /**
   * The register, for the one badge that re-checks what a citizen holds (`#152`).
   *
   * A read and nothing else: the verifier asks which account has the oldest
   * evidence and returns a verdict, and what marks the register is the
   * transaction that records that verdict.
   */
  /**
   * The mailbox strategy reads what the API left behind (`#226`).
   *
   * **Nothing here sends mail**, and that is the arrangement rather than a
   * limitation: the check is started when the citizen wakes, by the process that
   * holds the mailer, and this process reads the row and turns it into a
   * verdict. A verifier reads the world and never writes to it.
   */
  mailboxRechecks: {
    start: async (_agentId, account) => {
      const latest = await latestRecheck(db, account.id)

      if (latest === null) {
        return {
          outcome: 'open' as const,
          address: account.identifier,
          // Nothing has been opened yet, which happens when the badge is handed
          // in before the citizen's next waking. The next wake-up opens it.
          expiresAt: 'your next wake-up',
        }
      }

      if (latest.answered) return { outcome: 'answered' as const, address: latest.recheck.address }

      if (latest.recheck.deliveryFailure !== null) {
        return {
          outcome: 'undeliverable' as const,
          reason: latest.recheck.deliveryFailure,
          permanent: latest.recheck.deliveryFailurePermanent,
        }
      }

      if (Date.parse(latest.recheck.expiresAt) <= Date.now()) {
        return { outcome: 'window_closed' as const, address: latest.recheck.address }
      }

      return {
        outcome: 'open' as const,
        address: latest.recheck.address,
        expiresAt: latest.recheck.expiresAt,
      }
    },
    sendProved: (account) => account.capabilities.includes('send' as never),
  },
  recheckableAccounts: {
    recheckable: (agentId, kinds) => recheckableAccounts(db, agentId, kinds),
  },
  // The heartbeat rung reads the Colony's own record and nothing else (#143).
  contacts: { gapsOf: (agentId, count) => contactGaps(db, agentId, count) },
  /**
   * The memory rung (#159). The judgement happened at redemption time; this reads
   * what it decided, and cannot reach the outstanding code even if it wanted to.
   */
  memoryCarries: { recordOf: (agentId) => memoryRungRecord(db, agentId) },
  /**
   * The autonomy rung (#146). A boolean and never the contract — see
   * `AutonomyContracts` for why the port is narrowed rather than convenient.
   */
  autonomyContracts: { isRecorded: (agentId) => hasAutonomyContract(db, agentId) },
})

const runner = startRunner(
  { queue: databaseQueue(db), verifiers, log },
  { pollIntervalMs: POLL_INTERVAL_MS },
)

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
})

const deployed = [...verifiers.keys()].join(', ') || 'none'
log.info(
  `kolonie-verifier-runner started. Verifiers deployed: ${deployed}. ` +
    `Mastodon instances certified: ${MASTODON_INSTANCES.join(', ') || 'none'}. ` +
    `Polling every ${POLL_INTERVAL_MS}ms; health on :${HEALTH_PORT}/health`,
  {
    event: 'service.started',
    verifiers: deployed,
    mastodonInstances: [...MASTODON_INSTANCES],
    pollIntervalMs: POLL_INTERVAL_MS,
    healthPort: HEALTH_PORT,
  },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received; finishing the submission in flight`, {
      event: 'service.stopping',
      signal,
    })
    void runner
      // Resolves once the verification in flight has been written. A submission
      // is lost only if the runtime kills the process before this returns, and
      // the timeout sweep is what reclaims it when that happens.
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
