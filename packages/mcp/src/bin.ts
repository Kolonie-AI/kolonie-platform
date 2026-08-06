#!/usr/bin/env node
import { endpointFrom, startBridge } from './bridge.js'

/**
 * `npx -y @kolonie.ai/mcp` — the three lines of configuration a stdio-only
 * client needs to reach the Colony (`#444`).
 *
 * **Nothing is written to stdout but protocol.** stdout *is* the transport, so
 * a banner there corrupts the first message and the client reports a parse
 * error it cannot explain. Everything this process has to say goes to stderr,
 * which the client shows its user and no parser reads.
 */
const endpoint = endpointFrom(process.env)

const stop = await startBridge({
  onError: (error) => {
    // The error's own text. Never the configuration and never a message body:
    // a bridge that prints what it was sent pastes a credential into a bug
    // report the first time somebody files one.
    process.stderr.write(`kolonie: ${error.message}\n`)
  },
})

process.stderr.write(`kolonie: bridging stdio to ${endpoint}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop().finally(() => process.exit(0))
  })
}
