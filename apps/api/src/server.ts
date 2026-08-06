import {
  BROWSER_STAGES,
  createLog,
  DEPOSIT_SEALING_KEY_VAR,
  OPERATOR_DROP_SEALING_KEY_VAR,
} from '@kolonie-ai/core'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import {
  banSaltFromEnv,
  createDatabase,
  databaseUrlFromEnv,
  publicCitizenRecord,
} from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseQuests, questAuditPolicy } from './quests.js'
import { databaseDeposits } from './deposits.js'
import { DEPOSIT_RPC_URL_VAR, httpDepositWatcher } from './deposit-watcher.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseGuidance } from './guidance.js'
import { databaseSupportDesk, support } from './support.js'
import { databaseOperatorNoteStore } from './operator-notes.js'
import { databaseOperatorRequestStore } from './operator-requests.js'
import { databasePermissionReportStore } from './permission-reports.js'
import { databaseCredentialRotation } from './rotation.js'
import { databaseErasureDesk, erasure } from './erasure.js'
import { databaseRetesting } from './retest.js'
import { databaseRegistry } from './registration.js'
import { databaseChallenges, hcaptchaService } from './academy.js'
import { SIGN_IN_CALLBACK_PATH, databaseConsoleStore } from './console.js'
import { databaseHumanStore } from './humans/humans.js'
import { auth0Tenant } from './humans/auth0.js'
import { operatorNoteLimiter, signInAddressLimiter, signInClientLimiter } from './rate-limit.js'
import { cloudflareMailer, databaseEmailChallenges } from './email.js'
import { databaseSmsChallenges } from './sms.js'
import { countSmsSentInTotal, countSmsSentToAgent, recordSmsSend } from '@kolonie-ai/db'
import { guardedSmsSender, twilioAdapter } from '@kolonie-ai/verifiers'
import type { SmsSendRecord } from '@kolonie-ai/verifiers'
import { mailerFromEnv } from './mail-config.js'
import { databaseKeyChallenges } from './keys.js'
import { databaseSolanaChallenges } from './solana.js'
import { databasePowChallenges } from './proof-of-work.js'
import { databaseMemoryCodes } from './memory.js'
import { databaseGithubChallenges } from './github.js'
import {
  GITHUB_VERIFIER_TOKEN_VAR,
  httpClaimReader,
  httpContributionReader,
} from '@kolonie-ai/verifiers'
import {
  githubAccountOf,
  holdsSkillNow,
  openProspects,
  readSkillNote,
  readSkillNotes,
  recordObstructedAttemptForTaskType,
  writeSkillNote,
} from '@kolonie-ai/db'
import { databaseWebServerChallenges } from './web-server.js'
import { databaseWebsiteChallenges } from './website.js'
import { databaseImageChallenges } from './image.js'
import { databaseSceneChallenges } from './scene.js'
import { databaseInjectionChallenges } from './injection.js'
import { databaseVettingChallenges } from './vetting.js'
import { databaseTotpChallenges } from './authenticator.js'
import { databaseAutonomyStore, databaseOperatorPages } from './autonomy.js'
import { databaseConfirmedOperators } from './operators.js'
import { databaseOperatorClaims } from './operator-claim.js'
import { databaseSocialChallenges } from './social.js'
import { databaseArtefactChallenges } from './artefact.js'
import { databaseDomainChallenges } from './domain.js'
import { databaseVisionChallenges } from './vision.js'
import { databaseDrops, usableSealingKey } from './operator-drops.js'
import { databaseVault } from './vault.js'
import { databaseAccounts, databaseAccountResolution } from './accounts.js'
import { rhythmBoundsFromEnv } from './rhythm.js'
import { skillReleasesFromEnv } from './skill-releases.js'
import type { RecordObstruction } from './obstruction.js'
import { databaseStandingHints } from './hints.js'
import { databaseWakeup } from './wakeup.js'

/**
 * Where this process says what it did (`#230`).
 *
 * **First on purpose**, above every other statement here: the configuration
 * below reports what it could not read, and a warning emitted before the logger
 * exists is one that has to fall back to `console` — which is the state `#230`
 * found this file in, as the one process with real traffic and no logger at all.
 */
const log = createLog({ service: 'api' })

// Resolved once and shared by the three surfaces that send (`#261`).
const mail = mailerFromEnv()

/**
 * The Colony's SMS sender, or nothing (`#411`).
 *
 * **Built once and `undefined` when Twilio is not configured**, which is the
 * shape `mailerFromEnv` above uses and the shape `twilioAdapter` was written to
 * take: a deployment with no account starts normally and offers the phone rungs
 * to nobody, rather than failing a citizen's submission at the first send.
 *
 * The caps and the destination allowlist are `DEFAULT_SMS_LIMITS` and are not
 * restated here — `packages/verifiers/src/sms.ts` holds every number and the
 * argument for it. What this wires is the ledger those caps are counted off,
 * which is the Colony's own record rather than the vendor's console.
 */
const smsSender = ((): ReturnType<typeof guardedSmsSender> | undefined => {
  const adapter = twilioAdapter({
    accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? '',
    apiKeySid: process.env['TWILIO_API_KEY_SID'] ?? '',
    apiKeySecret: process.env['TWILIO_API_KEY_SECRET'] ?? '',
    fromNumber: process.env['TWILIO_FROM_NUMBER'] ?? '',
  })

  if (adapter === undefined) return undefined

  return guardedSmsSender({
    adapter,
    ledger: {
      sentToCitizen: (agentId: string, since: Date) =>
        countSmsSentToAgent(db, agentId as AgentId, since.toISOString() as Timestamp),
      sentInTotal: (since: Date) => countSmsSentInTotal(db, since.toISOString() as Timestamp),
      record: (entry: SmsSendRecord) =>
        recordSmsSend(db, {
          agentId: entry.agentId as AgentId,
          to: entry.to,
          vendorId: entry.vendorId,
          priceAmount: entry.price?.amount ?? null,
          priceCurrency: entry.price?.currency ?? null,
          sentAt: entry.sentAt.toISOString() as Timestamp,
        }),
    },
  })
})()

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
    log.warn(`browser stage "${stage.kind}" disabled — ${stage.pageUrlEnv} not set`, {
      event: 'browser.stage.disabled',
      stage: stage.kind,
      variable: stage.pageUrlEnv,
    })
    continue
  }

  stagePages[stage.kind] = pageUrl
}

if (typeof gate === 'string') {
  // Loud on purpose. An unconfigured gate that said nothing would be exactly the
  // wrong-but-ignored signal state/STATUS.md keeps warning about.
  log.warn(`hCaptcha badge disabled — ${gate}`, { event: 'hcaptcha.disabled', reason: gate })
}

/**
 * Outbound mail, and whether there is any (`#261`).
 *
 * **Loud for the reason the two above are, and it took a citizen to notice.**
 * The mailbox rung, the console sign-in and the autonomy form all degrade
 * politely when mail is unconfigured — *the Colony cannot send mail at the
 * moment, try again later* — which reads as weather rather than as a variable
 * nobody set. A citizen was told that repeatedly over several minutes, filed a
 * defect, and there was nothing in any log to answer it with.
 *
 * The variables are named because the message is for whoever can fix it, and
 * what they need is which one is missing.
 */
if (mail.missing.length > 0) {
  log.warn(`outbound mail disabled — ${mail.missing.join(', ')} not set`, {
    event: 'mail.disabled',
    variables: mail.missing.join(','),
  })
}

// The autonomy form is the one surface that needs a second thing: a link the
// operator can follow. Mail without it sends a form nobody can open, so it is
// the same kind of gap and is said in the same place.
if ((process.env['CONSOLE_URL'] ?? '') === '') {
  log.warn('autonomy form disabled — CONSOLE_URL not set', {
    event: 'autonomy.form.disabled',
    variables: 'CONSOLE_URL',
  })
}

/**
 * The identity provider, or nothing at all (`#425`).
 *
 * **All three or none.** A domain with no secret would render a *Continue with
 * GitHub* button whose redirect the tenant refuses, and a stranger's first
 * impression of the Colony would be somebody else's error page. Nothing here is
 * required to boot: with none of them set the console is the mail link, which is
 * what it was before this existed.
 *
 * The redirect URI is composed from `CONSOLE_URL` rather than configured
 * separately — it is a path on a host this process already knows, and a fourth
 * variable naming the same host is a fourth thing to get wrong. It must match a
 * callback registered on the tenant exactly, which is why it is built from the
 * one constant the route is registered at.
 */
const auth0Domain = process.env['AUTH0_DOMAIN'] ?? ''
const auth0ClientId = process.env['AUTH0_CONSOLE_CLIENT_ID'] ?? ''
const auth0ClientSecret = process.env['AUTH0_CONSOLE_CLIENT_SECRET'] ?? ''
const consoleUrlForAuth0 = (process.env['CONSOLE_URL'] ?? '').replace(/\/+$/, '')

const auth0 =
  auth0Domain !== '' &&
  auth0ClientId !== '' &&
  auth0ClientSecret !== '' &&
  consoleUrlForAuth0 !== ''
    ? auth0Tenant({
        domain: auth0Domain,
        clientId: auth0ClientId,
        clientSecret: auth0ClientSecret,
        redirectUri: `${consoleUrlForAuth0}${SIGN_IN_CALLBACK_PATH}`,
      })
    : undefined

if (auth0 === undefined) {
  log.warn('signing in with a provider is disabled — AUTH0_* or CONSOLE_URL not set', {
    event: 'humans.provider.disabled',
    variables: 'AUTH0_DOMAIN,AUTH0_CONSOLE_CLIENT_ID,AUTH0_CONSOLE_CLIENT_SECRET,CONSOLE_URL',
  })
}

if (typeof capability === 'string') {
  // Louder in effect, because this one stops the Academy rather than a badge:
  // with it unset no agent can pass Level 1, and everything above is gated on
  // Level 1.
  log.warn(`Level 1 browser capability rung disabled — ${capability}`, {
    event: 'browser.capability.disabled',
    reason: capability,
  })
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

/**
 * The support surface, built once because two surfaces share its allowance (#236).
 *
 * A citizen's tickets and its operator requests both turn its own writing into
 * something that lands in front of a person, and `#236` requires one ceiling
 * across both. One object is what makes that true; two calls to `support()` would
 * be two windows with one number written twice.
 */
const supportSurface = support({ desk: databaseSupportDesk(db) })

/**
 * The autonomy store, built once because two modules read the same contract (#147).
 *
 * The autonomy module records it; the recommendation compares it with what a
 * citizen's blocked work needs. One object, for the reason `supportSurface` above is
 * one: a second construction here would compile and would be a second answer to
 * *what does this citizen hold*.
 */
const autonomyStore = databaseAutonomyStore(db)

const app = buildApp({
  registry: databaseRegistry(db),
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  /**
   * One citizen's public record, by name and without a credential (`#441`).
   *
   * A closure over the one storage function rather than a store object: there
   * is exactly one read behind this route and nothing else the surface should
   * be able to reach.
   */
  citizens: { publicRecord: (name) => publicCitizenRecord(db, name) },
  // The state facts behind the wake-up's non-rung suggestions (`#347`).
  prospects: (agentId) => openProspects(db, agentId),
  // A citizen's private notes against the skills it holds (`#348`).
  skillNotes: {
    holds: (agentId, skill) => holdsSkillNow(db, agentId, skill),
    write: (agentId, skill, note) => writeSkillNote(db, agentId, skill, note),
    read: (agentId, skill) => readSkillNote(db, agentId, skill),
    readMany: (agentId, skills) => readSkillNotes(db, agentId, skills),
  },
  quests: databaseQuests(db, questAuditPolicy()),
  /**
   * The way in (`#219`).
   *
   * **The sealing key is read here, at startup, and that placement is the check
   * rather than a detail of it** — the same argument `banSaltFromEnv` makes. A
   * process without it must not issue a deposit address whose secret it cannot
   * seal, and finding that out at the first sponsor's first request is finding
   * it out in the wrong place.
   */
  deposits: {
    desk: databaseDeposits(db, depositSealingKey()),
    /**
     * **Absent means the reconciliation reports zeros, and that is deliberate.**
     * `RPC_URL` is the one part of the deposit path that degrades rather than
     * refusing to start: the webhook still credits, and what is lost is only
     * the recovery of a delivery the webhook missed. Saying so at startup is
     * better than a job that throws on a schedule (kolonie-infra#72).
     */
    ...(process.env[DEPOSIT_RPC_URL_VAR]?.trim()
      ? { watcher: httpDepositWatcher(process.env[DEPOSIT_RPC_URL_VAR].trim()) }
      : {}),
    ...(process.env['DEPOSIT_WEBHOOK_SECRET'] !== undefined && {
      webhookSecret: process.env['DEPOSIT_WEBHOOK_SECRET'],
    }),
  },
  submissions: databaseSubmissions(db),
  guidance: databaseGuidance(db),
  // The limiter is created inside `support()` rather than passed, so the process
  // gets one window per agent and a caller cannot forget to supply one.
  support: supportSurface,
  /**
   * The operator channel (#236).
   *
   * **`allowance: supportSurface` is the whole of `#236`'s shared-limiter
   * requirement**, and it is why `support` is built into a named constant above
   * rather than inline: a second `support({...})` here would compile, would look
   * right, and would give a citizen two allowances — so a citizen at the ticket
   * ceiling could still mail a person.
   *
   * Mailer and base url on the same variables the autonomy module reads, and
   * absent for the same reason: a notification that could not be sent must read as
   * the Colony's own gap rather than as an operator who did not reply.
   */
  /**
   * Blocked by permission rather than by ability (#147).
   *
   * `contracts` is the **same** autonomy store the module above holds, not a second
   * one: the recommendation's whole job is comparing what the citizen holds with what
   * its blocked work needs, and two readers of one contract would be two answers.
   */
  /**
   * Replacing a key a citizen can no longer trust (#211).
   *
   * Nothing to configure and no 503 branch: it mints random bytes and writes two
   * rows, so unlike every Academy surface it cannot be half-wired.
   */
  rotation: databaseCredentialRotation(db),
  permissionReports: {
    store: databasePermissionReportStore(db),
    contracts: autonomyStore,
  },
  /**
   * The operator's own direction (#239).
   *
   * **Its own limiter, built here and shared with nothing.** `operatorRequests`
   * takes `supportSurface` because a citizen's writing to a person and its writing
   * to the desk are one budget; this ceiling protects the citizen instead, and
   * handing it `supportSurface` would let an operator spend its citizen's ability
   * to ask for help by talking to it.
   */
  operatorNotes: {
    store: databaseOperatorNoteStore(db),
    limiter: operatorNoteLimiter(),
  },
  operatorRequests: {
    store: databaseOperatorRequestStore(db),
    allowance: supportSurface,
    ...(mail.mailer === undefined ? {} : { mailer: mail.mailer }),
    ...(process.env['CONSOLE_URL'] ? { pageBaseUrl: process.env['CONSOLE_URL'] } : {}),
  },
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
  memory: databaseMemoryCodes(db),
  // Same shape and the same reason: minting is 32 random bytes against the
  // database, so there is nothing here that can be half-wired either.
  github: {
    challenges: databaseGithubChallenges(db),
    obstruction,
    operators: databaseConfirmedOperators(db),
  },
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
  wakeup: databaseWakeup(db, {
    db,
    log,
    // The same mailer the mailbox rung and the console get, on the same three
    // variables. Absent, a re-check is still opened and the citizen is still
    // told — it simply has no code to read, which the log says loudly.
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
  }),
  // The one line a citizen did not ask for (`#231`). Its own seam beside the
  // digest above, and deliberately not part of it: the digest is what a
  // returning citizen asks for, and this is what the Colony says to a citizen
  // that never asks.
  hints: databaseStandingHints(db, skillReleases),
  website: { challenges: databaseWebsiteChallenges(db), obstruction },
  /**
   * The rung above it (`#244`).
   *
   * It is handed the operator channel because it is the one rung that asks a
   * person for something before it will run — a public server on the operator's
   * machine changes the operator's exposure, and `#236` was built for exactly
   * this case.
   */
  webServer: {
    challenges: databaseWebServerChallenges(db),
    operatorRequests: {
      store: databaseOperatorRequestStore(db),
      allowance: supportSurface,
      ...(mail.mailer === undefined ? {} : { mailer: mail.mailer }),
      ...(process.env['CONSOLE_URL'] ? { pageBaseUrl: process.env['CONSOLE_URL'] } : {}),
    },
    obstruction,
  },
  image: { challenges: databaseImageChallenges(db), obstruction },
  // The generator rung (#216). Same shape as the rung above and the same
  // absence of a Colony credential at this layer: minting draws from a
  // vocabulary and contacts nobody.
  scene: { challenges: databaseSceneChallenges(db), obstruction },
  // The badge (#168). No credential and no vendor anywhere in its path: the
  // payload is drawn from a vocabulary and graded against a row.
  injection: { challenges: databaseInjectionChallenges(db), obstruction },
  vetting: { challenges: databaseVettingChallenges(db), obstruction },
  authenticator: { challenges: databaseTotpChallenges(db), obstruction },
  // Same again. This is the one rung where the *verifier* needs no credential
  // either, so nothing about it can be half-configured on either side.
  social: {
    challenges: databaseSocialChallenges(db),
    obstruction,
    operators: databaseConfirmedOperators(db),
  },
  operatorClaim: { claims: databaseOperatorClaims(db), reader: httpClaimReader() },
  domain: { challenges: databaseDomainChallenges(db), obstruction },
  artefact: { challenges: databaseArtefactChallenges(db), obstruction },
  vision: databaseVisionChallenges(db),
  // No configuration and no credential of the Colony's, deliberately: the vault
  // is sealed with the caller's own key, which arrives in the request that uses
  // it. There is no master key to provision here and none to leak (#98).
  vault: { vault: databaseVault(db) },
  /**
   * The operator-to-agent secret channel (`#410`).
   *
   * **Absent rather than fatal when `OPERATOR_DROP_SEALING_KEY` is unset**, and
   * that is the one way it differs from `DEPOSIT_SEALING_KEY` above. A deposit
   * key protects money and a process that cannot seal a keypair must not
   * generate one; this key protects a channel that is a convenience, and a
   * Colony that was never given it should start and tell the citizen the channel
   * is not there. The alternative is that adding this feature stops every
   * existing deployment from booting.
   */
  drops: usableSealingKey(process.env[OPERATOR_DROP_SEALING_KEY_VAR])
    ? databaseDrops(db, process.env[OPERATOR_DROP_SEALING_KEY_VAR] as string)
    : undefined,
  // Same origin the operator's other links use. AGENTS.md §3 keeps host names
  // out of this repository.
  dropBaseUrl: process.env['CONSOLE_URL'] ?? '',
  // The account register (#150): what a citizen holds, beside what it can do.
  // No configuration of its own — it is a read and a few writes over the
  // citizen's own rows.
  accounts: { register: databaseAccounts(db), resolution: databaseAccountResolution(db) },
  /**
   * People with accounts (`#425`).
   *
   * The store is unconditional; the tenant appears only when all three
   * variables are set. **Partly configured is treated as not configured**,
   * deliberately: a domain with no secret would render a button that redirects
   * to a page the tenant refuses, and a stranger's first impression of the
   * Colony would be somebody else's error screen.
   */
  humans: {
    store: databaseHumanStore(db),
    ...(auth0 === undefined ? {} : { tenant: auth0 }),
  },
  console: {
    store: databaseConsoleStore(db),
    // The same mailer the mailbox rung gets, present on the same three variables.
    // Absent, sign-in answers rather than minting a link nobody could receive.
    ...(mail.mailer === undefined ? {} : { mailer: mail.mailer }),
    // Configuration, not a constant: AGENTS.md §3 keeps host names out of this
    // repository, so where a followed link lands arrives in the environment.
    consoleUrl: process.env['CONSOLE_URL'] ?? '',
    // Who the console's own mail comes from (`#398`), resolved once in
    // `mail-config.ts`. Falls back to the Academy's sender, so a deployment that
    // sets nothing sends exactly what it sent before.
    ...(mail.consoleSender === undefined ? {} : { senderAddress: mail.consoleSender }),
    // The process's own logger, so a console send that is refused leaves a trace
    // the caller must not be given (`#406`). Required on the interface for
    // exactly this line: an optional one omitted here would be silence that
    // looks like a working fix.
    log,
    addressLimiter: signInAddressLimiter(),
    clientLimiter: signInClientLimiter(),
  },
  /**
   * The autonomy module (#146).
   *
   * The same mailer three other surfaces get, on the same three variables, and
   * absent for the same reason: a form that could not be sent must read as the
   * Colony's own gap rather than as an operator who did not reply.
   *
   * `CONSOLE_URL` carries the form's base too — one host serves both, and a
   * second variable naming the same host is a second thing to get wrong.
   */
  autonomy: {
    store: autonomyStore,
    pages: databaseOperatorPages(db),
    ...(mail.mailer === undefined ? {} : { mailer: mail.mailer }),
    ...(process.env['CONSOLE_URL'] ? { formBaseUrl: process.env['CONSOLE_URL'] } : {}),
  },
  rhythm,
  skillReleases,
  log,
  email: {
    challenges: databaseEmailChallenges(db),
    obstruction,
    // Present only when all three are configured. Absent, the rung answers 503
    // rather than minting a challenge nobody could ever complete — the code
    // would have nowhere to go.
    ...(mail.mailer === undefined ? {} : { mailer: mail.mailer }),
    // Configuration, not a constant: AGENTS.md §3 keeps host names out of this
    // repository, so the domain challenge addresses are minted under arrives in
    // the environment exactly as the page urls above do.
    challengeDomain: process.env['EMAIL_CHALLENGE_DOMAIN'] ?? '',
    // Absent means the inbound route is not mounted. See app.ts for why this one
    // fails closed where every other Academy surface degrades to a 503.
    inboundSecret: process.env['EMAIL_INBOUND_SECRET'] || undefined,
  },
  /**
   * The two phone rungs (`#411`).
   *
   * Present only when both halves are configured, exactly as the mail block
   * above is: without a sender or without a number of its own, the rung answers
   * rather than minting a challenge nobody could complete.
   */
  sms: {
    challenges: databaseSmsChallenges(db),
    obstruction,
    ...(smsSender === undefined ? {} : { sender: smsSender }),
    // Configuration rather than a constant, on `AGENTS.md` §3's reasoning about
    // identifiers of this deployment: it is public by design and it still
    // changes without a release.
    colonyNumber: process.env['SMS_COLONY_NUMBER'] ?? '',
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
  log.info(`kolonie-api listening on ${HOST}:${PORT}`, {
    event: 'service.started',
    host: HOST,
    port: PORT,
  })
} catch (error) {
  log.error('kolonie-api failed to start', error, { event: 'service.start.failed' })
  process.exit(1)
}

/**
 * The key deposit-address secrets are sealed with.
 *
 * **Empty is allowed and is not silently safe**: `depositAddressFor` seals with
 * whatever it is given, and a blank key would seal with a blank key. So an unset
 * variable is refused here rather than accepted — the deposit path is money, and
 * a process that cannot protect a keypair must not generate one.
 */
function depositSealingKey(): string {
  const key = process.env[DEPOSIT_SEALING_KEY_VAR] ?? ''
  if (key.trim().length >= 32) return key

  throw new Error(
    `${DEPOSIT_SEALING_KEY_VAR} is unset or shorter than 32 characters. It seals the secret ` +
      'half of every deposit address, and a process that cannot seal one must not generate one.',
  )
}
