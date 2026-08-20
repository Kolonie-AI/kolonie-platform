import {
  AgentIdSchema,
  BROWSER_STAGES,
  SupportTicketIdSchema,
  createLog,
  OPERATOR_DROP_SEALING_KEY_VAR,
  PAYOUT_WALLET_ADDRESS_VAR,
  PAYOUT_WALLET_SECRET_VAR,
  TREASURY_ADDRESS_VAR,
  payoutWalletMismatch,
  solanaAddressFromSeed,
  throttleRefusal,
} from '@kolonie-ai/core'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import {
  BOOTSTRAP_MAINTAINER_SUBJECT_VAR,
  banSaltFromEnv,
  bootstrapMaintainer,
  createDatabase,
  databaseUrlFromEnv,
  publicCitizenRecord,
  citizenIndexing,
  avatarByHandle,
  recordCall,
  callHoursSince,
  academyProgressFor,
  recordTelling,
  recordWalkSuggestion,
  proseForOpenDiagnoses,
  liftSuspension,
  listDiagnoses,
  diagnosisById,
  diagnosisCounts,
  consultationFunnel,
  ruleHealth,
  handlesOf,
  markConsulted,
  recordDoctorFeedback,
  checkThrottle,
} from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseQuests, questAuditPolicy } from './quests.js'
import { databaseSettings } from './settings.js'
import { settingValue } from '@kolonie-ai/db'
import { databaseWakeDesk, settingsReader } from '@kolonie-ai/db'
import { databaseProviderEnquiries } from './provider-enquiries.js'
import { databasePayments } from './payments.js'
import { databaseEarnings, databasePayouts, payoutConfigurationRefusal } from './payouts.js'
import { databaseTreasury } from './treasury.js'
import { httpPayoutChain } from './payout-chain.js'
import { PAYMENT_RPC_URL_VAR, httpPaymentWatcher } from './payment-watcher.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseGuidance } from './guidance.js'
import { arrivalReports, databaseArrivalDesk } from './arrival-reports.js'
import { databaseSupportDesk, support } from './support.js'
import { databaseOperatorNoteStore } from './operator-notes.js'
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
import { INBOUND_SMS_POLL_INTERVAL_MS, startInboundSmsPolling } from './sms-inbound.js'
import {
  countSmsSentInTotal,
  countSmsSentToAgent,
  countSmsSentToCountry,
  recordSmsSend,
} from '@kolonie-ai/db'
import { redeemAdoptionCode } from '@kolonie-ai/db'
import {
  DEFAULT_SMS_LIMITS,
  guardedSmsSender,
  twilioAdapter,
  twilioSmsGeography,
} from '@kolonie-ai/verifiers'
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
  findCitizens,
  acceptConnection,
  cancelConnectionRequest,
  declineConnectionRequest,
  followCitizen,
  followFeed,
  followFeedSince,
  listConnections,
  acknowledgeSystemMessage,
  blockSender,
  listConversations,
  listMessageRequests,
  listOperatorConversations,
  markConversationRead,
  readConversation,
  readOperatorConversation,
  removeConnection,
  replyInConversation,
  reportMessageAbuse,
  conversationAboutAccount,
  openOperatorHelpConversation,
  operatorThreadContext,
  operatorPageRecipient,
  operatorThreadsForPageToken,
  wishThreadsWaitingOn,
  answerOperatorThreadFromPage,
  citizenHandle,
  sendOperatorMessage,
  requestConnection,
  acceptMessageRequest,
  declineMessageRequest,
  sendCitizenMessage,
  unblockSender,
  unfollowCitizen,
  githubAccountOf,
  holdsSkillNow,
  listAccounts,
  openProspects,
  draftPlaybook,
  forkPlaybook,
  playbookById,
  playbookBySlug,
  playbookRunActivity,
  insertPlaybookStepProposal,
  countOpenPlaybookStepProposals,
  playbookContributors,
  playbookRevisionHistory,
  playbookRunFor,
  playbookSignalsTally,
  playbookRunCounts,
  playbooksByStatus,
  ownPlaybookJournal,
  publishedPlaybookJournal,
  writePlaybookJournalEntry,
  listPlaybookPublishedNotes,
  readPlaybookBriefingSplit,
  readPlaybookBriefingSummary,
  readPlaybookNote,
  submitPlaybookForReview,
  updatePlaybookDraft,
  recordPlaybookRun,
  readSkillNote,
  readSkillNotes,
  writePlaybookNote,
  recordObstructedAttemptForTaskType,
  walkRefusalTallies,
  writeSkillNote,
  answerDeskTicket,
  deskDepth,
  deskTicket,
  deskTickets,
  promoteToColony,
} from '@kolonie-ai/db'
import { askRefusal, databaseWebServerChallenges } from './web-server.js'
import { databaseWalks } from './account-walks.js'
import { databaseWishes } from './account-wishes.js'
import { swarmPortraitOf } from '@kolonie-ai/db'
import { databaseWakeChallenges } from './wake.js'
import { followRefusals } from './following.js'
import { messageRateLimited, messageRefusals, messagingAllowance } from './messaging.js'

/**
 * Citizen messaging rate limits (`#1290`). One object for the process, on
 * `supportSurface`'s terms: a second construction would give a citizen two
 * allowances and the cross-door test would lie.
 */
const messagingLimits = messagingAllowance()
import { connectionRefusals } from './connections.js'
import { wakeSender } from '@kolonie-ai/verifiers'
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
import { databaseHandovers } from './handovers.js'
import { databaseAccountOffers } from './account-offers.js'
import { databaseAccountThreads } from './account-threads.js'
import { databaseDrops, usableSealingKey } from './operator-drops.js'
import { operatorNotifierFor } from './operator-notifier.js'
import {
  notifyOperatorAboutThread,
  type OperatorThreadNotifyDependencies,
} from './operator-thread-notify.js'
import {
  databaseTelegram,
  httpTelegramBot,
  telegramFromEnv,
  type TelegramDesk,
} from './operator-telegram.js'
import { databaseVault } from './vault.js'
import { databaseAccounts, databaseAccountResolution } from './accounts.js'
import { databaseAccountProofs } from './account-proofs.js'
import { databaseProviderRecipes } from './provider-recipes.js'
import { databaseAtlasRenames } from './atlas/renames.js'
import { databaseAtlasQuests } from './atlas/links.js'
import { databaseAtlasPlaybooks } from './atlas/playbook-links.js'
import { databaseAttestations } from './attestations.js'
import { rhythmBoundsFromEnv } from './rhythm.js'
import { skillReleasesFromEnv } from './skill-releases.js'
import type { RecordObstruction } from './obstruction.js'
import { databaseStandingHints } from './hints.js'
import { databaseContributionQuality } from './contribution-quality.js'
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

// Resolved once and shared by the three surfaces that send (`#261`). The logger
// so that a mail desk that cannot be reached says so once per send rather than
// only to whichever citizen happened to be asking (`#1087`).
const mail = mailerFromEnv(process.env, cloudflareMailer, log)

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
const twilioCredentials = {
  accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? '',
  apiKeySid: process.env['TWILIO_API_KEY_SID'] ?? '',
  apiKeySecret: process.env['TWILIO_API_KEY_SECRET'] ?? '',
  fromNumber: process.env['TWILIO_FROM_NUMBER'] ?? '',
}

/**
 * What the vendor says the Colony may text (`#617`).
 *
 * Built from the same credentials as the adapter and separately, because the two
 * answer different questions and one of them is worth having on its own: the
 * rung's own text asks *which countries are reachable* without needing to send
 * anything.
 */
const smsGeography = twilioSmsGeography(twilioCredentials)

/**
 * The vendor itself, hoisted out of the sender below so both directions can have
 * it (`#690`).
 *
 * The sender wraps it in the caps and the allowlist, which is right for anything
 * leaving the Colony and meaningless for anything arriving: nothing is spent by
 * reading, and a message that has already been sent cannot be refused. So the
 * inbound poll takes the raw adapter, narrowed at its own boundary to the one
 * method it may call.
 */
const smsVendor = twilioAdapter(twilioCredentials)

const smsSender = ((): ReturnType<typeof guardedSmsSender> | undefined => {
  const adapter = smsVendor

  if (adapter === undefined) return undefined

  return guardedSmsSender({
    adapter,
    /**
     * The ceilings, read at the point of use rather than at startup (`#616`,
     * D-104).
     *
     * **The whole reason they are settings** is that the moment somebody wants
     * to move one is the moment an incident is happening, and a value chosen at
     * boot cannot be moved then. Each falls back to the default in
     * `packages/verifiers/src/sms.ts`, which holds every number and the argument
     * for it — a value nobody set, or one somebody set to nonsense, behaves as
     * though it had never been touched, the same shape `WAKE_MAX_PER_HOUR` uses.
     */
    limits: async () => {
      const ceiling = async (name: string, fallback: number): Promise<number> => {
        // `liveSettings` is declared further down this module and is read here
        // only when a send happens, which is long after the module has finished
        // evaluating.
        const held = await liveSettings.read(name)
        const parsed = held === undefined ? Number.NaN : Number.parseInt(held, 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
      }

      return {
        ...DEFAULT_SMS_LIMITS,
        perCitizen: await ceiling('SMS_MAX_PER_CITIZEN_PER_DAY', DEFAULT_SMS_LIMITS.perCitizen),
        perCountry: await ceiling('SMS_MAX_PER_COUNTRY_PER_DAY', DEFAULT_SMS_LIMITS.perCountry),
        globalPerWindow: await ceiling('SMS_MAX_PER_DAY', DEFAULT_SMS_LIMITS.globalPerWindow),
      }
    },
    // Present whenever Twilio is configured at all, which makes the read list
    // the answer and `DEFAULT_SMS_LIMITS.allowedPrefixes` the fallback for a
    // deployment that has no vendor to ask.
    ...(smsGeography === undefined ? {} : { geography: smsGeography }),
    ledger: {
      sentToCitizen: (agentId: string, since: Date) =>
        countSmsSentToAgent(db, agentId as AgentId, since.toISOString() as Timestamp),
      sentInTotal: (since: Date) => countSmsSentInTotal(db, since.toISOString() as Timestamp),
      sentToCountry: (country: string, since: Date) =>
        countSmsSentToCountry(db, country, since.toISOString() as Timestamp),
      record: (entry: SmsSendRecord) =>
        recordSmsSend(db, {
          agentId: entry.agentId as AgentId,
          to: entry.to,
          vendorId: entry.vendorId,
          priceAmount: entry.price?.amount ?? null,
          priceCurrency: entry.price?.currency ?? null,
          country: entry.country,
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
 * One live settings reader for the whole process (`#532`, D-104).
 *
 * **One and not one per consumer**, because each holds its own thirty-second cache: two
 * readers would mean two answers to *what is the limit* for up to thirty seconds after
 * a maintainer changed it, which is exactly the window somebody would be watching.
 */
const liveSettings = settingsReader(db)

/**
 * The wake channel, once for the process (`#518`).
 *
 * One sender, for `liveSettings`' reason: it reads the ceiling through that
 * cache, and a second would be a second answer to *what is the limit* for up to
 * thirty seconds after a maintainer changed it.
 */
const liveWake = wakeSender(databaseWakeDesk(db, liveSettings))

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

// The Atlas answers on the website's host and on no other (`#546`). Unset, it
// does not serve at all — said here rather than discovered as a 404, because
// the failure is otherwise indistinguishable from an empty catalogue.
if ((process.env['WEBSITE_URL'] ?? '') === '') {
  log.warn('atlas disabled — WEBSITE_URL not set', {
    event: 'atlas.disabled',
    variables: 'WEBSITE_URL',
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

/**
 * The Colony's own wallet, checked once — D-106 (`#503`).
 *
 * Read here rather than inside the dependency object because `colonyWallet`
 * throws on a half-configured or mismatched pair, and a check that ran twice
 * would report the same failure twice with no second meaning.
 */
const payoutWalletAddress = colonyWallet()

/**
 * Where the earned fee goes — `kolonie-docs#202`, swept by `#507`.
 *
 * **An address and never a key**, and this is the line that makes that true of
 * the whole process: nothing anywhere reads a Treasury secret, because there is
 * no variable holding one. The seed phrase is the maintainer's and belongs to
 * the succession arrangement.
 *
 * Absent means this deployment does not sweep. That is not a broken state — it
 * is every test and every environment that is not production — and it is the
 * same shape the payout ceilings use one constant down.
 */
const treasuryAddress = process.env[TREASURY_ADDRESS_VAR]?.trim() || undefined

/**
 * The payout ceilings, or nothing — D-106 (`#505`).
 *
 * **Read from the environment at startup and refused if half-set.** They are
 * settings (D-104) as well, so a maintainer turns them without a deploy; what
 * the environment supplies is the boot default, and a deployment that has a
 * wallet and no ceilings is one that would pay without a limit. Absent
 * altogether means this deployment does not pay at all, which is every
 * environment that is not production.
 */
const payoutCeilings = (():
  { readonly perTransaction: number; readonly perDay: number } | undefined => {
  const perTransaction = numericEnv('PAYOUT_MAX_LAMPORTS')
  const perDay = numericEnv('PAYOUT_DAILY_MAX_LAMPORTS')

  if (perTransaction === undefined && perDay === undefined) return undefined

  const refusal = payoutConfigurationRefusal({ perTransaction, perDay })
  if (refusal !== undefined) throw new Error(refusal)

  return { perTransaction: perTransaction as number, perDay: perDay as number }
})()

/**
 * The operator's desk on Telegram, or nothing (`#793`).
 *
 * Built once, on the shape `mailerFromEnv` and `twilioAdapter` above use: absent
 * configuration is a working deployment rather than a failure, and everything
 * downstream is written to cope with `undefined`. What differs from those two is
 * the fallback — no Telegram means mail, which is what every operator already
 * had, rather than a rung nobody can attempt.
 *
 * **Said once at startup rather than left to be discovered.** A maintainer who
 * set the three variables and mistyped one gets a line here; the alternative is
 * an operator page that quietly never shows the link.
 */
const operatorTelegram = ((): TelegramDesk | undefined => {
  const configured = telegramFromEnv()

  if (configured === undefined) {
    log.info('no Telegram operator desk is configured — operators are reached by email', {
      event: 'telegram.desk.absent',
    })
    return undefined
  }

  log.info('the Telegram operator desk is configured', {
    event: 'telegram.desk.ready',
    // The username and never the token. It is public — it is in every deep link
    // a person is handed — and it is the one value worth confirming from a log.
    username: configured.username,
  })

  return {
    store: databaseTelegram(db),
    bot: httpTelegramBot({ token: configured.token, username: configured.username, log }),
    webhookSecret: configured.webhookSecret,
  }
})()

/**
 * Telling a person their citizen has opened a thread (`#1321`, epic `#1318`).
 *
 * **Resolved once here**, for the reason `operatorNotifierFor` gives: Telegram where the operator bound it, mail
 * everywhere else, and the choice made at wiring time rather than at send time.
 * The recipient read is `operatorRequestRecipient` too — the page an operator
 * holds is one page, whichever surface asked them to open it.
 */
const operatorThreadNotify: OperatorThreadNotifyDependencies = {
  ...(mail.operatorMailer === undefined
    ? {}
    : {
        notifier: operatorNotifierFor({
          mailer: mail.operatorMailer,
          telegram: operatorTelegram,
          log,
        }),
      }),
  ...(process.env['CONSOLE_URL'] ? { pageBaseUrl: process.env['CONSOLE_URL'] } : {}),
  log,
  recipient: (agentId) => operatorPageRecipient(db, agentId),
  context: (conversationId) => operatorThreadContext(db, conversationId),
}

/** A whole number from the environment, or nothing. Never a silent zero. */
function numericEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return undefined

  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : Number.NaN
}

/**
 * The one secret behind both marks the Colony keeps: the ban marks that outlive
 * a sanctioned citizen, and the handle tombstones that outlive every citizen
 * (`#824`).
 *
 * **Read once, here, and handed to both.** `banSaltFromEnv` throws rather than
 * defaulting, and the whole value of that is where it happens — see its own doc
 * and the `erasure` desk below. Two calls would be two chances for a later edit
 * to give the front door and the erasing transaction different values, and the
 * failure would be silent: every handle written under one key and asked about
 * under the other, so every erased handle free again.
 */
const marksKey = banSaltFromEnv()

const app = buildApp({
  registry: databaseRegistry(db, marksKey),
  /**
   * The redemption side of the hand-over (`#459`). Its own desk rather than a
   * method on the registry: registration creates an identity and this takes one
   * over, and `adoption.ts` argues why those must not share a code path.
   */
  adoption: { redeem: (input) => redeemAdoptionCode(db, input) },
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  /**
   * One citizen's public record, by name and without a credential (`#441`).
   *
   * A closure over the one storage function rather than a store object: there
   * is exactly one read behind this route and nothing else the surface should
   * be able to reach.
   */
  /**
   * The avatar the Colony holds, resolved by handle (`#823`).
   *
   * **Two reads and not a join**, because the two questions are different: does
   * this name belong to anybody, and is there an image for it. A citizen that
   * exists with no image is the placeholder case, and a join returning no row
   * would collapse it into the 404 — which is the one distinction this route
   * must not lose.
   */
  avatars: {
    publicAvatar: async (handle) => {
      const citizen = await publicCitizenRecord(db, handle)
      if (citizen === undefined) return { outcome: 'unknown-citizen' }

      const stored = await avatarByHandle(db, handle)
      if (stored === undefined) return { outcome: 'placeholder', handle: citizen.handle }

      return { outcome: 'image', avatar: { bytes: stored.bytes, format: stored.format } }
    },
  },
  citizens: {
    publicRecord: (name) => publicCitizenRecord(db, name),
    // Whether that citizen has asked to be indexed (`#830`). A separate read on
    // purpose — `citizens.ts` says why the flag must not ride on the record.
    indexing: (name) => citizenIndexing(db, name),
    /**
     * The one swarm the Colony publishes (`kolonie-website#63`).
     *
     * **Unset is the default and answers *nothing published***, which is the
     * safe state: a portrait says which agents answer to the same person, and
     * that is not public for anybody who has not opted in by being named here.
     * Read through `liveSettings` so a maintainer can publish or withdraw one
     * without a deploy (D-104).
     */
    swarmPortrait: async () => {
      const handle = await liveSettings.read('SWARM_PORTRAIT_AGENT')
      if (handle === undefined) return undefined

      return swarmPortraitOf(db, handle)
    },
  },
  // The state facts behind the wake-up's non-rung suggestions (`#347`).
  prospects: (agentId) => openProspects(db, agentId),
  /**
   * Recording that a citizen has been told about a finding (`#842`).
   *
   * Beside `prospects` because they are the two halves of one channel: that one
   * decides whether there is anything to say, and this one is what stops the
   * Colony saying it every hour.
   */
  tell: async (diagnosisId, severity) => {
    await recordTelling(db, diagnosisId, severity, new Date())
  },
  /**
   * Remembering which provider a citizen was last invited to walk (`#1034`).
   *
   * The third half of the same channel, and the same trade as `tell`: one row
   * per citizen, replaced in place, read by nothing but the query that picks the
   * next suggestion — which uses it to skip a pair and never to prefer one.
   */
  suggested: async (agentId, walk) => {
    await recordWalkSuggestion(db, agentId, walk, new Date())
  },
  /**
   * What the console's diagnoses pages read (`#841`).
   *
   * Six reads and no writes. There is no `close` here and there is not going
   * to be one: a diagnosis resolves when its evidence stops matching, and a
   * person closing one would put an opinion into a state machine defined by
   * evidence.
   */
  diagnoses: {
    list: (query) => listDiagnoses(db, query),
    byId: (id) => diagnosisById(db, id),
    counts: () => diagnosisCounts(db),
    funnel: (since) => consultationFunnel(db, since),
    ruleHealth: () => ruleHealth(db),
    handles: (agentIds) => handlesOf(db, agentIds),
  },
  /**
   * The walkers whose prose kept crossing a red line (`#1097`).
   *
   * One read and one write, and the write only takes a suspension off. Imposing
   * one is the threshold's job, in the transaction that writes the verdict
   * reaching it — so there is no `suspend` here, and a lift runs in a
   * transaction of its own because it restores what the walker had earned:
   * `liftSuspension` writes `candidate` and then asks the ordinary promotion
   * rule whether that walker is a citizen.
   */
  walkRefusals: {
    tallies: () => walkRefusalTallies(db),
    lift: async (agentId) => {
      const parsed = AgentIdSchema.safeParse(agentId)
      if (!parsed.success) return false
      const { lifted } = await db.transaction((tx) =>
        liftSuspension(tx, { agentId: parsed.data, liftedAt: new Date().toISOString() }),
      )
      return lifted
    },
  },
  /**
   * The tickets a citizen addressed to a person (`#1347`).
   *
   * Every function behind this is scoped to `route = 'desk'` in storage, so this
   * wiring cannot widen it by forgetting a clause — and `promote` is the one
   * write that crosses the route, which is why it is its own method rather than
   * a status `answer` could take.
   *
   * The ids are parsed here rather than trusted: they arrive from a form field,
   * and an id the schema refuses is a ticket that is not on this desk, which is
   * the answer a wrong id gets anyway.
   */
  ticketDesk: {
    tickets: () => deskTickets(db),
    ticket: async (ticketId) => {
      const parsed = SupportTicketIdSchema.safeParse(ticketId)
      return parsed.success ? deskTicket(db, parsed.data) : undefined
    },
    answer: async (answer) => {
      const parsed = SupportTicketIdSchema.safeParse(answer.ticketId)
      return parsed.success ? answerDeskTicket(db, { ...answer, ticketId: parsed.data }) : undefined
    },
    promote: async (ticketId) => {
      const parsed = SupportTicketIdSchema.safeParse(ticketId)
      return parsed.success ? promoteToColony(db, parsed.data) : false
    },
    depth: () => deskDepth(db),
  },
  // A citizen's private notes against the skills it holds (`#348`).
  skillNotes: {
    holds: (agentId, skill) => holdsSkillNow(db, agentId, skill),
    write: (agentId, skill, note) => writeSkillNote(db, agentId, skill, note),
    read: (agentId, skill) => readSkillNote(db, agentId, skill),
    readMany: (agentId, skills) => readSkillNotes(db, agentId, skills),
  },
  // Who here can do this (`#1067`). One method, and the switch it reads is a
  // predicate inside `findCitizens` rather than anything this line could forget.
  citizenSearch: { find: (query) => findCitizens(db, query) },
  /**
   * Keeping another citizen's public work in view (`#1068`). Storage answers in
   * refusal names rather than in `ApiError`s, and this is the one place the two
   * meet: `followRefusals` is exhaustive over `FollowRefusal`, so a refusal added
   * there without a sentence here is a type error rather than a blank message.
   */
  following: {
    set: async (followerId, handle, following) => {
      const result = following
        ? await followCitizen(db, followerId, handle)
        : await unfollowCitizen(db, followerId, handle)

      return result.outcome === 'following'
        ? { outcome: 'following', response: result.response }
        : { outcome: 'refused', error: followRefusals[result.refusal] }
    },
    feed: (followerId, query) => followFeed(db, followerId, query),
    count: (followerId, since) => followFeedSince(db, followerId, since),
  },
  /**
   * Two citizens agreeing to be connected (`#1293`). The five acts meet their
   * storage functions here and nowhere else, and `connectionRefusals` is
   * exhaustive over `ConnectionRefusal` — a refusal added in storage without a
   * sentence beside it is a type error rather than a blank message.
   *
   * `reason` is passed through unvalidated on purpose: the trim, the emptiness
   * and the ceiling are one rule, and it lives in storage next to the CHECK
   * constraint that also holds it.
   */
  connections: {
    act: async (agentId, handle, act, reason) => {
      const result =
        act === 'request'
          ? await requestConnection(db, agentId, handle, reason ?? '')
          : act === 'accept'
            ? await acceptConnection(db, agentId, handle)
            : act === 'decline'
              ? await declineConnectionRequest(db, agentId, handle)
              : act === 'cancel'
                ? await cancelConnectionRequest(db, agentId, handle)
                : await removeConnection(db, agentId, handle)

      return result.outcome === 'connection'
        ? { outcome: 'connection', response: result.response }
        : { outcome: 'refused', error: connectionRefusals[result.refusal] }
    },
    list: (agentId) => listConnections(db, agentId),
  },
  /**
   * Citizen↔citizen private messaging (`#1286`, `#1290`). Storage refusals meet
   * their sentences here; `messageRefusals` is exhaustive over `MessageRefusal`.
   * Rate limits charge through `messagingLimits` before storage sees the body.
   */
  messaging: {
    listThreads: (agentId, options) => listConversations(db, agentId, options),
    getThread: async (agentId, conversationId) => {
      const result = await readConversation(db, agentId, conversationId)
      return result.outcome === 'read'
        ? { outcome: 'read', response: { messages: result.messages } }
        : { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    send: async (agentId, input) => {
      /**
       * Charge before storage. `requestCreate` is the handle path — first contact
       * or append to a pending request — which is what `MESSAGE_REQUEST_CREATE_LIMIT`
       * bounds. A reply by conversation id is an ordinary send.
       */
      const charged = messagingLimits.charge({
        senderId: agentId,
        recipientKey:
          input.conversationId !== undefined
            ? input.conversationId
            : input.toHandle !== undefined
              ? input.toHandle.toLowerCase()
              : undefined,
        body: input.body,
        requestCreate: input.conversationId === undefined,
      })
      if (!charged.allowed) {
        return { outcome: 'refused', error: messageRateLimited(charged.retryAfterSeconds) }
      }

      /**
       * Three destinations, one send (`#1319`). The operator one is its own
       * storage function rather than a branch inside `sendCitizenMessage`,
       * because what it does that the others do not is settle what the thread is
       * about — and provenance is written on the conversation insert or never.
       */
      const result =
        input.operator === true
          ? await openOperatorHelpConversation(db, agentId, {
              body: input.body,
              provenance: {
                taskId: input.taskId ?? null,
                wishId: input.wishId ?? null,
                accountId: input.accountId ?? null,
              },
            })
          : input.conversationId !== undefined
            ? await replyInConversation(db, agentId, input.conversationId, input.body)
            : await sendCitizenMessage(db, agentId, {
                toHandle: input.toHandle ?? '',
                body: input.body,
              })

      if (result.outcome === 'delivered') {
        /**
         * One ping per thread, after the row and never before it (`#1321`).
         *
         * `opened` is set by storage only when this send created the
         * conversation, which is what carries `operator_addresses`' rule across:
         * exactly one message per ask and never a reminder. It is awaited so a
         * test can assert on it, and it throws nothing — a mail desk that is
         * down leaves a thread the operator can still read on the page.
         */
        if (result.opened === true) {
          await notifyOperatorAboutThread(
            {
              agentId,
              agentName: (await citizenHandle(db, agentId)) ?? 'your agent',
              conversationId: result.conversationId,
            },
            operatorThreadNotify,
          )
        }

        return {
          outcome: 'delivered',
          response: {
            conversationId: result.conversationId,
            messageId: result.messageId,
          },
        }
      }
      if (result.outcome === 'requested') {
        return {
          outcome: 'requested',
          response: {
            conversationId: result.conversationId,
            requestId: result.requestId,
          },
        }
      }
      return { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    listRequests: (agentId) => listMessageRequests(db, agentId),
    acceptRequest: async (agentId, requestId) => {
      const result = await acceptMessageRequest(db, agentId, requestId)
      if (result.outcome === 'accepted') {
        return { outcome: 'accepted', response: { conversationId: result.conversationId } }
      }
      if (result.outcome === 'declined') {
        return { outcome: 'declined', response: { declined: true } }
      }
      return { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    declineRequest: async (agentId, requestId) => {
      const result = await declineMessageRequest(db, agentId, requestId)
      if (result.outcome === 'declined') {
        return { outcome: 'declined', response: { declined: true } }
      }
      if (result.outcome === 'accepted') {
        return { outcome: 'accepted', response: { conversationId: result.conversationId } }
      }
      return { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    markRead: async (agentId, conversationId, upTo) => {
      const result = await markConversationRead(db, agentId, conversationId, upTo)
      return result.outcome === 'marked'
        ? { outcome: 'marked', response: { marked: true } }
        : { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    acknowledge: async (agentId, messageId) => {
      const result = await acknowledgeSystemMessage(db, agentId, messageId)
      return result.outcome === 'acknowledged'
        ? { outcome: 'acknowledged', response: { acknowledgedAt: result.acknowledgedAt } }
        : { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    protect: async (agentId, input) => {
      if (input.act === 'block') {
        const result = await blockSender(db, agentId, input.handle)
        return result.outcome === 'blocked'
          ? { outcome: 'blocked', response: { blocked: true } }
          : { outcome: 'refused', error: messageRefusals[result.refusal] }
      }
      if (input.act === 'unblock') {
        const result = await unblockSender(db, agentId, input.handle)
        return result.outcome === 'unblocked'
          ? { outcome: 'unblocked', response: { unblocked: true } }
          : { outcome: 'refused', error: messageRefusals[result.refusal] }
      }
      const result = await reportMessageAbuse(db, agentId, {
        handle: input.handle,
        reason: input.reason,
        messageId: input.messageId,
        conversationId: input.conversationId,
      })
      return result.outcome === 'reported'
        ? { outcome: 'reported', response: { reported: true, reportId: result.reportId } }
        : { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
  },
  /**
   * The operator's own direction (`#1288`). The same store, reached by
   * `human_id` rather than `agent_id` — see `messaging.ts` for why it is a
   * second port and not two more methods on the citizen's.
   */
  operatorMessaging: {
    listThreads: (humanId, agentId) => listOperatorConversations(db, humanId, agentId),
    getThread: async (humanId, conversationId) => {
      const result = await readOperatorConversation(db, humanId, conversationId)
      return result.outcome === 'read'
        ? { outcome: 'read', response: { messages: result.messages } }
        : { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
    send: async (humanId, agentId, input) => {
      const result = await sendOperatorMessage(
        db,
        humanId,
        agentId,
        input.body ?? null,
        undefined,
        input.answerKind,
        input.conversationId,
      )
      if (result.outcome === 'delivered') {
        return {
          outcome: 'delivered',
          response: { conversationId: result.conversationId, messageId: result.messageId },
        }
      }
      /**
       * `requested` is unreachable on this path and is not collapsed into
       * `delivered` for it: the operator send opens the conversation with both
       * parties in it, so there is no gate to be waiting on. The branch is here
       * because the shared `SendResponse` carries it, and a cast would be a
       * promise about storage this file cannot keep.
       */
      if (result.outcome === 'requested') {
        return {
          outcome: 'requested',
          response: { conversationId: result.conversationId, requestId: result.requestId },
        }
      }
      return { outcome: 'refused', error: messageRefusals[result.refusal] }
    },
  },
  /**
   * What a citizen does next, and what stands between it and doing so (`#1174`).
   *
   * `held` is `listAccounts` unnarrowed rather than a query per required kind:
   * a playbook naming four slots would otherwise be four round trips, and the
   * predicates that decide whether an account answers a slot — in use, matchable,
   * proved where the slot asks for it — live in `matchPlaybook` where they are
   * asserted, not spread across a `where` clause here.
   */
  playbooks: {
    catalogue: {
      byStatus: (query) => playbooksByStatus(db, query),
      bySlug: (slug) => playbookBySlug(db, slug),
      byId: (id) => playbookById(db, id),
    },
    held: (agentId) => listAccounts(db, agentId),
    runs: {
      record: (input) => recordPlaybookRun(db, input),
      mine: (agentId, playbookId) => playbookRunFor(db, agentId, playbookId),
      activity: (playbookId) => playbookRunActivity(db, playbookId),
      signals: (playbookId) => playbookSignalsTally(db, playbookId),
      counts: (playbookIds) => playbookRunCounts(db, playbookIds),
      notes: (query) => listPlaybookPublishedNotes(db, query),
      /**
       * The run journal (`#1422`). Three methods rather than one, because the
       * three readerships are different: everybody reads the published entries,
       * an author reads its own including what was refused, and only an author
       * writes.
       */
      journal: async (playbookId, limit) =>
        (await publishedPlaybookJournal(db, playbookId, limit)).map((one) => ({
          entryId: one.id,
          entry: one.published ?? '',
          by: null,
          writtenAt: one.writtenAt,
          playbookRevision: one.playbookRevision,
        })),
      ownJournal: (agentId, playbookId) => ownPlaybookJournal(db, agentId, playbookId),
      writeJournal: (input) =>
        writePlaybookJournalEntry(db, {
          playbookId: input.playbookId,
          agentId: input.agentId,
          entry: input.entry,
        }),
    },
    /**
     * Authoring (`#1179`), a port of its own rather than a fourth catalogue
     * method: reading the catalogue and publishing into it are different blast
     * radii, and the read port says so in its own doc.
     */
    authoring: {
      draft: (input) => draftPlaybook(db, input),
      update: (command) => updatePlaybookDraft(db, command),
      submit: (command) => submitPlaybookForReview(db, command),
      fork: (command) => forkPlaybook(db, command),
    },
    proposals: {
      propose: (input) => insertPlaybookStepProposal(db, input),
      countOpen: (playbookId) => countOpenPlaybookStepProposals(db, playbookId),
    },
    revisions: {
      contributors: (playbookId) => playbookContributors(db, playbookId),
      history: async (playbookId) => {
        const rows = await playbookRevisionHistory(db, playbookId)
        return rows.map((row) => ({
          revision: row.revision.revision,
          cutAt: row.revision.cutAt,
          proposalIds: row.revision.proposalIds,
          changes: row.changes,
          contributors: row.contributors,
        }))
      },
    },
    briefing: {
      split: (playbookId) => readPlaybookBriefingSplit(db, playbookId),
      summary: (playbookId) => readPlaybookBriefingSummary(db, playbookId),
    },
    /**
     * A citizen's private note on a playbook (`#1248`). Its own port rather than
     * a method on `runs`, for the same reason skill notes are not a method on
     * the skills store: a note is prose a citizen wrote to itself, and nothing
     * that reads the corpus — briefing, reports, synthesis — is given a handle
     * to it.
     */
    notes: {
      read: (agentId, playbookId, slug) => readPlaybookNote(db, agentId, playbookId, slug),
      write: (agentId, playbookId, slug, note) =>
        writePlaybookNote(db, agentId, playbookId, slug, note),
    },
  },
  quests: databaseQuests(
    db,
    questAuditPolicy(),
    payoutWalletAddress,
    liveSettings,
    /**
     * The chain, so a quest's funding is checked before it is moderated (D-115,
     * `#751`). Guarded exactly as the payout runner's is below: no endpoint
     * means the desk answers `unknown` and every submission that was accepted
     * before is still accepted.
     *
     * **This reads a balance and nothing else.** No wallet secret is passed and
     * none is needed — the sponsor's address is public and so is what it holds.
     */
    process.env[PAYMENT_RPC_URL_VAR]?.trim()
      ? httpPayoutChain(process.env[PAYMENT_RPC_URL_VAR].trim())
      : undefined,
  ),
  // The citizen's side of the payout table, present whether or not this
  // deployment can pay (`#535`).
  earnings: databaseEarnings(db),
  settings: databaseSettings(db),
  providerEnquiries: databaseProviderEnquiries(db),
  /**
   * The way in after D-106 (`#503`).
   *
   * **The wallet is checked here, at startup, and that placement is the check
   * rather than a detail of it.** `PAYOUT_WALLET_SECRET` is a raw 32-byte seed
   * and every SDK's `fromSecretKey` expects a 64-byte array; handing one to the
   * other does not throw, it derives a different address. The first symptom of
   * that would be a transfer signed by an account holding nothing, discovered by
   * a citizen who was not paid.
   *
   * **Absent is a deployment that cannot take money, and is allowed.** No
   * wallet means no routes, which is the state every test and every non-production
   * environment is in. What is refused is a wallet whose two halves disagree.
   */
  ...(payoutWalletAddress === undefined
    ? {}
    : {
        payments: {
          desk: databasePayments(db, payoutWalletAddress),
          ...(process.env[PAYMENT_RPC_URL_VAR]?.trim()
            ? { watcher: httpPaymentWatcher(process.env[PAYMENT_RPC_URL_VAR].trim()) }
            : {}),
          /**
           * **`PAYMENT_WEBHOOK_SECRET`, named for the route it guards**
           * (`kolonie-infra#95`). It was `DEPOSIT_WEBHOOK_SECRET`, written for
           * `POST /v1/deposits/webhook` — a route that went with the deposit
           * module (`#506`) while the secret stayed to guard the payment ones.
           *
           * The old name was read as a fallback for one release, so a container
           * starting between the deploy and the host's `.env` edit would still
           * mount the payment routes. The host carries the new name and the
           * fallback is gone; a deployment that still has only the old one
           * mounts nothing and says so at startup, which is the honest failure.
           */
          ...(process.env['PAYMENT_WEBHOOK_SECRET'] !== undefined && {
            webhookSecret: process.env['PAYMENT_WEBHOOK_SECRET'],
          }),
        },
      }),
  /**
   * Paying citizens, one accepted report at a time (`#505`).
   *
   * Present only where the Colony can actually pay: a wallet, an endpoint and
   * both ceilings. **The ceilings are read at startup and the process refuses to
   * run with either unset** — a ceiling that defaults to infinity is not a
   * ceiling, and payouts are automatic, immediate and otherwise unbounded.
   */
  ...(payoutWalletAddress === undefined || payoutCeilings === undefined
    ? {}
    : {
        payouts: {
          desk: databasePayouts(db),
          wallet: {
            address: payoutWalletAddress,
            secret: process.env[PAYOUT_WALLET_SECRET_VAR]?.trim() ?? '',
          },
          ceilings: payoutCeilings,
          ...(process.env[PAYMENT_RPC_URL_VAR]?.trim()
            ? { chain: httpPayoutChain(process.env[PAYMENT_RPC_URL_VAR].trim()) }
            : {}),
        },
      }),
  /**
   * Moving the earned fee out of the hot wallet (`#507`).
   *
   * **Present on exactly the deployments that can pay**, because it sweeps from
   * the same wallet — and additionally needs somewhere to sweep *to*. The
   * Treasury address is read here and no key for it is read anywhere: the
   * Colony sends to that address and cannot send from it, which is the property
   * `treasury.test.ts` asserts on the module's exports.
   */
  ...(payoutWalletAddress === undefined || treasuryAddress === undefined
    ? {}
    : {
        treasury: {
          desk: databaseTreasury(db),
          wallet: {
            address: payoutWalletAddress,
            secret: process.env[PAYOUT_WALLET_SECRET_VAR]?.trim() ?? '',
          },
          treasuryAddress,
          intervalMs: async () => {
            const value = await settingValue(db, 'TREASURY_SWEEP_INTERVAL_MS')
            const parsed = value === undefined ? Number.NaN : Number(value)
            return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
          },
          ...(process.env[PAYMENT_RPC_URL_VAR]?.trim()
            ? { chain: httpPayoutChain(process.env[PAYMENT_RPC_URL_VAR].trim()) }
            : {}),
        },
      }),
  submissions: databaseSubmissions(db),
  guidance: databaseGuidance(db),
  // The limiter is created inside `support()` rather than passed, so the process
  // gets one window per agent and a caller cannot forget to supply one.
  support: supportSurface,
  /**
   * The channel for an agent that never got a key (`#1009`).
   *
   * Built inline rather than into a named constant, unlike `supportSurface`
   * beside it: that one is a constant because two surfaces must share its
   * ceiling, and this one is handed to `buildApp` once and forwarded from there
   * to both of its doors — so there is one object and one allowance already.
   */
  arrivals: arrivalReports({ desk: databaseArrivalDesk(db) }),
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
   * **Its own limiter, built here and shared with nothing.** This ceiling
   * protects the citizen: handing it the support surface's allowance would let
   * an operator spend its citizen's ability to ask for help by talking to it.
   */
  operatorNotes: {
    store: databaseOperatorNoteStore(db),
    limiter: operatorNoteLimiter(),
    /**
     * The wake channel on the second of its three operator events (`#580`).
     *
     * The same sender the thread path takes, deliberately: the ceiling is per
     * agent across every event together, and two senders would be two ceilings.
     */
    wake: liveWake,
  },
  /**
   * The operator's side of the channel, on the durable page (`#1325`).
   *
   * **No notifier and no allowance here.** Both belong to the *asking* half,
   * which is `kolonie.messages.send` and is wired on `messaging` above: this
   * dependency is read and answered by a person who is already looking at the
   * page, so there is nobody to notify and no citizen budget to charge.
   */
  operatorThreads: {
    store: {
      forPageToken: (token) => operatorThreadsForPageToken(db, token),
      wishesWaiting: (agentId) => wishThreadsWaitingOn(db, agentId),
      answerOnPage: (input) => answerOperatorThreadFromPage(db, input),
    },
    /**
     * The wake channel, on the one path it was built for (`#518`).
     *
     * The operator's answer is the event: a person replies in one minute, and
     * without this the agent reads it at its next rhythm hours later.
     */
    wake: liveWake,
  },
  /**
   * **`banSaltFromEnv()` is called at startup, and that placement is the check
   * rather than a detail of it (#90).** It is read into `marksKey` above, a few
   * lines earlier in the same module and for the same reason.
   *
   * A missing salt breaks nothing at runtime: every write succeeds and the ban
   * marks are simply unsalted digests of a mailbox address, recoverable with a
   * wordlist by anybody holding the table. Nothing in any response would say so.
   * Reading it inside the transaction would move that failure to the first
   * erasure of a banned agent — a rare event nobody is watching. Reading it here
   * means the process refuses to boot, in front of an operator watching a deploy.
   */
  erasure: erasure({ desk: databaseErasureDesk(db, marksKey) }),
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
  /**
   * The contribution-quality ledger (`#1262`).
   *
   * Always wired: the verdict table the sanction chain writes is the whole of
   * what it reads, and a Colony that judges contributions always has it. Unlike
   * the Doctor it needs no rollup.
   */
  contributionQuality: databaseContributionQuality(db),
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
            log,
          }),
        }
      : {}),
  }),
  // The one line a citizen did not ask for (`#231`). Its own seam beside the
  // digest above, and deliberately not part of it: the digest is what a
  // returning citizen asks for, and this is what the Colony says to a citizen
  // that never asks.
  hints: databaseStandingHints(db, skillReleases),
  /**
   * What each citizen actually called, per route and per hour (`#835`).
   *
   * **Wired here and nowhere else, and the outcome is dropped rather than
   * inspected** — for the reason `recordOrigin` gives one seam over: there is
   * nothing this could usefully do with it, and the write cannot fail the
   * citizen's request either way.
   */
  rollup: {
    record: async (agentId, call) => {
      await recordCall(db, agentId, call)
    },
  },
  /**
   * And whether a live limit covers the call about to be served (`#843`).
   *
   * **The third step of the card's ordering, and the only one that takes
   * something away**: understand (`#835`), inform (`#837`, `#842`), then limit.
   * Which is why the writer is somewhere else entirely — the doctor runner
   * decides who is narrowed, under `DOCTOR_THROTTLING`, and this reads whatever
   * rows that produced. A deployment running the pass observing has none, so this
   * refuses nobody without a flag of its own.
   *
   * **Two reads at most and usually one.** `checkThrottle` probes an index first
   * and only counts the citizen's calls for the hour when a row actually covers
   * the route — so the cost on the overwhelming majority of calls, which are
   * covered by nothing, is one indexed miss.
   */
  throttles: {
    refusalFor: async (agentId, routeKey, now) => {
      const checked = await checkThrottle(db, agentId, routeKey, now)
      return checked.outcome === 'refused' ? throttleRefusal(checked.throttle, now) : undefined
    },
  },
  /**
   * What `kolonie.doctor` and `GET /v1/doctor` read (`#837`).
   *
   * **Three reads and two writes, and both writes are about the Doctor rather
   * than about the citizen** (`#1081`, `#1082`). Nothing here decides anything
   * about a citizen: the card's ordering is *understand, inform, then limit*,
   * and this is still the inform — neither write limits anything, and no rule
   * reads either of them back at the citizen it is about.
   */
  doctor: {
    callHoursSince: (agentId, since) => callHoursSince(db, agentId, since),
    progressOf: (agentId) => academyProgressFor(db, agentId),
    /**
     * **Empty, and that is a true answer rather than a missing one.** The Colony
     * has superseded no route today. When it does, this is the one place that
     * fact enters the Doctor — and it belongs here rather than in
     * `packages/core` because *which route is old* is a property of the
     * deployment and the rules are arithmetic.
     */
    deprecatedRoutes: async () => ({}),
    /**
     * The sentences the runner wrote, where there are any (`#840`).
     *
     * A read and nothing more: this surface never asks a model for one, which is
     * what keeps it cheap enough to call on every waking and independent of a
     * third party being up.
     */
    proseFor: (agentId) => proseForOpenDiagnoses(db, agentId),
    /**
     * That the citizen looked, on every finding it had been told about
     * (`#1081`).
     *
     * The one write, and it is bounded by the same conditions the storage
     * function carries: announced, open, agent-scoped, and not already stamped.
     * A citizen with nothing announced calls this and nothing at all is written.
     */
    noteConsultation: async (agentId, at) => {
      await markConsulted(db, agentId, at)
    },
    /**
     * What the citizen made of a rule that fired on it (`#1082`).
     *
     * The write with a reader on the other end: `noteConsultation` above is the
     * Colony measuring itself, and this is the citizen answering. Passed
     * straight through — the diagnosis this attaches to is resolved inside
     * `recordDoctorFeedback`, because the citizen names a kind and the surface
     * that gave it that kind never had an id to hand it.
     */
    recordFeedback: (input) => recordDoctorFeedback(db, input, new Date()),
  },
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
    /**
     * The rung's question, put through the citizen's own operator thread
     * (`#1325`).
     *
     * **The same path `kolonie.messages.send` takes**, notify included, so the
     * operator is pinged once and a reply in the chat lands in the thread it
     * answers. It was a second wiring of the exchange module until the retire —
     * the one a grep for `mailer.send` did not find, because it sent nothing
     * itself.
     *
     * **Provenance is the rung's own task**, which is what makes the answer
     * findable: `operatorAnsweredAboutTask` looks for a message in the thread
     * about this task, and nothing else would match it.
     */
    askOperator: async ({ agentId, agentName, taskId, body }) => {
      const opened = await openOperatorHelpConversation(db, agentId, {
        body,
        provenance: { taskId },
      })

      if (opened.outcome !== 'delivered') {
        /**
         * `requested` cannot happen on this path — a first-contact request is
         * the citizen↔citizen gate and an operator thread never goes through it
         * — so it is folded into the general sentence rather than given words
         * that would claim to know why.
         */
        return {
          asked: false,
          reason: askRefusal(opened.outcome === 'refused' ? opened.refusal : 'unexpected'),
        }
      }

      if (opened.opened === true) {
        await notifyOperatorAboutThread(
          { agentId, agentName, conversationId: opened.conversationId },
          operatorThreadNotify,
        )
      }

      return { asked: true }
    },
    obstruction,
  },
  /**
   * The wake rung's mint (`#518`).
   *
   * **No operator channel and no credential.** The rung asks nobody for
   * permission — a citizen standing a handler up on its own machine changes
   * nothing for anybody else, which is exactly where it differs from the rung
   * above it.
   */
  wake: { challenges: databaseWakeChallenges(db), obstruction },
  // The plan an agent and its operator keep together (`#527`). No credential,
  // no channel: it is a table and a refusal.
  // The third operator event (`#580`): a mark on the shared list is a thing a
  // person said, and it reaches the agent through the same sender as the other two.
  wishes: { store: databaseWishes(db), wake: liveWake },
  /**
   * Walks, recorded as they happen (`#601`). A walk writes the recipe: an agent
   * obtaining an account produces a draft entry as a by-product, and a steward
   * publishes it.
   */
  walks: databaseWalks(db),
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
  /**
   * The vault (`#98`), and since `#1439` the one entry a citizen may hand to a
   * person.
   *
   * **The reads and writes still need no credential of the Colony's**: an entry
   * is sealed with the caller's own key, which arrives in the request that uses
   * it, and there is no master key to leak. What the sealing key below buys is
   * the *share* alone — a copy the Colony carries for as long as the citizen
   * says, because a person has no key of their own. Absent it, sharing is not
   * offered and everything else works exactly as before.
   */
  vault: {
    vault: databaseVault(
      db,
      usableSealingKey(process.env[OPERATOR_DROP_SEALING_KEY_VAR])
        ? process.env[OPERATOR_DROP_SEALING_KEY_VAR]
        : undefined,
    ),
  },
  /**
   * The conversation about an account (`#930`).
   *
   * **Constructed whether or not the sealing key is there**, unlike the two
   * channels below. Almost all of this surface carries no secret at all — an
   * episode, its turn, its notes, its outcome — and a Colony that lost the whole
   * conversation because it could not carry a password would be one where the
   * agent cannot even say what it is stuck on. The store knows whether it can
   * seal, and refuses the one operation that needs it.
   */
  accountThreads: databaseAccountThreads(
    db,
    usableSealingKey(process.env[OPERATOR_DROP_SEALING_KEY_VAR])
      ? process.env[OPERATOR_DROP_SEALING_KEY_VAR]
      : undefined,
  ),
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
  /**
   * The other direction (`#592`), on the same key and the same condition.
   *
   * **One sealing key for both channels and not two.** A second variable would
   * be a second thing to set, a second thing to rotate and a second way for a
   * deployment to have half a credential path — and the two are the same
   * operation over the same envelope format. What differs between them is who
   * may read, which is code rather than configuration.
   */
  handovers: usableSealingKey(process.env[OPERATOR_DROP_SEALING_KEY_VAR])
    ? databaseHandovers(db, process.env[OPERATOR_DROP_SEALING_KEY_VAR] as string)
    : undefined,
  /**
   * Citizen to citizen (`#1125`), on the same key again.
   *
   * **Constructed unconditionally**, which is where it parts company with the
   * two above. The key travels into the store as `string | undefined` and the
   * give refuses when it is absent — so the tools stay registered and a citizen
   * on a keyless Colony reads a sentence saying the credential cannot be carried
   * here, rather than finding no tool and concluding the Colony has no such act.
   */
  accountOffers: {
    offers: databaseAccountOffers(
      db,
      usableSealingKey(process.env[OPERATOR_DROP_SEALING_KEY_VAR])
        ? process.env[OPERATOR_DROP_SEALING_KEY_VAR]
        : undefined,
    ),
  },
  // Same origin the operator's other links use. AGENTS.md §3 keeps host names
  // out of this repository.
  dropBaseUrl: process.env['CONSOLE_URL'] ?? '',
  /*
   * The third operator channel (`#736`) was constructed here: the desk behind a
   * live browser tab, and the mail that told the person on the other end. Both
   * are gone (`#912`). The notifier in particular is *not constructed* rather
   * than merely uncalled — a mailer this process still built is a mailer one
   * forgotten call site could still send from.
   */
  /**
   * The operator's desk on Telegram (`#793`).
   *
   * **All three or none, and none is what runs today.** A token with no webhook
   * secret would mount a public route with nothing guarding it; a secret with no
   * token would offer a person a link into a bot that cannot answer. Neither is a
   * state worth having a code path for, so the desk is constructed only when the
   * three agree and is otherwise absent — no deep link on any surface, no route,
   * and the operator is reached by mail exactly as before.
   *
   * The username is configuration rather than a constant because every deep link
   * ever issued is built from it, and a rename that reached only the bot would
   * break the ones already sitting in people's chat histories.
   */
  telegram: operatorTelegram,
  // The account register (#150): what a citizen holds, beside what it can do.
  // No configuration of its own — it is a read and a few writes over the
  // citizen's own rows.
  /** The provider catalogue (`#521`). Its own object because it names no citizen. */
  recipes: databaseProviderRecipes(db),
  /** Where a provider used to be, for the Atlas's redirects (`#546`). */
  renames: databaseAtlasRenames(db),
  atlasQuests: databaseAtlasQuests(db),
  atlasPlaybooks: databaseAtlasPlaybooks(db),
  /**
   * The website's own base, which is the host the Atlas serves on (`#546`).
   *
   * A host name in the environment and never in this repository, per AGENTS.md
   * §3 — and unset means the Atlas does not serve rather than serving on the
   * API's own five hostnames.
   */
  websiteUrl: process.env['WEBSITE_URL'] ?? '',
  /** What the Colony will confirm about one agent, to anybody (`#519`). */
  attestations: databaseAttestations(db),
  accounts: {
    register: databaseAccounts(db),
    resolution: databaseAccountResolution(db),
    /**
     * The generic proofs (`#520`). The challenge domain is the same configured
     * host the mailbox rung mints under — a mail proof's forwarding address lives
     * beside a badge's, because it is the same door.
     */
    proofs: {
      proofs: databaseAccountProofs(db, liveSettings),
      challengeDomain: process.env['EMAIL_CHALLENGE_DOMAIN'] ?? '',
    },
    /**
     * Which accounts have an operator thread open about them (`#1441`).
     *
     * One query per account rather than one join across the list, because the
     * list is bounded by what a citizen holds — tens, not thousands — and the
     * alternative is a second reader of `message_conversations` that would have
     * to re-state the participant rule this one already enforces.
     */
    threads: {
      openAbout: async (agentId, accountIds) => {
        const open: Record<string, string> = {}
        for (const accountId of accountIds) {
          const thread = await conversationAboutAccount(db, agentId, accountId)
          if (thread !== undefined) open[accountId] = String(thread)
        }
        return open
      },
    },
  },
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
    // The operator-facing mailer, present on the same three variables the
    // mailbox rung needs. Absent, sign-in answers rather than minting a link
    // nobody could receive.
    //
    // It arrives with the console's sender already bound (`#474`), which is why
    // there is no second field here: the address was a thing each send had to
    // remember, and the one that forgot mailed a deleted account from the
    // Academy's challenge host.
    ...(mail.operatorMailer === undefined ? {} : { mailer: mail.operatorMailer }),
    // Configuration, not a constant: AGENTS.md §3 keeps host names out of this
    // repository, so where a followed link lands arrives in the environment.
    consoleUrl: process.env['CONSOLE_URL'] ?? '',
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
    // The mail this module sends is the one a stranger receives unprompted, so
    // it is the surface that most needed the console's address and the one that
    // silently kept the Academy's until `#474`.
    ...(mail.operatorMailer === undefined ? {} : { mailer: mail.operatorMailer }),
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
    /**
     * A forwarded provider message arrives at the same door as a badge's mail
     * (`#520`), so the inbound handler is handed both readers and tries the
     * challenges first. One route, one token space, two tables.
     */
    accountProofs: databaseAccountProofs(db, liveSettings),
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
    // Read for telling, not for refusing — the refusal is inside the guarded
    // sender, where every other reason to decline already is (`#617`).
    ...(smsGeography === undefined ? {} : { geography: smsGeography }),
    /**
     * **One number, one variable** (`#480`).
     *
     * This read `SMS_COLONY_NUMBER`, which was a second name for the number
     * already in `TWILIO_FROM_NUMBER` — and the second name was never wired.
     * It is absent from `kolonie-infra`'s `docker-compose.yml` and from its
     * `.env.example`, so it was empty in production from the day the rung
     * shipped, `smsUnavailable` refused every call, and `sms-receive` could not
     * be started by anybody. A citizen found it by trying (`#480`); nothing on
     * our side had.
     *
     * That is D-002's *one record, or none* meeting the ground. The Colony has
     * exactly one Twilio number: it sends the code from it and citizens text
     * back to it, and the `sms-send` verifier polls Twilio for messages
     * addressed `To` that same number. Two variables could only ever agree or
     * break, and they broke — silently, because an unset variable defaults to
     * empty and empty is indistinguishable from *not configured yet*.
     *
     * Configuration rather than a constant, on `AGENTS.md` §3's reasoning about
     * identifiers of this deployment: it is public by design and it still
     * changes without a release. That argument was always about
     * `TWILIO_FROM_NUMBER`; the second variable added nothing to it.
     *
     * **If the Colony ever needs to receive on a number it does not send from**,
     * that is a change with a reason and a second variable is how to make it.
     * It is not what this was.
     */
    colonyNumber: process.env['TWILIO_FROM_NUMBER'] ?? '',
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

/**
 * Give the maintainer their role, on the first start after the host names them
 * (`#485`).
 *
 * **Before `listen`, and never fatal.** It runs before the port opens so that a
 * maintainer who restarts the process to pick up the variable does not have to
 * wonder whether the grant landed before or after the first request. And a
 * failure here is logged and stepped over: this grants a person a dashboard, and
 * a process that refuses to serve the Colony because a dashboard role could not
 * be written would be trading the whole platform for one page.
 *
 * `not-configured` is the ordinary answer for every deployment that has no
 * maintainer to bootstrap, and it is `debug`-shaped rather than a warning —
 * see {@link bootstrapMaintainer} for why the variable must never be declared
 * required.
 */
try {
  const outcome = await bootstrapMaintainer(db, process.env[BOOTSTRAP_MAINTAINER_SUBJECT_VAR])
  if (outcome.outcome === 'granted') {
    log.info('granted the maintainer role from the host configuration', {
      event: 'maintainer.bootstrapped',
      // The person's id and never the subject: an Auth0 `sub` names an account
      // at a provider, and a log line is not the place to publish one.
      humanId: outcome.humanId,
    })
  } else if (outcome.outcome === 'no-such-identity') {
    log.warn(`${BOOTSTRAP_MAINTAINER_SUBJECT_VAR} names no identity that has signed in yet`, {
      event: 'maintainer.bootstrap.pending',
    })
  } else if (outcome.outcome === 'ambiguous-subject') {
    // Loud, because nothing was granted and nobody would otherwise find out.
    // A stored subject is not always provider-prefixed, so a bare numeric id
    // can name two identities — and granting to either would be handing one
    // person authority over the other's Colony.
    log.error(
      `${BOOTSTRAP_MAINTAINER_SUBJECT_VAR} names more than one identity — nobody was granted the maintainer role`,
      undefined,
      { event: 'maintainer.bootstrap.ambiguous' },
    )
  }
} catch (error) {
  log.error('the maintainer bootstrap failed', error, { event: 'maintainer.bootstrap.failed' })
}

/**
 * Start reading what arrives at the Colony's number (`#690`).
 *
 * **In this process and not in a runner**, which follows from where the vendor
 * is: these credentials are named in this file and nowhere else, and the
 * verifier runner says three times over that it talks to no vendor and only ever
 * reads the row a proof was recorded in. The mail path is the precedent — the
 * process that holds the mailer is the process inbound mail reaches — and this is
 * the same arrangement with the vendor pulled rather than pushing.
 *
 * Silent when Twilio is not configured, which is the same degradation the sender
 * above has: a deployment with no account offers the phone rungs to nobody, and
 * a poll against credentials that do not exist would log an error a minute
 * forever for a rung nobody can attempt.
 */
if (smsVendor !== undefined) {
  startInboundSmsPolling({
    adapter: smsVendor,
    challenges: databaseSmsChallenges(db),
    log,
  })
  log.info('reading inbound SMS', {
    event: 'sms.inbound.started',
    intervalMs: INBOUND_SMS_POLL_INTERVAL_MS,
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
 * The Colony's own wallet address, if this deployment has one — D-106 (`#503`).
 *
 * **Three outcomes, and the middle one is the whole reason this function
 * exists.** No address and no secret is a deployment that cannot take money and
 * says so by mounting no routes. An address whose secret derives it is a wallet.
 * An address whose secret derives *something else* is a process that would sign
 * every transfer with a keypair the Colony has never funded — so it throws, and
 * `server.ts` exits where an operator is looking.
 *
 * **The secret is never printed, never logged and never returned.** What comes
 * back is the public address, which is public by definition; the message on the
 * failure path names the variables and describes the shape, and contains neither
 * value. A key that has been in a log is a key that has to be rotated.
 *
 * A secret without an address, or an address without a secret, is refused rather
 * than degraded: both are half-configured, and the half that is present is
 * evidence somebody meant to configure it.
 */
function colonyWallet(): string | undefined {
  const address = process.env[PAYOUT_WALLET_ADDRESS_VAR]?.trim() ?? ''
  const secret = process.env[PAYOUT_WALLET_SECRET_VAR]?.trim() ?? ''

  if (address === '' && secret === '') return undefined

  if (address === '' || secret === '') {
    throw new Error(
      `${PAYOUT_WALLET_ADDRESS_VAR} and ${PAYOUT_WALLET_SECRET_VAR} are set one without the ` +
        'other. A wallet is both halves, and half of one is a deployment that will fail at the ' +
        'first payment rather than here.',
    )
  }

  const mismatch = payoutWalletMismatch(address, solanaAddressFromSeed(secret))
  if (mismatch !== undefined) throw new Error(mismatch)

  return address
}
