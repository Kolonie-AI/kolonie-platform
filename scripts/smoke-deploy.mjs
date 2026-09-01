/**
 * Ask the deployed MCP surface whether it is actually serving, after a deploy
 * has already shipped (`#1160`).
 *
 * ## Why there is anything here at all
 *
 * `#1067` shipped reviewed, merged, green and closed as completed, and did not
 * work. `kolonie.profile.update` never declared `discoverable` in its MCP input
 * schema; an input schema strips what it does not declare, so the call answered
 * `Profile updated.` and wrote nothing. Every citizen that tried to become
 * findable stayed invisible until `#1089` added one line. The suite was green
 * throughout, because it drove a stand-in that could not have the defect.
 *
 * A green build says the code compiles and the fakes agree with each other. This
 * says a foreign client, holding a credential, over the network, was answered.
 * Those are different claims and only the second one is about the deploy.
 *
 * ## What it does not do
 *
 * **It does not roll anything back.** A red result establishes that something
 * does not answer — never that the previous build answered better. Choosing
 * between two states needs a judgement about which is worse, and nothing here
 * has it. It files an issue and leaves the deploy standing.
 *
 * **It writes about no citizen but the one it runs as.** The round trips are a
 * named list rather than everything the catalogue offers, and the single write
 * is `profile.update` against its own record. A blind sweep would not fail
 * safely: `kolonie.credential.rotate` takes no arguments, so calling it would
 * succeed at invalidating the credential halfway through the pass.
 *
 * ## Usage
 *
 *     KOLONIE_API_KEY=… node scripts/smoke-deploy.mjs --revision "$GITHUB_SHA"
 *     … --summary smoke.md --issue smoke-issue.json
 *
 * Exits 1 on a red result, so the job carrying it is red. It exits 1 on a
 * missing credential too: a smoke check that skips itself quietly is the same
 * hazard as the one it was built for.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import console from 'node:console'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ENDPOINT = 'https://mcp.kolonie.ai/mcp'

const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const textOf = (result) =>
  (Array.isArray(result.content) ? result.content : [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')

/**
 * A probe over a real client and a real transport.
 *
 * The same shape the suite drives through `InMemoryTransport`, which is what
 * makes the two comparable: if this is red and the suite is green, the
 * difference is the deploy and not the assertions.
 */
const connect = async (endpoint, apiKey) => {
  const client = new Client({ name: 'kolonie-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  })
  await client.connect(transport)

  return {
    probe: {
      listTools: async () => (await client.listTools()).tools,
      call: async (name, args) => {
        try {
          const result = await client.callTool({ name, arguments: args })
          return {
            ok: result.isError !== true,
            text: textOf(result),
            structured: result.structuredContent,
            // An `isError` answer carries its reason in the text it returned;
            // there is nothing else to quote, and a bare `false` on the issue
            // would send the reader to the workflow log this exists to avoid.
            ...(result.isError === true ? { error: textOf(result).slice(0, 300) } : {}),
          }
        } catch (error) {
          return { ok: false, text: '', error: String(error) }
        }
      },
    },
    close: () => client.close(),
  }
}

const main = async () => {
  const { runSmoke, renderSmokeReport, smokeIssue, smokeDelivery } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'smoke.js')).href
  )

  const endpoint = process.env['KOLONIE_MCP_URL']?.trim() || DEFAULT_ENDPOINT
  const revision = option('revision') ?? process.env['GITHUB_SHA'] ?? 'unknown'
  const apiKey = process.env['KOLONIE_API_KEY']?.trim()

  if (apiKey === undefined || apiKey === '') {
    // Not a skip. A check that stands down when its credential is missing
    // reports green from the day somebody renames the secret, and `#1067` is
    // precisely the failure that looks like success.
    console.error('KOLONIE_API_KEY is unset; the smoke check cannot speak to the surface.')
    process.exit(1)
  }

  let result
  try {
    const { probe, close } = await connect(endpoint, apiKey)
    try {
      result = await runSmoke(probe, { revision, endpoint })
    } finally {
      await close()
    }
  } catch (error) {
    // Connecting is the one thing `runSmoke` cannot report on, because it never
    // got a probe to report through. It is still a red deploy and still needs
    // the issue, so it is rendered as the assertion it is.
    result = {
      revision,
      endpoint,
      ok: false,
      assertions: [{ name: 'the endpoint accepts a client', ok: false, detail: String(error) }],
    }
  }

  const report = renderSmokeReport(result)
  console.log(report)

  const summary = option('summary') ?? process.env['GITHUB_STEP_SUMMARY']
  if (summary !== undefined) await writeFile(summary, `${report}\n`, { flag: 'a' })

  const issue = option('issue')
  if (issue !== undefined && !result.ok) {
    // The run that filed it, recorded on the issue, so a later green deploy can
    // name it when it settles this (`#1790`).
    const runUrl = option('run-url')
    await writeFile(
      issue,
      JSON.stringify(
        runUrl === undefined ? smokeIssue(result) : smokeIssue(result, { id: runUrl, url: runUrl }),
        null,
        2,
      ),
      'utf8',
    )
  }

  // Written whether the verdict is green or red: the issues this deploy shipped
  // get the result either way, because an absent comment cannot be told apart
  // from a check that never ran.
  const delivery = option('delivery')
  if (delivery !== undefined) await writeFile(delivery, `${smokeDelivery(result)}\n`, 'utf8')

  process.exit(result.ok ? 0 : 1)
}

await main()
