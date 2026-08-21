import { randomUUID } from 'node:crypto'
import {
  RECIPE_MAX_STEPS,
  RECIPE_STEP_MAX_LENGTH,
  EntryWordingSchema,
  type EntryWording,
  type AgentId,
  type Log,
  type Task,
} from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { CONSOLE_HEADERS, errorPage, notFoundPage } from '../console/html.js'
import type { ConsoleNav } from '../console/navigation.js'
import { atlasCatalogue } from '../provider-recipes.js'
import { routeKeyOf } from '../call-rollup.js'
import type { WishCatalogueEntry } from '../console/agent-accounts.js'

/**
 * What *muted, until I say otherwise* is written as (`#1449`).
 *
 * `muted_until` is a nullable timestamp so that *mute for a week* is
 * expressible, and nothing on the page offers a date yet — so an indefinite
 * mute is a date far enough out to mean it. A boolean column would have made
 * the timed case a migration; this makes it a control somebody adds later.
 */
export const MUTED_INDEFINITELY = '2999-01-01T00:00:00.000Z'
import type { RouteDependencies } from './dependencies.js'

/**
 * `console.kolonie.ai`: an authenticated surface served by the API (`#179`).
 *
 * ## Why it is here and not somewhere more obvious
 *
 * The obvious home for a sponsor's login is `kolonie-website`, and it is the
 * wrong one: that repository is a static Astro site whose own config says
 * *"agents use the API and the MCP server and never load a page here"*, and
 * making it session-bearing means giving a documentation site a server, a
 * database connection and an auth stack.
 *
 * The second obvious answer — a third deployable — undoes `kolonie-infra#31`,
 * which collapsed three build workflows into one so that *"one commit in
 * `kolonie-platform` produces one deploy"*.
 *
 * So it goes in `apps/api`, which already authenticates, already holds the
 * database connection, already deploys, and already runs migrations before the
 * runners that read them. No new container, no new deploy chain, no new secret.
 *
 * ## One route tree, two representations
 *
 * An agent calls these paths with its API key and gets JSON; a browser gets
 * HTML. That is the mechanism that keeps `kolonie-docs#108`'s promise — an agent
 * must never have to drive a browser to be a sponsor — and it is cheaper than
 * two route trees that will disagree.
 *
 * ## The host is configuration
 *
 * Which host this answers on comes from `CONSOLE_URL`, like every other host in
 * this repository (`AGENTS.md` §3). **An unconfigured deployment serves no
 * console at all** rather than serving it everywhere: the pages would otherwise
 * appear at the API's own host, where nothing expects a `Set-Cookie` and a
 * form.
 */
/**
 * What the dashboard says after a drop was filled from the queue (`#570`).
 *
 * **Keyed by `SubmitDropOutcome`**, so a new ending cannot be added to the
 * sealing path and quietly render as nothing here. `closed` is deliberately one
 * sentence for four states — expired, already answered, never a drop, or
 * somebody else's agent — on `submitDrop`'s own reasoning: telling them apart
 * would let a signed-in person learn that an id belongs to another operator's
 * fleet.
 */
export const FILL_NOTICE: Record<string, string | undefined> = {
  accepted:
    'Sent. It went straight into that agent\u2019s vault, sealed \u2014 nobody can read it back ' +
    'out, including you and including the Colony. The agent carries on within moments.',
  closed:
    'That one is no longer open. It may have been answered already, or expired, or it is not ' +
    'yours to fill. Nothing was sent and nothing is held against the agent.',
  'key-taken':
    'The agent already holds something under that name in its vault, and the Colony will not ' +
    'overwrite it. Nothing was sent \u2014 the agent has to clear the old one or ask again ' +
    'under another name.',
  'vault-full':
    'That agent\u2019s vault is full, so there is nowhere for this to land. Nothing was sent; ' +
    'the agent has to remove something first.',
}

/**
 * What an operator is told about a slot that is not theirs to act on (`#931`).
 *
 * **One sentence for six states**, which is one more than the handover has and
 * the same reasoning: read out, expired, closed over with its episode, never
 * filled, never awaiting them, or never theirs. A console that told them apart
 * would answer questions about a conversation the asker is not in.
 */
export const SLOT_CLOSED_NOTICE =
  'That one is not open to you. It may have been answered already, read the number of times it ' +
  'allows, closed with its episode, or it was never yours \u2014 the Colony answers the same way ' +
  'to all of them on purpose. Nothing was sent and nothing is held against the agent. Ask your ' +
  'agent to open another; it costs it nothing.'

/**
 * What a form on the account's page is told when the conversation will not take
 * it (`#932`).
 *
 * **One sentence for four states**, on `SLOT_CLOSED_NOTICE`'s reasoning: closed
 * since the page was drawn, never this account's, never this agent's, or a
 * Colony wired without the conversation at all. The HTML path never sees it — a
 * form that will not land redirects to the page, which now says what is true.
 */
export const THREAD_CLOSED_NOTICE =
  'That conversation is not open to you. It may have been closed since this page was drawn, or ' +
  'it belongs to another account — the Colony answers the same way to both on purpose. ' +
  'Nothing was written.'

/** The two ends of the slot round trip, carried across a redirect like `filled`. */
export const SLOT_NOTICE: Record<string, string | undefined> = {
  filled:
    'Sent. It went into the slot sealed, and your agent claims it into its own vault under the ' +
    'name it chose \u2014 nobody reads it back out, including you and including the Colony.',
  closed: SLOT_CLOSED_NOTICE,
}

/**
 * How far back `/backend/diagnoses` reads the consultation funnel (`#1081`).
 *
 * **Shorter than the 90 days a diagnosis is kept for**, deliberately: the
 * question the line answers is *is this channel working now*, and a window as
 * long as retention would take a quarter to notice that it had stopped.
 */
export const CONSULTATION_WINDOW_DAYS = 30

/**
 * What every console module needs and nothing owns: the chrome, the two
 * predicates, and the error pages (`#1498`).
 *
 * **Its own module rather than staying in `console-pages.ts`.** That file
 * imports the seven route modules, and they need `navFor` and `html` — 48 and 83
 * references between them. Leaving these there would make every route module
 * import from the file that imports it, which ESM tolerates and nobody should
 * have to reason about.
 *
 * `console-pages.ts` re-exports the five `app.ts` and `console-pages.test.ts`
 * already import, so neither moves.
 *
 * Every line here is the bytes that were at the bottom of `console-pages.ts`.
 */

/**
 * The three targeting axes of a quest, in the shape the audience count takes
 * (`#227`).
 *
 * One function rather than an object literal at each call site: a fourth
 * criterion added to a quest and forgotten here would make the count quietly
 * wider than the listing, and a number that overstates the audience is worse
 * than none — it is the sponsor's decision, made on a figure nothing supports.
 */
export function audienceOf(quest: Task) {
  return {
    audience: quest.audience,
    requires: quest.requires,
    minReputation: quest.minReputation,
    minActivityDays: quest.minActivityDays,
  }
}

/**
 * The route a curator typed into the entry form (`#857`, rewritten by `#1032`).
 *
 * **Read positionally, from fields named by index.** A form that repeated one
 * name would hand back a string for a one-step route and an array for a
 * two-step one, and the step a mis-indexed sentence lands on is the step an
 * agent then follows. `instruction-0` cannot drift.
 *
 * **How far the form reaches changed with the entry underneath it.** It used to
 * supply sentences only, onto a shape a walk had already recorded; a measured
 * entry records no shape, so the actor is a field here now. The length is read
 * off the form rather than off the entry for the same reason — nothing on the
 * row says how many steps this provider takes.
 *
 * **Absence is a real answer and it is not an empty route**: a form that names
 * no `proves` is one nobody filled in, and the caller says so in its own words
 * rather than reporting a schema failure about a list of zero steps.
 */
export function wordingIn(
  body: unknown,
):
  | { readonly ok: true; readonly wording: EntryWording }
  | { readonly ok: false; readonly why: string }
  | undefined {
  const fields = (body ?? {}) as Record<string, unknown>
  const field = (name: string): string | undefined => {
    const value = fields[name]

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  if (field('proves') === undefined) return undefined

  /**
   * Stops at the first index with neither an actor nor an instruction, so a form
   * that offers more blank rows than the curator used publishes the route they
   * wrote rather than refusing on the blanks underneath it.
   */
  const written: unknown[] = []
  for (let at = 0; at < RECIPE_MAX_STEPS; at += 1) {
    const actor = field(`actor-${String(at)}`)
    const instruction = field(`instruction-${String(at)}`)
    if (actor === undefined && instruction === undefined) break

    const ask = field(`ask-${String(at)}`)
    written.push({
      actor,
      instruction,
      ...(ask === undefined ? {} : { ask }),
      ...(fields[`secret-${String(at)}`] === undefined ? {} : { secret: true }),
    })
  }

  const parsed = EntryWordingSchema.safeParse({
    steps: written,
    proves: field('proves'),
    ...(field('provesTask') === undefined ? {} : { provesTask: field('provesTask') }),
  })

  return parsed.success
    ? { ok: true, wording: parsed.data }
    : {
        ok: false,
        why:
          'That route does not fit a recipe: every step names who acts and carries a sentence of ' +
          `at most ${String(RECIPE_STEP_MAX_LENGTH)} characters, and the proof method has to be ` +
          'one the Colony recognises.',
      }
}

/**
 * The console's 404, and it stopped being the sign-in page in `#396`.
 *
 * A 404 listing the API's routes would be an oracle for which console pages
 * exist, so an unknown path on the console host answers with this and nothing
 * else. Called from `app.ts`'s single not-found handler rather than registered
 * as a second one: Fastify allows one per context, and the API's own answer
 * names the REST prefix and the MCP path, which is the wrong thing to say to a
 * browser.
 *
 * **Rendering the front door for a wrong URL is what hid that defect for the
 * whole of its life.** The mailed link pointed at a route nobody had registered;
 * every reader who followed one got a 200-shaped page with a form on it, read it
 * as *the link expired*, asked for another and arrived back here. A status code
 * no browser displays was the only thing saying otherwise.
 */
export function consoleNotFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(404).type('text/html; charset=utf-8').send(notFoundPage())
    : reply.status(404).send({ code: 'not_found', message: 'No such route.' })
}

/**
 * What the navigation needs to know, for one request (`#608`).
 *
 * **One place, and the role question is the same expression the guards use.**
 * `#606`: *"the page and the navigation must ask the same question, or a
 * steward gets a link to a page that refuses them."* `/backend` is behind
 * `roles.includes('maintainer')` on the signed-in human, and so is the
 * section the navigation renders for it.
 *
 * `roles` is omitted where the caller is an agent with a key rather than a
 * person with a session — those pages have no role to read, and a navigation
 * that guessed would be guessing about somebody who cannot use the answer.
 */
export const navFor = (
  request: FastifyRequest,
  roles?: readonly string[],
  /**
   * The agent whose pages this one is among (`#797`), from `agentNavFor`.
   *
   * Omitted everywhere else, which is what keeps the section out of the
   * navigation on every page that is not inside an agent.
   */
  agent?: ConsoleNav['agent'],
): ConsoleNav => {
  // The path only: a query string is not a destination the navigation carries,
  // and `?filled=…` on the dashboard would stop `/` matching itself.
  const path = request.url.split('?')[0] ?? '/'
  return {
    current: path,
    ...(roles?.includes('maintainer') === true ? { maintains: true } : {}),
    ...(agent === undefined ? {} : { agent }),
  }
}

/** Whether this request arrived on the console's host, as `app.ts` asks it. */
export function isConsoleRequest(
  request: { readonly headers: { host?: string } },
  consoleUrl: string,
): boolean {
  const host = consoleHost(consoleUrl)
  if (host === undefined) return false

  return (request.headers.host ?? '').split(':')[0]?.toLowerCase() === host
}

/**
 * Which representation this caller wants.
 *
 * **JSON is the default and HTML is the exception**, which is the opposite of
 * what a browser-first surface would do and is deliberate: an agent that sends
 * no `Accept` at all must never be handed a page. Only a caller that explicitly
 * prefers HTML gets one, and a browser always does.
 */
export function wantsHtml(request: { readonly headers: { accept?: string } }): boolean {
  const accept = request.headers.accept ?? ''
  if (accept === '') return false
  if (accept.includes('application/json')) return false
  return accept.includes('text/html') || accept.includes('*/*')
}

export const html = (reply: FastifyReply, body: string): FastifyReply =>
  reply.type('text/html; charset=utf-8').send(body)

/**
 * The host the console answers on, from `CONSOLE_URL`, or nothing.
 *
 * A malformed URL is the same as an absent one: the console does not serve. A
 * process that cannot tell where its console lives must not guess, because the
 * guess would be the API's own host.
 */
export function consoleHost(consoleUrl: string): string | undefined {
  if (consoleUrl.trim() === '') return undefined

  try {
    return new URL(consoleUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The error id a console failure carries.
 *
 * It is a uuid and not a message: an id can be found in a log, and a message is
 * the thing `#171` is about.
 *
 * **No longer exported, and that is `#496`'s last step.** It was exported so
 * "the error handler and its test name the same thing" — and two review routes
 * then called it to stamp an id on a page nothing logged. A uuid generator
 * reachable from anywhere is how a findable id became an unfindable one twice.
 *
 * Its one caller is {@link consoleError}, which writes the log line the page's
 * *"Error id"* promises (`#490`). Anything that wants an id wants that function.
 */
export function consoleErrorId(): string {
  return randomUUID()
}

/**
 * The console's own error rendering. See {@link errorPage} for why it takes an id.
 *
 * **It logs, and it logs here rather than at the call site (`#490`).** The page
 * has always said the failure can be looked up, and until this function wrote a
 * line there was nothing anywhere to look up: `app.ts`'s error handler returns
 * through this path *above* its own `log.error`, so a console 5xx took the one
 * route out of that function that recorded nothing. A maintainer hit it on
 * `POST /funding/identity` on 2026-08-07 and the cause could not be established
 * from the id at all.
 *
 * Logging inside the render, rather than beside the branch that reaches it, is
 * what makes that unrepeatable: a future early return cannot skip a line written
 * by the function it is returning.
 *
 * **The id is generated once and used twice**, which is the property `#490` asks
 * a test to prove by reading both out of one request rather than each against a
 * fixture — two assertions against two fixtures pass happily with two
 * generators.
 */
export function consoleError(
  reply: FastifyReply,
  request: FastifyRequest,
  caught: unknown,
  log: Log,
): FastifyReply {
  const errorId = consoleErrorId()

  /**
   * The same field shape `app.ts` uses for the 5xx it does log, plus `errorId`.
   * A second event name for the same kind of failure would split the query a
   * person runs during an incident, which is the one moment nobody should be
   * asked to remember there are two.
   *
   * **`errorId` is a field on the line and never a Loki label.** `kolonie-infra#68`
   * fixes the label set at `service` and `level`, because *"cardinality is how a
   * Loki install dies"* — and a uuid per request is the unbounded worst case
   * that rule exists for. It is found with a line filter.
   */
  log.error(`${request.method} ${request.url} failed`, caught, {
    event: 'request.failed',
    requestId: request.id,
    method: request.method,
    route: routeKeyOf(request),
    url: request.url,
    status: 500,
    errorId,
  })

  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(500).type('text/html; charset=utf-8').send(errorPage(errorId))
    : reply.status(500).send({ code: 'internal', message: 'Internal error.', errorId })
}

/**
 * What the catalogue says about each provider on one agent's list (`#581`).
 *
 * **Only the providers on the list**, which is what keeps this from being a
 * hundred-and-eight-entry read rendered as five rows. `atlasCatalogue` is one
 * query either way; the narrowing is of the map handed to the page, so the
 * renderer cannot accidentally show the whole Atlas in a table about a plan.
 */
export const wishCatalogue = async (
  dependencies: RouteDependencies,
  agentId: AgentId,
): Promise<Record<string, WishCatalogueEntry>> => {
  const [wishes, entries] = await Promise.all([
    dependencies.wishes.store.list(agentId),
    atlasCatalogue(dependencies.recipes),
  ])

  const wanted = new Set(wishes.map((wish) => wish.provider))
  const held: Record<string, WishCatalogueEntry> = {}

  for (const entry of entries) {
    if (!wanted.has(entry.provider)) continue

    /**
     * The kind the entry is titled by, which is the one `atlasEntries` already
     * chose to stand for the provider (`#936`). It prefills the start form and
     * constrains nothing: a provider walked for a mailbox is a provider
     * somebody may want an entirely different sort of account at.
     */
    const lead = entry.recipes.find((recipe) => recipe.status === entry.status) ?? entry.recipes[0]

    held[entry.provider] = {
      status: entry.status,
      operatorNeed: entry.operatorNeed,
      /** The reason a refusal records, from the row that carries it. */
      refusal: entry.recipes.find((recipe) => recipe.refusal !== null)?.refusal ?? null,
      ...(lead === undefined ? {} : { kind: lead.kind }),
    }
  }

  return held
}
