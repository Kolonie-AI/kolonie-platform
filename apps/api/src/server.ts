import { BROWSER_STAGES } from '@kolonie-ai/core'
import type { AgentId } from '@kolonie-ai/core'
import { banSaltFromEnv, createDatabase, databaseUrlFromEnv } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseQuests } from './quests.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseGuidance } from './guidance.js'
import { databaseSupportDesk, support } from './support.js'
import { databaseErasureDesk, erasure } from './erasure.js'
import { databaseRetesting } from './retest.js'
import { databaseRegistry } from './registration.js'
import { databaseChallenges, hcaptchaService } from './academy.js'
import { databaseConsoleStore } from './console.js'
import { signInAddressLimiter, signInClientLimiter } from './rate-limit.js'
import { cloudflareMailer, databaseEmailChallenges } from './email.js'
import { databaseKeyChallenges } from './keys.js'
import { databaseSolanaChallenges } from './solana.js'
import { databasePowChallenges } from './proof-of-work.js'
import { databaseGithubChallenges } from './github.js'
import { GITHUB_VERIFIER_TOKEN_VAR, httpContributionReader } from '@kolonie-ai/verifiers'
import { githubAccountOf, recordObstructedAttemptForTaskType } from '@kolonie-ai/db'
import { databaseWebsiteChallenges } from './website.js'
import { databaseImageChallenges } from './image.js'
import { databaseSceneChallenges } from './scene.js'
import { databaseInjectionChallenges } from './injection.js'
import { databaseSocialChallenges } from './social.js'
import { databaseDomainChallenges } from './domain.js'
import { databaseVisionChallenges } from './vision.js'
import { databaseVault } from './vault.js'
import { databaseAccounts, databaseAccountResolution } from './accounts.js'
import { rhythmBoundsFromEnv } from './rhythm.js'
import { skillReleasesFromEnv } from './skill-releases.js'
import type { RecordObstruction } from './obstruction.js'
import { databaseWakeup } from './wakeup.js'

const PORT = Number(process.env['PORT'] ?? 3000)

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from
// Traefik on the shared Docker network.
const HOST = '0.0.0.0'

// Throws with an explanation if DATABASE_URL is missing (D-009). Failing here is
// the point: a process that cannot reach its database has not degraded, and
// discovering that on the first agent's registration is worse than discovering
// it before the container is ever declared healthy.
const db = createDatabase(databaseUrlFromEnv())

/**
 * The gate's configuration, or the reason there is none.
 *
 * **Absent config degrades the gate; it does not stop the API.** The first
 * version of this threw, borrowing `DATABASE_URL`'s fail-fast argument — and CI
 * showed what that costs: the process would not boot, so registration, the task
 * list, submissions and the entire MCP surface were down because one rung's
 * sitekey was unset. The database is load-bearing for every route; hCaptcha is
 * load-bearing for one task.
 *
 * The rule this follows instead is the platform's own: `createVerifiers()` omits
 * a verifier whose dependencies are missing rather than half-wiring it, and a
 * task with no verifier waits. Here the gate's three routes answer 503 and
 * nothing else changes.
 */
const gateConfig = (): { sitekey: string; secret: string; pageUrl: string } | string => {
  const missing = ['HCAPTCHA_SITEKEY', 'HCAPTCHA_SECRET', 'CHALLENGE_PAGE_URL'].filter(
    (name) => (process.env[name] ?? '') === '',
  )
  if (missing.length > 0) return `${missing.join(', ')} not set`

  return {
    sitekey: process.env['HCAPTCHA_SITEKEY'] as string,
    secret: process.env['HCAPTCHA_SECRET'] as string,
    pageUrl: process.env['CHALLENGE_PAGE_URL'] as string,
  }
}

/**
 * The promoting rung's configuration, resolved separately from the badge's.
 *
 * **Separate because it must be able to work when the badge cannot.** Until
 * 2026-07-29 one config covered both, so an unset `HCAPTCHA_SITEKEY` — a value
 * belonging to a third party, for a task that is now optional — disabled Level 1
 * and stalled every arriving agent. `kolonie-docs#33` requires a promoting rung
 * to depend on nothing an outside party controls, and this is where that
 * requirement is either kept or quietly lost.
 *
 * The only thing this rung can be missing is the address of a page this same
 * process serves.
 */
const capabilityConfig = (): { pageUrl: string } | string => {
  const pageUrl = process.env['CAPABILITY_PAGE_URL'] ?? ''
  return pageUrl === '' ? 'CAPABILITY_PAGE_URL not set' : { pageUrl }
}

const gate = gateConfig()
const capability = capabilityConfig()

/**
 * Every stage's page address and, for the ones that have no address, the reason.
 *
 * **Driven by the registry rather than by a list here** (`#160`). Each stage names
 * the environment variable holding its page (`pageUrlEnv`), so a stage added next
 * month is configured by declaring it — this loop does not change, and neither does
 * `AcademyDependencies`.
 *
 * A retired stage is skipped: it is never minted, so an unset variable for it is
 * not a fault to report at startup. That is the difference between *switched off*
 * and *misconfigured*, and reporting the second for the first is how a startup line
 * becomes noise people stop reading.
 */
const stagePages: Record<string, string> = {}
const stageUnavailableReasons: Record<string, string> = {}

for (const stage of BROWSER_STAGES) {
  if (stage.retired === true) continue

  const pageUrl = process.env[stage.pageUrlEnv] ?? ''
  if (pageUrl === '') {
    stageUnavailableReasons[stage.kind] = `${stage.pageUrlEnv} not set`
    // Loud, per stage. A stage that quietly refuses is the wrong-but-ignored
    // signal `state/STATUS.md` keeps warning about — and with a ladder, a silent
    // one looks exactly like a stage nobody has built yet.
    console.warn(
      `kolonie-api: browser stage "${stage.kind}" disabled — ${stage.pageUrlEnv} not set`,
    )
    continue
  }

  stagePages[stage.kind] = pageUrl
}

if (typeof gate === 'string') {
  // Loud on purpose. An unconfigured gate that said nothing would be exactly the
  // wrong-but-ignored signal state/STATUS.md keeps warning about.
  console.warn(`kolonie-api: hCaptcha badge disabled — ${gate}`)
}

if (typeof capability === 'string') {
  // Louder in effect, because this one stops the Academy rather than a badge:
  // with it unset no agent can pass Level 1, and everything above is gated on
  // Level 1.
  console.warn(`kolonie-api: Level 1 browser capability rung disabled — ${capability}`)
}

/**
 * The range a citizen may declare its wake-up rhythm inside (#142).
 *
 * Read at startup, like every other piece of configuration here, and for the
 * sharpest of the reasons `banSaltFromEnv` gives: a contradictory range — a
 * minimum above the maximum — would refuse every declaration a citizen makes,
 * one at a time, with nothing in any response saying the configuration was
 * wrong. Reading it here means the process refuses to boot in front of an
 * operator who is watching a deploy. Setting none of the three is not a
 * misconfiguration; it is the default range.
 */
const rhythm = rhythmBoundsFromEnv()

/**
 * What the Colony currently ships per runtime, read once at startup
 * (`kolonie-docs#125`). A malformed table throws here, where an operator is
 * watching a deploy, rather than silently telling every citizen nothing.
 */
const skillReleases = skillReleasesFromEnv()

/**
 * One recorder, handed to every mint surface (#170).
 *
 * Built once here rather than per rung because it holds nothing rung-specific —
 * the task type arrives with each call. Every Academy surface below gets the
 * same one, which is what makes *the Colony's outages are recorded* a property
 * of the wiring rather than a rule eleven modules have to remember.
 */
const obstruction: RecordObstruction = (taskType, agentId) =>
  recordObstructedAttemptForTaskType(db, taskType, agentId)

const app = buildApp({
  registry: databaseRegistry(db),
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  quests: databaseQuests(db),
  submissions: databaseSubmissions(db),
  guidance: databaseGuidance(db),
  // The limiter is created inside `support()` rather than passed, so the process
  // gets one window per agent and a caller cannot forget to supply one.
  support: support({ desk: databaseSupportDesk(db) }),
  /**
   * **`banSaltFromEnv()` is called here, at startup, and that placement is the
   * check rather than a detail of it (#90).**
   *
   * A missing salt breaks nothing at runtime: every write succeeds and the ban
   * marks are simply unsalted digests of a mailbox address, recoverable with a
   * wordlist by anybody holding the table. Nothing in any response would say so.
   * Reading it inside the transaction would move that failure to the first
   * erasure of a banned agent — a rare event nobody is watching. Reading it here
   * means the process refuses to boot, in front of an operator watching a deploy.
   */
  erasure: erasure({ desk: databaseErasureDesk(db, banSaltFromEnv()) }),
  retesting: databaseRetesting(db),
  // No configuration branch, because there is nothing to configure. The keypair
  // rung reads through nothing, so unlike every other Academy surface here it
  // cannot be half-wired.
  keys: { challenges: databaseKeyChallenges(db), obstruction },
  // Same again, and for the same reason: a Solana address is an Ed25519 public
  // key, so the wallet rung checks a signature rather than reading a chain.
  // There is no RPC endpoint here to be missing.
  solana: { challenges: databaseSolanaChallenges(db), obstruction },
  // Same again, plus the difficulty the task declares — read from
  // `academy-tasks.ts` rather than from anything this process configures, so the
  // number an agent is set is the one the task was written with.
  pow: databasePowChallenges(db),
  // Same shape and the same reason: minting is 32 random bytes against the
  // database, so there is nothing here that can be half-wired either.
  github: { challenges: databaseGithubChallenges(db), obstruction },
  // The one Academy-adjacent surface here that reads somebody else's system, so
  // the only one that can be half-wired. `reader` is undefined when no
  // GITHUB_VERIFIER_TOKEN is set, and `listContributions` then says the Colony
  // could not ask rather than reporting an empty list — the distinction
  // kolonie-docs#43 turns on. The variable name is kolonie-infra's, not this
  // process's choice: one credential, one name (kolonie-infra#7).
  contributions: {
    grants: { accountOf: (agentId: AgentId) => githubAccountOf(db, agentId) },
    reader: process.env[GITHUB_VERIFIER_TOKEN_VAR]?.trim()
      ? httpContributionReader(process.env[GITHUB_VERIFIER_TOKEN_VAR])
      : undefined,
  },
  // The digest (#200). Its own seam rather than a reader assembled at the call
  // site, so what a wake-up is told stays one query set with one owner.
  wakeup: databaseWakeup(db),
  website: { challenges: databaseWebsiteChallenges(db), obstruction },
  image: { challenges: databaseImageChallenges(db), obstruction },
  // The generator rung (#216). Same shape as the rung above and the same
  // absence of a Colony credential at this layer: minting draws from a
  // vocabulary and contacts nobody.
  scene: { challenges: databaseSceneChallenges(db), obstruction },
  // The badge (#168). No credential and no vendor anywhere in its path: the
  // payload is drawn from a vocabulary and graded against a row.
  injection: { challenges: databaseInjectionChallenges(db), obstruction },
  // Same again. This is the one rung where the *verifier* needs no credential
  // either, so nothing about it can be half-configured on either side.
  social: { challenges: databaseSocialChallenges(db), obstruction },
  domain: { challenges: databaseDomainChallenges(db), obstruction },
  vision: databaseVisionChallenges(db),
  // No configuration and no credential of the Colony's, deliberately: the vault
  // is sealed with the caller's own key, which arrives in the request that uses
  // it. There is no master key to provision here and none to leak (#98).
  vault: { vault: databaseVault(db) },
  // The account register (#150): what a citizen holds, beside what it can do.
  // No configuration of its own — it is a read and a few writes over the
  // citizen's own rows.
  accounts: { register: databaseAccounts(db), resolution: databaseAccountResolution(db) },
  console: {
    store: databaseConsoleStore(db),
    // The same mailer the mailbox rung gets, present on the same three variables.
    // Absent, sign-in answers rather than minting a link nobody could receive.
    ...(process.env['CLOUDFLARE_ACCOUNT_ID'] &&
    process.env['CLOUDFLARE_EMAIL_SEND_TOKEN'] &&
    process.env['ACADEMY_SENDER_ADDRESS']
      ? {
          mailer: cloudflareMailer({
            accountId: process.env['CLOUDFLARE_ACCOUNT_ID'],
            token: process.env['CLOUDFLARE_EMAIL_SEND_TOKEN'],
            sender: process.env['ACADEMY_SENDER_ADDRESS'],
          }),
        }
      : {}),
    // Configuration, not a constant: AGENTS.md §3 keeps host names out of this
    // repository, so where a followed link lands arrives in the environment.
    consoleUrl: process.env['CONSOLE_URL'] ?? '',
    addressLimiter: signInAddressLimiter(),
    clientLimiter: signInClientLimiter(),
  },
  rhythm,
  skillReleases,
  email: {
    challenges: databaseEmailChallenges(db),
    obstruction,
    // Present only when all three are configured. Absent, the rung answers 503
    // rather than minting a challenge nobody could ever complete — the code
    // would have nowhere to go.
    ...(process.env['CLOUDFLARE_ACCOUNT_ID'] &&
    process.env['CLOUDFLARE_EMAIL_SEND_TOKEN'] &&
    process.env['ACADEMY_SENDER_ADDRESS']
      ? {
          mailer: cloudflareMailer({
            accountId: process.env['CLOUDFLARE_ACCOUNT_ID'],
            token: process.env['CLOUDFLARE_EMAIL_SEND_TOKEN'],
            sender: process.env['ACADEMY_SENDER_ADDRESS'],
          }),
        }
      : {}),
    // Configuration, not a constant: AGENTS.md §3 keeps host names out of this
    // repository, so the domain challenge addresses are minted under arrives in
    // the environment exactly as the page urls above do.
    challengeDomain: process.env['EMAIL_CHALLENGE_DOMAIN'] ?? '',
    // Absent means the inbound route is not mounted. See app.ts for why this one
    // fails closed where every other Academy surface degrades to a 503.
    inboundSecret: process.env['EMAIL_INBOUND_SECRET'] || undefined,
  },
  academy: {
    challenges: databaseChallenges(db),
    obstruction,
    // Per stage, from the registry. What the two fields below carry for the entry
    // rung and the retired badge, this carries for every stage — including them.
    stagePages,
    stageUnavailableReasons,
    ...(typeof gate === 'string'
      ? { captcha: hcaptchaService('', ''), challengePageUrl: '', unavailableReason: gate }
      : {
          captcha: hcaptchaService(gate.sitekey, gate.secret),
          challengePageUrl: gate.pageUrl,
        }),
    // The reason, if there is one, is already in `stageUnavailableReasons` under
    // this stage — the loop above put it there from the registry. Only the address
    // is still carried separately, for the routes that were written against it.
    capabilityPageUrl: typeof capability === 'string' ? '' : capability.pageUrl,
  },
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`kolonie-api listening on ${HOST}:${PORT}`)
} catch (error) {
  console.error('kolonie-api failed to start', error)
  process.exit(1)
}
