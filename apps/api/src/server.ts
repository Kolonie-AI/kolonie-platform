import { createDatabase, databaseUrlFromEnv } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseRegistry } from './registration.js'
import { databaseChallenges, hcaptchaService } from './academy.js'

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
 * Required, and it fails here rather than at the first agent that asks for a
 * challenge — the same argument `DATABASE_URL` makes above. A gate that mints
 * URLs pointing at nowhere is worse than one that refuses to start.
 *
 * The host lives here, in configuration, because `AGENTS.md` §3 forbids one in
 * any file of this repository.
 */
const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. The API cannot serve the Academy gate without it.`)
  }
  return value
}

const app = buildApp({
  registry: databaseRegistry(db),
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  submissions: databaseSubmissions(db),
  academy: {
    challenges: databaseChallenges(db),
    captcha: hcaptchaService(required('HCAPTCHA_SITEKEY'), required('HCAPTCHA_SECRET')),
    challengePageUrl: required('CHALLENGE_PAGE_URL'),
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
