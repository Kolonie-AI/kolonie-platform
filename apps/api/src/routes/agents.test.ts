import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  CheckNameResponseSchema,
  ERROR_STATUS,
  RegisterAgentResponseSchema,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { NAME_CHECK_LIMIT, REGISTRATION_LIMIT, REGISTRATION_WINDOW_MS } from '../rate-limit.js'
import type { AgentRegistry } from '../registration.js'
import { brokenRegistry, DRIVER_FAILURE_MESSAGE, fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

let app: FastifyInstance

const withRegistry = async (registry: AgentRegistry = fakeRegistry()) => {
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry,
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorThreads: fakeOperatorThreads(),
    operatorPageMessages: fakeOperatorPageMessages(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    contributionQuality: fakeContributionQuality(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    wake: fakeWake(),
    wishes: fakeWishList(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
  })
  await app.ready()
  return app
}

/** One call at the front door, exactly as sent. What a first call actually gets. */
const call = (payload: object | string, headers?: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/v1/agents/register', payload, headers })

/**
 * A join: both calls, and the answer to the second (`#875`).
 *
 * Registration is two calls now, and most of this file is about what happens on
 * the far side of the pause — the shape of the response, the key, the arrival
 * text, what a taken name earns. Those assertions did not change and neither did
 * their meaning, so the second call is made for them rather than written into
 * each one.
 *
 * A first call that is refused for any other reason is handed straight back: a
 * malformed payload is answered before the pause is reached, and a test asserting
 * `422` must see the `422` rather than a confirmation it never asked for.
 */
const register = async (payload: object | string, headers?: Record<string, string>) => {
  const first = await call(payload, headers)
  if (first.statusCode !== ERROR_STATUS.confirmation_required) return first

  return call({ ...(payload as object), confirm: first.json().details.confirmationToken }, headers)
}

afterEach(async () => {
  await app?.close()
})

describe('POST /v1/agents/register', () => {
  it('creates an agent and answers 201', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(201)
  })

  it('answers exactly the shape core documents', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    // Once a skill ships, foreign agents have this shape hard-coded and the
    // Colony no longer controls their upgrade cycle. `strict` catches an extra
    // field as well as a missing one, because an extra field today is a field
    // someone depends on tomorrow.
    expect(() => RegisterAgentResponseSchema.strict().parse(response.json())).not.toThrow()
  })

  it('returns the API key, once, prefixed so a leak is greppable', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.json().credentials.apiKey.startsWith(API_KEY_PREFIX)).toBe(true)
  })

  it('starts every agent as a candidate holding no skills', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    expect(body.agent.status).toBe('candidate')
    expect(body.agent.roles).toEqual([])
    expect(body.agent.skills).toEqual([])
  })

  it('defaults the optional profile fields rather than omitting them', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    // Documented in RegisterAgentRequestSchema: a consumer never has to tell
    // `undefined` from `null`.
    expect(body.agent.profile.operator).toBeNull()
    expect(body.agent.profile.bio).toBeNull()
    expect(body.agent.profile.capabilities).toEqual([])
    // Retired with `#102`: an address is proved at the `solana-wallet` rung, so
    // there is no profile field for one to default.
    expect(Object.keys(body.agent.profile)).not.toContain('wallet')
  })

  /**
   * **The arrival stops being a form** (`#137`). These three are Academy Level 0
   * — the moment an agent decides what it is — and a door that accepted them let
   * the rung be satisfied in the registration call, before the agent had
   * considered the question. Measured across live onboardings, what filled them
   * in was usually the operator.
   *
   * Refused rather than dropped, for the reason the `wallet` case above records:
   * an agent that had its capabilities silently discarded would arrive believing
   * Level 0 was behind it, and find out only by failing a task it thought it had
   * already passed.
   */
  it.each(['capabilities', 'bio', 'avatarUrl'])(
    'refuses %s at registration rather than pre-filling the profile with it',
    async (field) => {
      await withRegistry()

      const values: Record<string, unknown> = {
        capabilities: ['typescript'],
        bio: 'Written by somebody who is not this agent.',
        avatarUrl: 'https://example.invalid/face.png',
      }

      const response = await register({
        name: 'canary',
        platform: 'openclaw',
        [field]: values[field],
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
      // The field is named, so the agent learns which one to stop sending rather
      // than only that the body was wrong. An unrecognised key has no path, so
      // it arrives in the message under `(body)` rather than as its own key.
      expect(JSON.stringify(response.json().details)).toContain(field)
    },
  )

  /** What still belongs at the door: the row cannot exist without them. */
  it('still accepts the three fields registration is for', async () => {
    await withRegistry()
    const response = await register({
      name: 'canary',
      platform: 'openclaw',
      operator: 'Gregor Sprint',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().agent.profile.operator).toBe('Gregor Sprint')
  })

  /**
   * **Silence is the failure this prevents.** A dropped field is a field the
   * caller believes it set — and the case that made it concrete is `wallet`,
   * retired from the profile in `#102` while this path still answered `201` and
   * threw it away. An agent following an older guide would have registered
   * believing it had recorded an address, then waited to be paid at one the
   * Colony never had.
   */
  it('refuses an unknown field rather than dropping it', async () => {
    await withRegistry()

    const response = await register({
      name: 'canary',
      platform: 'openclaw',
      wallet: 'So11111111111111111111111111111111111111112',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })

  it('never puts the key on the agent entity', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    expect(JSON.stringify(body.agent)).not.toContain(API_KEY_PREFIX)
  })

  it('matches the curl example in onboarding/agent-guide.md', async () => {
    await withRegistry()
    // That document is what a foreign agent reads before it writes any code.
    // If this test has to change, the document changes in the same PR.
    const response = await register({ name: 'your-name', platform: 'openclaw' })

    expect(response.statusCode).toBe(201)
    expect(response.json().credentials.apiKey).toBeTypeOf('string')
  })
})

/**
 * **The pause in front of the front door, at the door itself** (`#875`).
 *
 * `registration.test.ts` asserts what `register()` decides; this asserts what a
 * caller holding nothing but an HTTP client actually reads — the status, the
 * body shape, and that the token it was handed is in the place the OpenAPI
 * document says it is. A caller that cannot find the token from the response
 * alone has to read our source, and the whole point of the second call is that
 * it is answerable without one.
 */
describe('POST /v1/agents/register — the pause', () => {
  it('refuses the first call with a status that is not an error code', async () => {
    await withRegistry()

    const response = await call({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('confirmation_required')
  })

  /**
   * The body is the bare Colony error shape — `{code, message, details}` — so
   * `details` is where a caller looks, and not `error.details`.
   */
  it('encloses a token a caller can find without reading our source', async () => {
    await withRegistry()

    const body = (await call({ name: 'canary', platform: 'openclaw' })).json()

    expect(body.details.confirm).toBe('first-call')
    expect(body.details.name).toBe('free')
    expect(body.details.confirmationToken).toBeTypeOf('string')
    expect(body.details.confirmationExpiresAt).toBeTypeOf('string')
    expect(body.message).toContain(body.details.confirmationToken)
  })

  /** A pause, not a veto: the same name, asked for twice, is the name you get. */
  it('goes ahead on the second call with the name that was proposed', async () => {
    await withRegistry()

    const pause = await call({ name: 'canary', platform: 'openclaw' })
    const joined = await call({
      name: 'canary',
      platform: 'openclaw',
      confirm: pause.json().details.confirmationToken,
    })

    expect(joined.statusCode).toBe(201)
    expect(joined.json().agent.profile.name).toBe('canary')
  })

  it('creates no citizen and no key by refusing', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)

    const response = await call({ name: 'canary', platform: 'openclaw' })

    expect(JSON.stringify(response.json())).not.toContain(API_KEY_PREFIX)
    expect(registry.names()).toEqual([])
  })

  /**
   * **Two voices, and neither proposes a name.** A caller told the name is held
   * has to do something different from one told to think again about a name it
   * can have — and a Colony that suggested the alternative would be choosing
   * names, which `kolonie.name.check` already refuses to do.
   */
  it('says something different about a name that is already held', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw' })

    const held = await call({ name: 'canary', platform: 'openclaw' })
    const free = await call({ name: 'kestrel', platform: 'openclaw' })

    expect(held.statusCode).toBe(409)
    expect(held.json().details.name).toBe('taken')
    expect(held.json().message).not.toBe(free.json().message)
    // Held or free, there is a token: one branch for the caller, not two.
    expect(held.json().details.confirmationToken).toBeTypeOf('string')
  })

  /** A token for one name confirms that name, and that name gets its own pause. */
  it('refuses a token minted for another name, saying which way it failed', async () => {
    await withRegistry()
    const pause = await call({ name: 'canary', platform: 'openclaw' })

    const wrong = await call({
      name: 'kestrel',
      platform: 'openclaw',
      confirm: pause.json().details.confirmationToken,
    })

    expect(wrong.statusCode).toBe(409)
    expect(wrong.json().details.confirm).toBe('other-name')
    // The refusal carries the token `kestrel` actually needs, so a caller that
    // mixed two joins up spends one more call rather than starting again.
    expect(wrong.json().details.confirmationToken).not.toBe(pause.json().details.confirmationToken)
  })

  it('refuses a token that has already been spent', async () => {
    await withRegistry()
    const pause = await call({ name: 'canary', platform: 'openclaw' })
    const token = pause.json().details.confirmationToken
    await call({ name: 'canary', platform: 'openclaw', confirm: token })

    const again = await call({ name: 'canary', platform: 'openclaw', confirm: token })

    expect(again.json().details.confirm).toBe('spent')
  })

  it('refuses a token it never issued', async () => {
    await withRegistry()

    const response = await call({
      name: 'canary',
      platform: 'openclaw',
      confirm: 'never-issued',
    })

    expect(response.json().details.confirm).toBe('unknown')
  })

  /**
   * `#508`: a runtime filling a flat shape writes `null` where it has no value.
   * Absent and `null` both mean *this is a first call* — a door that read one of
   * them as a bad token would refuse the very call the two-step exists for.
   */
  it('reads an explicit null as a first call', async () => {
    await withRegistry()

    const response = await call({ name: 'canary', platform: 'openclaw', confirm: null })

    expect(response.json().details.confirm).toBe('first-call')
  })

  /**
   * The pause sits behind the refusals that have nothing to do with it, so a
   * caller proposing a name the Colony will never issue is told so on the first
   * call rather than after spending a token on it.
   */
  it('leaves the existing refusals firing on the first call', async () => {
    await withRegistry()

    const reserved = await call({ name: 'kolonie-desk', platform: 'openclaw' })
    const malformed = await call({ platform: 'openclaw' })

    expect(reserved.statusCode).toBe(422)
    expect(malformed.statusCode).toBe(422)
  })
})

/**
 * The HTTP half of the name check (`#138`), so the two surfaces cannot diverge.
 *
 * This is also where the `validation_failed` vocabulary is asserted: over MCP the
 * SDK refuses a malformed name against the tool's input schema before the handler
 * runs, so `CheckNameRequestSchema` is only reached on this path.
 */
describe('POST /v1/agents/name-check', () => {
  const check = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/agents/name-check', payload })

  it('answers 200 and free for a name nobody holds', async () => {
    await withRegistry()

    const response = await check({ name: 'nobody-has-this' })

    // 200 and not 201: nothing was created, and asking reserves nothing.
    expect(response.statusCode).toBe(200)
    expect(() => CheckNameResponseSchema.strict().parse(response.json())).not.toThrow()
    expect(response.json().available).toBe(true)
  })

  it('answers taken for a registered name, compared case-insensitively', async () => {
    await withRegistry()
    await register({ name: 'Canary', platform: 'openclaw' })

    expect((await check({ name: 'canary' })).json().available).toBe(false)
    expect((await check({ name: 'CANARY' })).json().available).toBe(false)
  })

  /**
   * Free or taken. The response shape is what keeps the holder out of it.
   *
   * Three fields since `#1006`, and the third is about the caller's own
   * allowance rather than about anybody else — which is why this test stayed an
   * exhaustive list of keys instead of becoming a list of forbidden ones. A
   * field that named the holder would still fail here.
   */
  it('answers with exactly three fields, so nothing about the holder can ride along', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw', operator: 'Gregor Sprint' })

    const body = (await check({ name: 'canary' })).json()

    expect(Object.keys(body).sort()).toEqual(['available', 'name', 'remaining'])
    expect(JSON.stringify(body)).not.toContain('Gregor Sprint')
  })

  /**
   * Reachable from a browser (`#421`), which is the entire purpose of
   * `kolonie-website#35`: a reader types a name on the landing page and the real
   * Colony answers before they have installed anything.
   */
  describe('from a browser', () => {
    it('answers the preflight a cross-origin JSON POST makes', async () => {
      await withRegistry()

      const response = await app.inject({ method: 'OPTIONS', url: '/v1/agents/name-check' })

      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(response.headers['access-control-allow-methods']).toContain('POST')
      expect(response.headers['access-control-allow-headers']).toContain('content-type')
    })

    /**
     * **Every path out, and not only the happy one.** A browser that cannot read
     * a refusal reports a network error, and the page then cannot tell *the
     * Colony refused this name* from *the Colony is down*.
     */
    it('lets a browser read the answer, the refusal and the rate limit alike', async () => {
      await withRegistry()

      expect(
        (await check({ name: 'nobody-has-this' })).headers['access-control-allow-origin'],
      ).toBe('*')
      expect((await check({ name: 'x' })).headers['access-control-allow-origin']).toBe('*')

      for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
        await check({ name: `candidate-${attempt}` })
      }
      const limited = await check({ name: 'one-more' })

      expect(limited.statusCode).toBe(ERROR_STATUS.rate_limited)
      expect(limited.headers['access-control-allow-origin']).toBe('*')
    })

    /**
     * **A `GET` that minted a row is the defect `src/lib/registration.ts`
     * avoided** by probing `/health` instead of the registration route. This
     * asks the same question of the check: an unauthenticated route on the
     * public internet must reserve nothing, so the name is still free
     * afterwards and registering it still works.
     */
    it('writes nothing, so a checked name is still free and still registrable', async () => {
      await withRegistry()

      await check({ name: 'considered' })
      await check({ name: 'considered' })

      expect((await check({ name: 'considered' })).json().available).toBe(true)
      expect((await register({ name: 'considered', platform: 'openclaw' })).statusCode).toBe(201)
    })
  })

  it('refuses a malformed name in the vocabulary registration uses', async () => {
    await withRegistry()

    const response = await check({ name: 'x' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(Object.keys(response.json().details)).toContain('name')
  })

  /** `.strict()`, for the reason registration is: a dropped field is a field the caller believes it sent. */
  it('refuses an unknown field rather than ignoring it', async () => {
    await withRegistry()

    const response = await check({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * Asking must not consume the allowance that lets an agent actually join. The
   * two calls cost different things — a check creates nothing — so they carry
   * separate allowances, and this is the property that makes deliberating about
   * a name free rather than something an agent pays for in registrations.
   */
  it('does not spend the registration allowance', async () => {
    await withRegistry()

    for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
      expect((await check({ name: `candidate-${attempt}` })).statusCode).toBe(200)
    }

    // The next check is refused, and registration is untouched.
    expect((await check({ name: 'one-more' })).statusCode).toBe(ERROR_STATUS.rate_limited)
    expect((await register({ name: 'canary', platform: 'openclaw' })).statusCode).toBe(201)
  })

  /**
   * The half of `#1006` that keeps an agent off the wall rather than telling it
   * how long the wall lasts. A citizen spent the allowance choosing a name — the
   * Colony calls it the one permanent decision and suggests no alternatives, so
   * checking several is the instruction — and met the refusal mid-decision. The
   * budget was only ever readable by exhausting it.
   */
  describe('the allowance it says is left', () => {
    it('says what is left on every answer, free name or taken', async () => {
      await withRegistry()
      await register({ name: 'canary', platform: 'openclaw' })

      expect((await check({ name: 'nobody-has-this' })).json().remaining).toBe(NAME_CHECK_LIMIT - 1)
      expect((await check({ name: 'canary' })).json().remaining).toBe(NAME_CHECK_LIMIT - 2)
    })

    /** Nought is an answer, and the last one before the hour closes. */
    it('reaches nought on the last check the window allows', async () => {
      await withRegistry()

      let last
      for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
        last = await check({ name: `candidate-${attempt}` })
      }

      expect(last?.statusCode).toBe(200)
      expect(last?.json().remaining).toBe(0)
      expect((await check({ name: 'one-more' })).statusCode).toBe(ERROR_STATUS.rate_limited)
    })
  })

  it('carries retry-after when it does run out', async () => {
    await withRegistry()

    for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
      await check({ name: `candidate-${attempt}` })
    }
    const refused = await check({ name: 'one-more' })

    expect(refused.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(refused.headers['retry-after']).toBeDefined()
  })
})

describe('POST /v1/agents/register — rejection', () => {
  it('refuses a duplicate name with a stable code', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw' })
    const second = await register({ name: 'canary', platform: 'openclaw' })

    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('conflict')
  })

  it('refuses a name that differs only in case', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw' })
    const second = await register({ name: 'CANARY', platform: 'openclaw' })

    expect(second.statusCode).toBe(409)
  })

  it('refuses a malformed body with a field-level explanation', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'not-a-platform' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('platform')
  })

  it('refuses a missing field, naming it', async () => {
    await withRegistry()
    const response = await register({ platform: 'openclaw' })

    expect(response.statusCode).toBe(422)
    expect(response.json().details).toHaveProperty('name')
  })

  it('refuses a name too short to identify anyone', async () => {
    await withRegistry()
    const response = await register({ name: 'a', platform: 'openclaw' })

    expect(response.statusCode).toBe(422)
  })

  it.each([
    ['not an object', 'canary', undefined],
    ['unparseable JSON', '{oops', 'application/json'],
    ['a bare JSON scalar', '42', 'application/json'],
  ])('blames the caller, not the Colony, for %s', async (_label, payload, contentType) => {
    await withRegistry()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
      payload,
    })

    // The status may be 400, 415 or 422 depending on how far the request got.
    // What must never happen is a 5xx: an agent reading `internal` concludes the
    // Colony is down and retries a request that can never succeed.
    expect(response.statusCode).toBeLessThan(500)
    expect(response.json().code).not.toBe('internal')
  })

  it('creates nothing when it refuses', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)
    await register({ name: 'canary', platform: 'not-a-platform' })

    expect(registry.names()).toEqual([])
  })

  it('turns a storage failure into 500 without quoting the driver', async () => {
    await withRegistry(brokenRegistry())
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(500)
    expect(response.json().code).toBe('internal')
    expect(response.body).not.toContain(DRIVER_FAILURE_MESSAGE)
  })
})

describe('registration is not reachable unversioned', () => {
  it('404s on /agents/register', async () => {
    await withRegistry()
    const response = await app.inject({ method: 'POST', url: '/agents/register' })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * The front door is the only place an anonymous caller writes to the database
 * (#10). These assert the brake, not the shape of the limiter — that is
 * `rate-limit.test.ts`. What matters here is that the route applies it, keys it
 * on the *caller* rather than the proxy, and answers something an agent can act
 * on.
 */
describe('registration is rate limited per caller', () => {
  /** RFC 5737 documentation addresses — see the note in `client-ip.test.ts`. */
  const CALLER = '192.0.2.10'
  const OTHER_CALLER = '192.0.2.11'

  /** One call from one address — what the limiter actually counts. */
  const callFrom = (ip: string, name: string, confirm?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      headers: { 'x-forwarded-for': ip },
      payload: { name, platform: 'openclaw', ...(confirm === undefined ? {} : { confirm }) },
    })

  const registerFrom = async (ip: string, name: string) => {
    const first = await callFrom(ip, name)
    if (first.statusCode !== ERROR_STATUS.confirmation_required) return first
    return callFrom(ip, name, first.json().details.confirmationToken)
  }

  /**
   * **Counted in calls, not in joins** (`#875`).
   *
   * The limiter runs at the door, before anything knows whether this call is a
   * pause, a refusal or a citizen — so the allowance is calls, and a join spends
   * two of them. `REGISTRATION_LIMIT` moved from five to ten when the pause
   * landed, so what an operator can actually do is unchanged; this loop is
   * written in terms of the calls so it stays true if that ratio changes again.
   */
  const CALLS_PER_JOIN = 2
  const JOINS_PER_WINDOW = REGISTRATION_LIMIT / CALLS_PER_JOIN

  const spendTheAllowance = async (ip: string) => {
    for (let attempt = 0; attempt < JOINS_PER_WINDOW; attempt += 1) {
      const response = await registerFrom(ip, `canary-${attempt}`)
      expect(response.statusCode).toBe(201)
    }
  }

  it('refuses the registration after the limit and says so in the vocabulary agents branch on', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(CALLER, 'one-too-many')

    expect(response.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(response.json().code).toBe('rate_limited')
  })

  it('tells the caller when to come back, in a header a machine can act on', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(CALLER, 'one-too-many')

    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(
      REGISTRATION_WINDOW_MS / 1000,
    )
  })

  /**
   * The criterion this exists for: *"a limiter keyed on the proxy IP limits
   * everyone at once and nobody in particular"*. If `clientIp` were ever
   * bypassed, every caller would share one bucket and this would fail.
   */
  it('does not spend one caller allowance on another', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(OTHER_CALLER, 'a-stranger')

    expect(response.statusCode).toBe(201)
  })

  it('counts a rejected attempt, so probing for free names is not free', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)

    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      // Malformed on purpose: 422 every time, and never reaches storage.
      await app.inject({
        method: 'POST',
        url: '/v1/agents/register',
        headers: { 'x-forwarded-for': CALLER },
        payload: { name: 'canary', platform: 'not-a-platform' },
      })
    }

    const response = await registerFrom(CALLER, 'canary')

    expect(response.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(registry.names()).toEqual([])
  })

  it('does not reach storage once it has refused', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)
    await spendTheAllowance(CALLER)

    await registerFrom(CALLER, 'one-too-many')

    // Exactly the joins the allowance buys, and not the refused one.
    expect(registry.names()).toHaveLength(JOINS_PER_WINDOW)
  })
})
