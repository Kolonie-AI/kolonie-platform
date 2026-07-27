import { VERIFIERS } from '@kolonie-ai/verifiers'

/**
 * Entry point of the verifier runner.
 *
 * The polling loop is not wired up yet: there is no database schema to poll.
 * Rather than pretend, this process reports what it can do and then idles, so
 * the container is deployable and its restart behaviour is observable before
 * the first migration exists.
 *
 * Next: replace the idle wait with `SELECT … FROM submissions WHERE status =
 * 'pending' FOR UPDATE SKIP LOCKED`, join the task for its type, and call
 * `verifySubmission`.
 */
const POLL_INTERVAL_MS = 30_000

function main(): void {
  const taskTypes = [...VERIFIERS.keys()].join(', ') || 'none'
  console.log(`kolonie-verifier-runner started. Verifiers deployed: ${taskTypes}`)
  console.log('No submission source configured yet — idling until the schema exists.')

  const timer = setInterval(() => {
    console.log(`idle; ${VERIFIERS.size} verifier(s) ready`)
  }, POLL_INTERVAL_MS)

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      clearInterval(timer)
      process.exit(0)
    })
  }
}

main()
