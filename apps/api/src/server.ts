import { buildApp } from './app.js'

const PORT = Number(process.env['PORT'] ?? 3000)

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from
// Traefik on the shared Docker network.
const HOST = '0.0.0.0'

const app = buildApp()

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`kolonie-api listening on ${HOST}:${PORT}`)
} catch (error) {
  console.error('kolonie-api failed to start', error)
  process.exit(1)
}
