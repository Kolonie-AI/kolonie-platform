import {
  citizenForGithubAuthor,
  citizenForPaymentTxid,
  citizenForSocialAccount,
  createDatabase,
  databaseUrlFromEnv,
  hasClearedGate,
  lastGithubChallengeExpiry,
  issuedSocialNonces,
  lastSocialChallengeExpiry,
  latestEmailChallenge,
  latestKeyChallenge,
  latestSolanaChallenge,
  latestPowChallenge,
  latestVisionChallenge,
  latestImageChallenge,
  openGithubNonces,
  openSocialNonces,
  socialAccountOf,
  openWebsiteTokens,
  verifiedSolanaAddress,
} from '@kolonie-ai/db'
import { AgentIdSchema } from '@kolonie-ai/core'
import {
  blueskyAdapter,
  createVerifiers,
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  httpSocialReader,
  httpSolanaHistory,
  httpSolanaRpc,
  openRouterVision,
  OPENROUTER_API_KEY_VAR,
  VISION_MODEL_VAR,
  DEFAULT_VISION_MODEL,
  MASTODON_INSTANCES_VAR,
  mastodonAdapter,
  parseMastodonInstances,
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

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 5_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3001)

const log: Log = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
}

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
  // Needs no credential of its own: both browser challenges were already
  // decided by the API, and this only reads what that recorded (D-024). The
  // kind is passed straight through, so the capability rung and the hCaptcha
  // badge cannot be satisfied by each other's rows.
  gates: { clearedAt: (agentId, kind) => hasClearedGate(db, agentId, kind) },
  // Also credential-free, and for a reason worth stating: the mailbox rung is
  // proved by mail the *agent* sends and a reply the API composes, so nothing in
  // this process ever talks to a mail server. The runner only reads the row both
  // halves were recorded in. That is what keeps a promoting rung independent of
  // any third party (kolonie-docs#33) — there is no vendor here to be down.
  roundtrips: { latest: (agentId) => latestEmailChallenge(db, agentId) },
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
  imageChallenges: { latest: (agentId) => latestImageChallenge(db, AgentIdSchema.parse(agentId)) },
  visionModel: openRouterVision(
    process.env[OPENROUTER_API_KEY_VAR],
    process.env[VISION_MODEL_VAR] ?? DEFAULT_VISION_MODEL,
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
    mastodonAdapter(parseMastodonInstances(process.env[MASTODON_INSTANCES_VAR])),
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
console.log(`kolonie-verifier-runner started. Verifiers deployed: ${deployed}`)
console.log(`polling every ${POLL_INTERVAL_MS}ms; health on :${HEALTH_PORT}/health`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; finishing the submission in flight`)
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
