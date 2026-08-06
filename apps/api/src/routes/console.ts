import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CHECK_YOUR_MAIL,
  RedeemSchema,
  RequestLinkSchema,
  SignUpSchema,
  redeemSignIn,
  requestSignIn,
  signUp,
} from '../console.js'
import { clientIp } from '../client-ip.js'
import { sessionCookie } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The name the session cookie travels under.
 *
 * `__Host-` is a prefix with teeth rather than a convention: a browser refuses to
 * accept a cookie so named unless it is `Secure`, has `Path=/` and carries **no**
 * `Domain` attribute. That last one is what matters here — it makes the cookie
 * unsettable by any sibling host, so a foothold on some other subdomain cannot
 * write a session for the console.
 */
export const SESSION_COOKIE = '__Host-kolonie_session'

/**
 * Browser sign-in (`#172`).
 *
 * ## Why these are `/v1/` routes like everything else
 *
 * The console is a surface of this API and not a second application, so its
 * endpoints are versioned on the same terms as the rest — an HTML page served at
 * `console.kolonie.ai` calls the same paths an agent would. `kolonie-docs#108`
 * decides the hostname; this decides nothing about it.
 *
 * ## What an agent does instead
 *
 * Nothing here is required of one. An agent drives every console API route with
 * its ordinary API key, and only the HTML pages need a session — which is
 * deliberate, because an agent must never be told to open a browser in order to
 * be a sponsor.
 */
export function registerConsoleRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { console: consoleDeps, humans } = deps

  /**
   * Ask for a sign-in link.
   *
   * Always `202`, and always the same body. A `200` for a known address and a
   * `202` for an unknown one would be the disclosure this endpoint is shaped to
   * avoid, written in the status line instead of the body.
   */
  v1.post('/console/sign-in', async (request, reply) => {
    const parsed = RequestLinkSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'A sign-in request carries one field: `email`.',
      })
    }

    const result = await requestSignIn(parsed.data.email, callerKey(request), consoleDeps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Sign up, which is the same call with a name on it.
   *
   * A taken address answers exactly as a fresh one does. A taken *name* is said
   * plainly — names are already public through `POST /v1/agents/name-check`, and
   * a sign-up that failed silently would leave somebody waiting for mail that is
   * never coming.
   */
  v1.post('/console/sign-up', async (request, reply) => {
    const parsed = SignUpSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'A sign-up carries two fields: `name` and `email`.',
      })
    }

    const result = await signUp(parsed.data, callerKey(request), consoleDeps)

    if (result.outcome === 'name-taken') {
      return reply.status(ERROR_STATUS.conflict).send({
        code: 'conflict',
        message: `The name "${result.name}" is taken.`,
      })
    }

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Follow the link.
   *
   * The session leaves in `Set-Cookie` and the body carries nothing but the
   * identity it belongs to. Putting the value in the body as well would be
   * convenient for a test and would put a bearer secret into every proxy log
   * between here and the browser.
   */
  v1.post('/console/sign-in/redeem', async (request, reply) => {
    const parsed = RedeemSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'Redeeming a link carries one field: `token`.',
      })
    }

    const result = await redeemSignIn(parsed.data.token, callerKey(request), consoleDeps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    setSessionCookie(reply, result.session, result.maxAgeSeconds)

    return reply.status(200).send({ agentId: result.agentId })
  })

  /**
   * Open the sponsor identity a signed-in person does not have yet (`#430`).
   *
   * ## Why this exists at all
   *
   * `kolonie.ai/sponsors` step 5 said the deposit address *"is handed over the
   * API rather than shown in the console, so this is the one step a sponsor with
   * no agent cannot finish alone"*. A person is now a real authenticated subject
   * rather than a mail token, so the console can act for them — but only once
   * there is an identity to act as. This is the one call that makes one, and it
   * is the whole of what a person has to do before the deposit address, the
   * quest form and the funding step all work in a browser.
   *
   * ## What it does not mint
   *
   * **No API key.** That is the better answer to `#400` and not an omission: a
   * long-lived bearer token handed to a browser session has a worse lifetime
   * than the session it came from. A person who wants to script against the
   * Colony asks for a key deliberately, through the route that already exists
   * and shows it once.
   *
   * ## One, and the answer to a second is the first
   *
   * *One is the thing being paid for; two is an org feature, and organisations
   * are not in this design.* A second call answers `200` with the identity
   * already held rather than a refusal — the person's intent is satisfied
   * either way, and a `409` here would ask a browser to distinguish two
   * outcomes that mean the same thing to whoever clicked.
   *
   * ## The address is the provider's
   *
   * Taken from the `humans` row and never from the request body, which is the
   * D-018 property in the one place it matters most here: a body-supplied
   * address would let a signed-in person open an identity whose mail goes
   * somewhere they do not control. A provider that returned no address — GitHub
   * may — gets no mailbox row, which is an ordinary state and not a refusal.
   */
  v1.post('/console/sponsor', async (request, reply) => {
    const cookie = sessionCookie(request.headers.cookie)
    if (cookie === undefined) return refuseAnonymously(reply)

    const person = await humans.store.authenticate(cookie)
    if (person.outcome !== 'authenticated') return refuseAnonymously(reply)

    const parsed = OpenSponsorSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'Opening a sponsor account carries at most one field: `name`.',
      })
    }

    const result = await humans.store.openSponsor({
      humanId: person.human.id,
      // The Colony names it when the person did not, exactly as the sign-up
      // form does — and for the reason `generatedSponsorName` gives: a name
      // derived from the address would publish a piece of it through
      // `POST /v1/agents/name-check`, which answers without a credential.
      name: parsed.data.name ?? generatedSponsorName(),
      // The first identity that returned one. A person may have attached
      // several providers and they need not agree; the first attached is the
      // one they signed up with, which is the least surprising answer and the
      // only one that does not change under them when they add a provider.
      address: person.human.identities.find((one) => one.email !== null)?.email ?? undefined,
    })

    if (result.outcome === 'name-taken') {
      // `conflict`, which is the vocabulary this API has for *somebody else got
      // there first*. A name is the one field a caller chose, so unlike every
      // other refusal here it is said plainly — names are already public through
      // `POST /v1/agents/name-check`, so nothing is disclosed by saying so.
      return reply.status(ERROR_STATUS.conflict).send({
        code: 'conflict',
        message: `The name ${result.name} is already held.`,
      })
    }

    // `200` for both, because *opened* and *already held* mean the same thing to
    // whoever clicked. `created` says which happened, for a caller that cares.
    return reply.status(200).send({
      created: result.outcome === 'opened',
      sponsor: { id: String(result.identity.id), name: result.identity.name },
    })
  })
}

/** At most a name, and never an address — that comes off the `humans` row. */
const OpenSponsorSchema = z.object({ name: z.string().min(2).max(64).optional() })

/**
 * The refusal for anybody not signed in as a person.
 *
 * Identical to the one an absent credential gets anywhere else, and deliberately
 * so: there is nothing to disclose in the difference between *no cookie* and *a
 * cookie that resolves to nobody*.
 */
function refuseAnonymously(reply: FastifyReply): FastifyReply {
  return reply
    .status(ERROR_STATUS.unauthorized)
    .send({ code: 'unauthorized', message: 'Sign in to open a sponsor account.' })
}

/**
 * A name for an identity whose holder gave none.
 *
 * The same shape and the same alphabet as `generatedSponsorName` in
 * `packages/db/src/storage/sign-in.ts` — without `o`, `l` or the digits they are
 * confused with, because this string is read aloud and typed by hand more often
 * than it is copied. It is generated here rather than imported because the
 * storage one is private to the sign-up transaction it retries inside, and a
 * shared helper would make two callers of one retry loop.
 *
 * **Exported since `#455`**, which needs a name at the moment a person writes
 * their first quest draft rather than at the moment they ask for an identity.
 * That is a second caller of *this* function and not a third copy of the
 * alphabet, which is the thing the paragraph above is guarding against.
 */
export function generatedSponsorName(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let suffix = ''
  for (const byte of randomBytes(8)) suffix += alphabet[byte % alphabet.length]
  return `sponsor-${suffix}`
}

/**
 * The key both limiters that are not per-address run on.
 *
 * `clientIp` resolves the caller through the same precedence every other
 * front-door route uses, so a change there reaches this without a second
 * implementation. The literal fallback is what a caller whose address cannot be
 * resolved shares, and until `kolonie-infra#56` lands that is most of them.
 */
function callerKey(request: FastifyRequest): string {
  return clientIp(request.headers, request.socket.remoteAddress ?? '')
}

/**
 * Write the session cookie.
 *
 * Every attribute here is doing something:
 *
 * - `Secure` — the `__Host-` prefix requires it, and a session on a plaintext
 *   hop is a session anyone on the path holds
 * - `HttpOnly` — script on the page cannot read it, so an injected script cannot
 *   exfiltrate it
 * - `SameSite=Lax` — a cross-site `POST` carries no cookie, which is what makes
 *   a session-authenticated mutation safe from a form on somebody else's page.
 *   `Strict` was considered and rejected: it also strips the cookie from an
 *   ordinary top-level link, so a sponsor following a link from its own mail
 *   would arrive signed out
 * - `Max-Age` — an absolute lifetime, matching the row's `expires_at`. The
 *   browser and the database agree on when this ends, and the database is the
 *   one that decides
 * - `Path=/` — required by the prefix
 *
 * Set by hand rather than through a cookie plugin: this is the only cookie the
 * API sets, and a dependency whose defaults could change is a worse deal than
 * six attributes written out where they can be read.
 */
function setSessionCookie(reply: FastifyReply, session: string, maxAgeSeconds: number): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${session}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  )
}
