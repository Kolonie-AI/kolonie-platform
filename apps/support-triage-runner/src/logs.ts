import type { Log } from './loop.js'
import { reachableFetch, REACHES } from './reachable.js'

/**
 * The Colony's own errors, read out of Loki (`#407`).
 *
 * ## Why this lives beside support triage
 *
 * `#407` recommends reusing this runner's GitHub seam rather than building a
 * second runner: the App is already installed, the repository routing already
 * exists, and **two processes each holding a write credential is the outcome to
 * avoid.** So this is a second *source* into machinery that already turns a
 * report into an issue. The name on the container is now narrower than what it
 * does, which is a cost worth paying over a second credential.
 *
 * ## Detection is deterministic; the model only writes
 *
 * Everything in this file is arithmetic over counts. No model decides whether
 * something is wrong, which is `#133`'s principle applied more strictly — and it
 * is what keeps a provider outage from blinding the Colony. What the model does,
 * where it is available at all, is turn a signature and its evidence into
 * sentences a person wants to read.
 *
 * ## Numbers, never a firehose
 *
 * The counting query aggregates inside Loki, exactly as `watch-agent.sh` does.
 * Sample lines are fetched only for a signature that is about to become an
 * issue, and only a handful — the evidence a reader needs, not a copy of the
 * logs. The lines stay in Loki, where retention already applies to them.
 */

/** One error signature and what the window said about it. */
export interface LogSignature {
  /** `<service>/<event>`, and the route where there is one. The dedupe key. */
  readonly signature: string
  readonly service: string
  /** The event slug, or the masked shape of the message when there is none. */
  readonly event: string
  /**
   * The route template the line carried, where it carried one (`#896`).
   *
   * **`null` for every line that is not an HTTP failure**, which is most of
   * them — a runner's `poll.failed` has no route, and a signature that invented
   * one for it would be a distinction the line does not make.
   */
  readonly route: string | null
  /** Lines in the window. */
  readonly count: number
}

/**
 * One link of an error's `cause` chain, as an issue is allowed to quote it.
 *
 * **Three fields, and the list is closed** (`#898`). `name` says which library
 * threw, `code` is the machine-readable verdict — a SQLSTATE, an `ECONNRESET` —
 * and `message` is the sentence. Everything else a driver hangs off an error is
 * deliberately not read: `detail`, `where`, `query` and `parameters` are the
 * fields that carry row values and bound parameters, and this body is public.
 *
 * A `23505` is the case that decides it. Its `message` names the constraint —
 * `duplicate key value violates unique constraint "…"` — and its `detail` names
 * the row that collided, which on this platform is somebody's address. The first
 * is the diagnosis and the second is the data, so the first is quoted and the
 * second is never read at all rather than filtered afterwards.
 */
export interface LogCause {
  readonly name: string | null
  readonly code: string | null
  readonly message: string | null
}

/** Everything a reader needs before a model's opinion. */
export interface DefectEvidence {
  readonly firstAt: string | null
  readonly lastAt: string | null
  /** A handful of lines, truncated. Evidence, not a copy of the store. */
  readonly samples: readonly string[]
  /**
   * The `cause` chain of the first sampled line that has one, read whole.
   *
   * **Separate from `samples` because it has to survive their truncation**
   * (`#898`). Drizzle puts the entire statement in `message`, so a budget spent
   * on the sample is spent on SQL and the `cause` is always last — `#895`'s two
   * samples were both cut mid-column-list, and the model judging them said in as
   * many words that it could not tell data from schema from connectivity. The
   * one field it needed, `42809`, was on the line it was reading.
   *
   * Empty for a line with no cause, which is most of them.
   */
  readonly causes: readonly LogCause[]
}

/**
 * What the detector needs from the log store, as a seam.
 *
 * A seam rather than a client, for `Issues`' reason one file over: what to file
 * is then testable without a Loki, and a runner with no log store degrades
 * rather than stops.
 */
export interface Logs {
  /**
   * Whether this seam can reach the store at all.
   *
   * **The same load-bearing flag `Issues.available` is**, and for a sharper
   * reason: a store that answers nothing looks exactly like a Colony with no
   * errors. A detector that could not tell those apart would report health it
   * had never measured.
   */
  readonly available: boolean
  /** Error signatures in the window, with a count each. */
  signatures(windowSeconds: number): Promise<readonly LogSignature[]>
  /** Count one exact signature across a settlement window. */
  countExact(signature: string, windowSeconds: number): Promise<number>
  /** The evidence for one signature: when, and a few lines of what. */
  evidence(signature: LogSignature, windowSeconds: number): Promise<DefectEvidence>
  /**
   * When a service last started, at or before a moment.
   *
   * **The field that diagnosed `#404` and must not be optional.** A `ZodError`
   * broke `kolonie.tasks.get` three minutes after a deploy, and *three minutes
   * after a deploy* is most of the diagnosis. Every process here logs
   * `service.started` or `runner.started` on boot (`#230`), so this is a read
   * rather than a new record somebody has to remember to write.
   *
   * `null` when nothing was found, which is the honest answer for a window with
   * no restart in it — not a guess at the last one.
   */
  lastStart(service: string, beforeIso: string): Promise<string | null>
}

/** A `Logs` that reads nothing, for a runner with no store configured. */
export const noLogs: Logs = {
  available: false,
  signatures: async () => [],
  countExact: async () => {
    throw new Error('no log store is configured')
  },
  evidence: async () => ({ firstAt: null, lastAt: null, samples: [], causes: [] }),
  lastStart: async () => null,
}

export const LOKI_URL_VAR = 'LOKI_URL'
export const LOKI_USER_VAR = 'LOKI_USER'
export const LOKI_TOKEN_VAR = 'LOKI_TOKEN'

/** How many sample lines one issue carries. Evidence, not a log dump. */
export const SAMPLE_LINES = 5

/** How much of a sample line survives. Long enough to recognise, short enough to read. */
export const SAMPLE_LENGTH = 400

/**
 * The shape of a message, with everything that varies between two occurrences
 * taken out.
 *
 * **Only used where a line carries no `event` field.** The platform's own lines
 * do carry one (`#230`), so this is for everything else — and without it every
 * occurrence of one defect would be its own signature, which is the same failure
 * as one eternal issue turned inside out.
 *
 * What is masked is what makes two occurrences of one defect look different: ids,
 * numbers, quoted strings, paths and addresses. What survives is the sentence.
 */
export function maskedShape(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\/[\w./-]{4,}/g, '<path>')
    .replace(/"[^"]*"/g, '<quoted>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * How far down a `cause` chain this reads.
 *
 * **Three, because three is where the writer stops.** `serialiseError` in
 * `@kolonie-ai/core` serialises `cause` to depth 3 and no further, so a reader
 * that walked deeper would be walking a chain that cannot exist on a line the
 * Colony wrote — and on a line it did not write, an unbounded walk is a cycle
 * away from hanging the pass that reports every other signature.
 */
export const MAX_CAUSE_DEPTH = 3

/** How much of one cause's message survives. A sentence, not a document. */
export const CAUSE_MESSAGE_LENGTH = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A URL in a driver's message is the one credential shape that can be in one.
 *
 * `postgres://user:password@host/db` is a connection string, and a client that
 * cannot reach its server says so by quoting it. The writer redacts the hosts it
 * was configured with (`redactConfiguredHosts`), which covers the Colony's own
 * lines and nothing else; this covers the rest, by not quoting a URL at all.
 */
const withoutUrls = (text: string): string => text.replace(/\w+:\/\/\S+/g, '<url>')

const stringField = (value: unknown): string | null => {
  if (typeof value === 'string') return value === '' ? null : withoutUrls(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const bounded = (text: string | null): string | null =>
  text === null || text.length <= CAUSE_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, CAUSE_MESSAGE_LENGTH)}… (truncated)`

/**
 * One link of the chain, however odd the thing at that link turns out to be.
 *
 * **A `cause` is `unknown` and this file runs in the pass that reports every
 * other signature**, so a thrown string, a number, or an object with none of
 * these fields must produce a row rather than an exception. A non-object cause
 * is not discarded either: what it stringifies to is the message, because the
 * value somebody attached is the whole of what they were saying.
 */
function causeOf(value: unknown): LogCause {
  if (isRecord(value)) {
    return {
      name: stringField(value['name']),
      code: stringField(value['code']),
      message: bounded(stringField(value['message'])),
    }
  }
  return { name: null, code: null, message: bounded(stringField(String(value))) }
}

/**
 * The `cause` chain of one raw log line (`#898`).
 *
 * Read from the line before it is truncated, which is the whole point: the
 * fields that name the failure are last in the JSON and first in what a reader
 * needs. See {@link DefectEvidence.causes}.
 *
 * A line that is not JSON, or that carries no `err`, has no chain — and that is
 * an empty array rather than a thrown parse error, because this runs over every
 * line the store returns and one of them being a bare stack trace is ordinary.
 */
export function causeChain(line: string): readonly LogCause[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []

  const err = parsed['err']
  const chain: LogCause[] = []
  let next: unknown = isRecord(err) ? err['cause'] : undefined

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && next !== undefined && next !== null; depth += 1) {
    chain.push(causeOf(next))
    next = isRecord(next) ? next['cause'] : undefined
  }

  return chain
}

/**
 * The dedupe key, computed without a model.
 *
 * **A signature, not a title.** The Watch Agent matched on one fixed title and
 * therefore had exactly one issue, forever, with every finding as a comment on
 * it — the chronicle failure `kolonie-docs` `AGENTS.md` §2 names, one level up.
 * A key derived from *the thing that is wrong* is what makes each finding a
 * piece of work somebody can close.
 *
 * **The route is part of the key where the line has one** (`#896`). `api` logs
 * one event for every failing endpoint, so on `<service>/<event>` alone every
 * 500 in the API is one defect: `#896` — a failed query on `GET /v1/agents/me` —
 * was filed as a *regression* of `#764`, a payout balance check answering 522,
 * and while either was open a genuinely new endpoint failure would have been
 * deduped into it and never said out loud. The route is the template
 * (`/v1/agents/:handle`) and never the URL, so one defect stays one signature
 * however many citizens hit it.
 */
export function signatureOf(service: string, event: string, route?: string | null): string {
  const base = `${service}/${event}`
  return route === undefined || route === null || route === '' ? base : `${base} ${route}`
}

interface LokiOptions {
  readonly url: string
  readonly user: string
  readonly token: string
  readonly log: Log
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/**
 * A `Logs` backed by the real store.
 *
 * The same read `watch-agent.sh` makes, in the same shape and against the same
 * credential — this is a second reader of one store, not a second store.
 */
export function lokiLogs(options: LokiOptions): Logs {
  const doFetch = reachableFetch(REACHES.logs, options.fetchImpl ?? fetch)
  const now = options.now ?? Date.now
  const log = options.log

  const query = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const search = new URLSearchParams(params).toString()

    /**
     * **Sent only when there is one.** The token belongs to `logs.kolonie.ai`,
     * where Traefik's basicAuth sits; a container reading Loki over the internal
     * network passes no edge and has nothing to authenticate to. Sending an
     * empty credential would be a header that means *I tried*, and a deployment
     * that reads Loki directly would then look misconfigured.
     */
    const headers: Record<string, string> =
      options.token === ''
        ? {}
        : {
            authorization:
              'Basic ' + Buffer.from(`${options.user}:${options.token}`).toString('base64'),
          }

    const response = await doFetch(`${options.url.replace(/\/+$/, '')}${path}?${search}`, {
      headers,
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      // The status and nothing else: a body can echo the request, and the
      // request carries the credential.
      log.warn(`the log store answered ${response.status}`, {
        event: 'logs.read.failed',
        status: response.status,
      })
      return undefined
    }

    return response.json()
  }

  return {
    available: true,

    signatures: async (windowSeconds) => {
      const end = Math.floor(now() / 1000)
      const start = end - windowSeconds

      /**
       * The same aggregation `watch-agent.sh` uses, and deliberately so: two
       * definitions of *what counts as an error* is one that drifts, and the one
       * that drifts is the one an alarm reads.
       *
       * `level="error"` and nothing else. `kolonie-infra#80` is why this can see
       * more than five services — six of eleven could not express an error at
       * all before it, and `interactive` exists there so a maintainer's mistyped
       * query never arrives here.
       *
       * **`| __error__=""` is load-bearing and belongs after every `| json` in
       * this file** (`#435`). Loki answers a pipeline error with a 400 for the
       * *whole* query rather than skipping the series that caused it, and
       * Traefik's access log is CLF while its 502 lines are detected as
       * `error` — so one unparseable line anywhere in the window silenced this
       * query for as long as Traefik served anything at all. The runner caught
       * the 400 by design and went on, which is why nothing looked wrong from
       * `#407` until 2026-08-06. Lines the Colony did not write are exactly the
       * class worth catching, and this is what makes them countable instead of
       * fatal.
       */
      const counted = (await query('/loki/api/v1/query', {
        query: `sum by (service, event, route) (count_over_time({job="containers", level="error"} | json | __error__="" [${windowSeconds}s]))`,
        time: String(end),
      })) as
        | {
            data?: {
              result?: ReadonlyArray<{ metric?: Record<string, string>; value?: [number, string] }>
            }
          }
        | undefined

      const found: LogSignature[] = []
      for (const row of counted?.data?.result ?? []) {
        const service = row.metric?.['service']
        if (service === undefined || service === '') continue

        // A line with no `event` is not skipped: `#230` gave the platform's own
        // lines one, and everything else — a runtime crash, a stack trace, an
        // image the Colony did not write — is exactly the class worth catching.
        const event = row.metric?.['event'] ?? '«no event field»'
        // Absent on every line that is not an HTTP failure, and Loki renders an
        // absent label as an empty string rather than omitting the key — so both
        // are read as *this line has no route* (`#896`).
        const routeLabel = row.metric?.['route']
        const route = routeLabel === undefined || routeLabel === '' ? null : routeLabel
        const count = Number(row.value?.[1] ?? 0)
        if (!Number.isFinite(count) || count <= 0) continue

        found.push({ signature: signatureOf(service, event, route), service, event, route, count })
      }

      void start
      return found
    },

    countExact: async (signature, windowSeconds) => {
      const split = signature.indexOf('/')
      if (split < 1) throw new Error(`invalid log signature: ${signature}`)
      const service = signature.slice(0, split)
      const eventAndRoute = signature.slice(split + 1)
      const routeAt = eventAndRoute.indexOf(' ')
      const event = routeAt < 0 ? eventAndRoute : eventAndRoute.slice(0, routeAt)
      const route = routeAt < 0 ? null : eventAndRoute.slice(routeAt + 1)
      const routeFilter = route === null ? ' | route=""' : ` | route=${JSON.stringify(route)}`
      const eventFilter =
        event === '«no event field»' ? ' | event=""' : ` | event=${JSON.stringify(event)}`
      const end = Math.floor(now() / 1000)
      const counted = (await query('/loki/api/v1/query', {
        query:
          `sum(count_over_time({job="containers", service=${JSON.stringify(service)}, level="error"}` +
          ` | json | __error__=""${eventFilter}${routeFilter} [${windowSeconds}s]))`,
        time: String(end),
      })) as { data?: { result?: ReadonlyArray<{ value?: [number, string] }> } } | undefined

      const values = counted?.data?.result
      if (!Array.isArray(values)) {
        throw new Error(`the log store returned no complete count for ${signature}`)
      }
      const numbers = values.map((row) => Number(row.value?.[1]))
      if (numbers.some((value) => !Number.isFinite(value))) {
        throw new Error(`the log store returned no complete count for ${signature}`)
      }
      return numbers.reduce((total, value) => total + value, 0)
    },

    evidence: async (signature, windowSeconds) => {
      const end = Math.floor(now() / 1000)
      const start = end - windowSeconds

      // The same narrowing the count made, or the evidence is another endpoint's
      // (`#896`): a signature counted for one route and sampled across all of
      // them would quote a line the issue is not about, which is worse than
      // quoting none.
      const route = signature.route === null ? '' : ` | route=${JSON.stringify(signature.route)}`

      const selector =
        signature.event === '«no event field»'
          ? `{job="containers", service="${signature.service}", level="error"}`
          : `{job="containers", service="${signature.service}", level="error"} | json | __error__="" | event="${signature.event}"${route}`

      const found = (await query('/loki/api/v1/query_range', {
        query: selector,
        start: String(start * 1_000_000_000),
        end: String(end * 1_000_000_000),
        limit: String(SAMPLE_LINES),
        direction: 'forward',
      })) as
        | { data?: { result?: ReadonlyArray<{ values?: ReadonlyArray<[string, string]> }> } }
        | undefined

      const entries = (found?.data?.result ?? []).flatMap((stream) => stream.values ?? [])
      if (entries.length === 0) return { firstAt: null, lastAt: null, samples: [], causes: [] }

      const sorted = [...entries].sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])))
      const at = (nanos: string): string =>
        new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString()

      // From the whole lines, and before the slice below: one signature is one
      // defect, so the first line that carries a chain describes all of them.
      const causes =
        sorted
          .slice(0, SAMPLE_LINES)
          .map(([, line]) => causeChain(line))
          .find((chain) => chain.length > 0) ?? []

      return {
        firstAt: at(sorted[0]![0]),
        lastAt: at(sorted[sorted.length - 1]![0]),
        samples: sorted.slice(0, SAMPLE_LINES).map(([, line]) => line.slice(0, SAMPLE_LENGTH)),
        causes,
      }
    },

    lastStart: async (service, beforeIso) => {
      const before = Date.parse(beforeIso)
      if (!Number.isFinite(before)) return null

      // A day back and no further. A deploy older than that is not the
      // explanation for an error that started this afternoon, and saying so
      // would be worse than saying nothing.
      const start = Math.floor(before / 1000) - 86_400

      const found = (await query('/loki/api/v1/query_range', {
        query: `{job="containers", service="${service}"} | json | __error__="" | event=~"service.started|runner.started"`,
        start: String(start * 1_000_000_000),
        end: String(Math.floor(before / 1000) * 1_000_000_000),
        limit: '1',
        direction: 'backward',
      })) as
        | { data?: { result?: ReadonlyArray<{ values?: ReadonlyArray<[string, string]> }> } }
        | undefined

      const entries = (found?.data?.result ?? []).flatMap((stream) => stream.values ?? [])
      if (entries.length === 0) return null

      const newest = entries
        .map(([nanos]) => Number(BigInt(nanos) / 1_000_000n))
        .sort((a, b) => b - a)[0]

      return newest === undefined ? null : new Date(newest).toISOString()
    },
  }
}
