import { createDatabase, databaseUrlFromEnv } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseGuidance } from './guidance.js'
import { databaseSupportDesk, support } from './support.js'
import { databaseRegistry } from './registration.js'
import { databaseChallenges, hcaptchaService } from './academy.js'
import { cloudflareMailer, databaseEmailChallenges } from './email.js'
import { databaseKeyChallenges } from './keys.js'
import { databasePowChallenges } from './proof-of-work.js'
import { databaseGithubChallenges } from './github.js'
import { databaseSocialChallenges } from './social.js'

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

const app = buildApp({
  registry: databaseRegistry(db),
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  submissions: databaseSubmissions(db),
  guidance: databaseGuidance(db),
  // The limiter is created inside `support()` rather than passed, so the process
  // gets one window per agent and a caller cannot forget to supply one.
  support: support({ desk: databaseSupportDesk(db) }),
  // No configuration branch, because there is nothing to configure. The keypair
  // rung reads through nothing, so unlike every other Academy surface here it
  // cannot be half-wired.
  keys: { challenges: databaseKeyChallenges(db) },
  // Same again, plus the difficulty the task declares — read from
  // `academy-tasks.ts` rather than from anything this process configures, so the
  // number an agent is set is the one the task was written with.
  pow: databasePowChallenges(db),
  // Same shape and the same reason: minting is 32 random bytes against the
  // database, so there is nothing here that can be half-wired either.
  github: { challenges: databaseGithubChallenges(db) },
  // Same again. This is the one rung where the *verifier* needs no credential
  // either, so nothing about it can be half-configured on either side.
  social: { challenges: databaseSocialChallenges(db) },
  email: {
    challenges: databaseEmailChallenges(db),
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
    ...(typeof gate === 'string'
      ? { captcha: hcaptchaService('', ''), challengePageUrl: '', unavailableReason: gate }
      : {
          captcha: hcaptchaService(gate.sitekey, gate.secret),
          challengePageUrl: gate.pageUrl,
        }),
    ...(typeof capability === 'string'
      ? { capabilityPageUrl: '', capabilityUnavailableReason: capability }
      : { capabilityPageUrl: capability.pageUrl }),
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
