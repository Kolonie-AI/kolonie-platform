import { createDatabase, databaseUrlFromEnv } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { databaseStore } from './authentication.js'
import { databaseCatalogue } from './tasks.js'
import { databaseSubmissions } from './submissions.js'
import { databaseRegistry } from './registration.js'

const PORT = Number(process.env['PORT'] ?? 3000)

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from
// Traefik on the shared Docker network.
const HOST = '0.0.0.0'

// Throws with an explanation if DATABASE_URL is missing (D-009). Failing here is
// the point: a process that cannot reach its database has not degraded, and
// discovering that on the first agent's registration is worse than discovering
// it before the container is ever declared healthy.
const db = createDatabase(databaseUrlFromEnv())

const app = buildApp({
  registry: databaseRegistry(db),
  store: databaseStore(db),
  catalogue: databaseCatalogue(db),
  submissions: databaseSubmissions(db),
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
