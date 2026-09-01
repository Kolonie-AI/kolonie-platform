/**
 * Close the commit-keyed smoke findings a later green deploy has cleared
 * (`#1790`).
 *
 * ## Why this runs at all
 *
 * `#1789` was filed for deploy `418dfea9` after six MCP calls met transient
 * Cloudflare origin 502s. The deploy that followed it, `b8bb30d7`, deployed
 * green and smoked green against the same endpoint — and the finding stayed
 * open until a person closed it, because the workflow held every piece of the
 * clearing evidence and had no rule that read it.
 *
 * ## What it will not do
 *
 * **It never settles on health alone.** The caller runs it only when the deploy
 * job succeeded *and* this run's own MCP smoke succeeded; `/health` says a
 * process is listening, which was true throughout `#1789`.
 *
 * **It rolls nothing back, retries nothing and suppresses nothing.** A revision
 * that goes red after this files its own commit-keyed finding, exactly as before.
 *
 * The decision is `smokeFindingsToSettle` in `apps/api/src/mcp/smoke.ts`, which
 * is production code and under test; this file is the driver that hands it the
 * open issues and writes what it decided.
 *
 * ## Usage
 *
 *     node scripts/settle-smoke-findings.mjs --revision "$GITHUB_SHA" \
 *       --run-url "$RUN_URL" --run-id "$GITHUB_RUN_ID" \
 *       --deploy-job 'deploy to the VPS' --smoke-job 'smoke the deployed MCP surface'
 *
 * `--dry-run` prints what it would close and writes nothing, which is what the
 * rehearsal uses.
 */
import { execFile } from 'node:child_process'
import console from 'node:console'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const flag = (name) => process.argv.includes(`--${name}`)

const gh = async (args) => (await run('gh', args, { maxBuffer: 32 * 1024 * 1024 })).stdout

const main = async () => {
  const { smokeFindingsToSettle, smokeSettlementComment } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'smoke.js')).href
  )

  const revision = option('revision') ?? process.env['GITHUB_SHA']
  const runUrl = option('run-url')
  const runId = option('run-id') ?? process.env['GITHUB_RUN_ID']
  const deployJob = option('deploy-job') ?? 'deploy to the VPS'
  const smokeJob = option('smoke-job') ?? 'smoke the deployed MCP surface'
  const dryRun = flag('dry-run')

  if (revision === undefined || runUrl === undefined || runId === undefined) {
    console.error('settle-smoke-findings needs --revision, --run-url and --run-id.')
    process.exit(2)
  }

  // Only issues carrying a smoke marker are listed, and the decision reads the
  // first line of each body — an issue that merely quotes a marker is never
  // adopted (`#946`).
  const listed = await gh([
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    '"<!-- watch-finding: smoke-" in:body',
    '--limit',
    '100',
    '--json',
    'number,body',
  ])
  const open = JSON.parse(listed.trim() === '' ? '[]' : listed)

  // Both halves are the caller's to establish, and the caller only runs this
  // step when both are green. Passing them explicitly keeps the decision in one
  // tested function rather than in a workflow condition alone.
  const settled = smokeFindingsToSettle({ deployOk: true, smokeOk: true, revision, open })

  if (settled.length === 0) {
    console.log('No commit-keyed smoke finding is open that this deploy clears.')
    return
  }

  const healthy = { revision, run: { id: runId, url: runUrl }, deployJob, smokeJob }

  for (const finding of settled) {
    const comment = smokeSettlementComment(finding, healthy)
    if (dryRun) {
      console.log(`Would close #${finding.number}:`)
      console.log(comment)
      continue
    }
    // Comment first, close second: a finding never ends without saying why.
    await gh(['issue', 'comment', String(finding.number), '--body', comment])
    await gh(['issue', 'close', String(finding.number)])
    console.log(`Closed #${finding.number}, filed for ${finding.revision.slice(0, 8)}.`)
  }
}

await main()
