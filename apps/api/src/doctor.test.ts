import { describe, expect, it } from 'vitest'
import {
  CALL_HOUR_MS,
  DoctorAnswerSchema,
  type AcademyProgress,
  type AgentId,
  type CallHour,
} from '@kolonie-ai/core'
import type { DoctorFeedbackInput } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { doctorAnswerFor } from './doctor.js'
import { FAKE_CALLER_IP, fakeColony } from './__fixtures__/colony/index.js'
import { fakeDoctorSource } from './__fixtures__/doctor.js'
import { connectedClient } from './__fixtures__/mcp.js'

const NOW = new Date('2026-08-04T00:00:00.000Z')
const ONE = '11111111-1111-4111-8111-111111111111' as AgentId
const TWO = '22222222-2222-4222-8222-222222222222' as AgentId

/** An hour, `n` hours before `NOW`. */
const bucket = (n: number, overrides: Partial<CallHour> = {}): CallHour => {
  const started = new Date(NOW.getTime() - n * CALL_HOUR_MS).toISOString()
  const calls = overrides.calls ?? 300

  return {
    routeKey: '/v1/tasks',
    hourStartedAt: started,
    calls,
    bytesOut: calls * 4_000,
    maxBytesOut: 8_000,
    ok: calls,
    clientErrors: 0,
    serverErrors: 0,
    firstAt: started,
    lastAt: started,
    ...overrides,
  }
}

/** A citizen that has passed something, so `stalled-arrival` is not in the way. */
const ESTABLISHED: AcademyProgress = {
  registeredAt: '2026-07-01T00:00:00.000Z',
  lastProgressAt: '2026-07-20T00:00:00.000Z',
  firstPassAt: '2026-07-02T00:00:00.000Z',
  skillsHeld: 4,
}

/**
 * `kolonie.doctor` and `GET /v1/doctor` (`#837`): a citizen can ask what it
 * looks like from here.
 *
 * The two rejection cases are the ones this file exists for. The first — that
 * an answer contains no figure belonging to anybody else — is the constraint the
 * whole surface is shaped by, and it is absolute with no operator override. The
 * second is that an unauthenticated call learns nothing, including whether any
 * citizen exists.
 */
describe('the doctor surface', () => {
  const looping = [4, 3, 2, 1].map((n) => bucket(n))

  describe('the answer', () => {
    it('reproduces a loop through the handler, with a larger interval than the one observed', async () => {
      const answer = await doctorAnswerFor(
        ONE,
        fakeDoctorSource({ [ONE]: looping }, { [ONE]: ESTABLISHED }),
        NOW,
      )

      const loop = answer.findings.find((finding) => finding.kind === 'polling-loop')
      expect(loop).toBeDefined()
      expect(loop?.nextAction).toBe('kolonie.wakeup')

      const observed = loop?.evidence.figures['observedIntervalSeconds'] ?? 0
      expect(loop?.retryAfterSeconds ?? 0).toBeGreaterThan(observed * 2)
    })

    it('answers a citizen with nothing wrong with a populated summary and no findings', async () => {
      const answer = await doctorAnswerFor(
        ONE,
        fakeDoctorSource({ [ONE]: [bucket(1, { calls: 4 })] }, { [ONE]: ESTABLISHED }),
        NOW,
      )

      expect(DoctorAnswerSchema.parse(answer)).toBeTruthy()
      expect(answer.findings).toEqual([])
      expect(answer.observed).toBe(true)
      expect(answer.calls).toBe(4)
      expect(answer.busiestRoutes[0]?.routeKey).toBe('/v1/tasks')
    })

    /**
     * *Nothing recorded yet* and *nothing wrong* are different facts, and a
     * citizen acts differently on them. An error or a silent empty object would
     * make the first indistinguishable from a broken endpoint.
     */
    it('answers a brand-new citizen with a well-formed answer that says so', async () => {
      const answer = await doctorAnswerFor(ONE, fakeDoctorSource(), NOW)

      expect(DoctorAnswerSchema.parse(answer)).toBeTruthy()
      expect(answer.observed).toBe(false)
      expect(answer.findings).toEqual([])
      expect(answer.calls).toBe(0)
    })

    /**
     * **A Doctor that diagnoses citizens for asking the Doctor is a bug.** A
     * citizen told to call this on every waking would accumulate exactly the
     * shape `polling-loop` looks for, on the one route the Colony asked it to
     * use.
     */
    it('does not diagnose a citizen for calling the doctor, or for waking up', async () => {
      const askingTheDoctor = [4, 3, 2, 1].map((n) => bucket(n, { routeKey: 'kolonie.doctor' }))
      const waking = [4, 3, 2, 1].map((n) => bucket(n, { routeKey: 'kolonie.wakeup' }))

      const answer = await doctorAnswerFor(
        ONE,
        fakeDoctorSource({ [ONE]: [...askingTheDoctor, ...waking] }, { [ONE]: ESTABLISHED }),
        NOW,
      )

      expect(answer.findings).toEqual([])
      // Still visible in the summary: the citizen should see what it called,
      // and only the *rules* are kept off it.
      expect(answer.calls).toBe(2_400)
      expect(answer.busiestRoutes.map((route) => route.routeKey).sort()).toEqual([
        'kolonie.doctor',
        'kolonie.wakeup',
      ])
    })

    it('bounds the window it reads', async () => {
      const answer = await doctorAnswerFor(ONE, fakeDoctorSource(), NOW)

      expect(Date.parse(answer.until) - Date.parse(answer.since)).toBe(72 * CALL_HOUR_MS)
    })
  })

  /**
   * **The rejection case.** The Trello card states it as *zeigt nur eigene
   * Daten, nie das Verhalten anderer Bürger*, and `kolonie-docs#324` records it
   * as point 3, absolute and with no operator override.
   */
  describe('what one citizen can see of another', () => {
    it('carries no route, count, byte figure or identifier belonging to anybody else', async () => {
      const source = fakeDoctorSource(
        {
          [ONE]: [bucket(1, { calls: 7, routeKey: '/v1/tasks' })],
          [TWO]: [bucket(1, { calls: 4_242, routeKey: '/v1/a-route-only-two-calls' })],
        },
        { [ONE]: ESTABLISHED, [TWO]: ESTABLISHED },
      )

      const answer = await doctorAnswerFor(ONE, source, NOW)
      const serialised = JSON.stringify(answer)

      expect(serialised).not.toContain(TWO)
      expect(serialised).not.toContain('/v1/a-route-only-two-calls')
      expect(serialised).not.toContain('4242')
      expect(answer.calls).toBe(7)
      // Including in the summary, and including when B is the only other
      // citizen in the fixture — which is the case where a flat store would
      // leak and a per-citizen one cannot.
      expect(answer.busiestRoutes).toEqual([{ routeKey: '/v1/tasks', calls: 7, bytesOut: 28_000 }])
    })
  })

  describe('through the HTTP door', () => {
    const colony = async () => {
      const base = fakeColony()
      const app = buildApp({
        ...base,
        doctor: fakeDoctorSource({}, {}),
      })
      await app.ready()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      return { app, apiKey: registered.response.credentials.apiKey }
    }

    it('answers the caller, and only ever the caller', async () => {
      const { app, apiKey } = await colony()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/doctor',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
      expect(DoctorAnswerSchema.parse(response.json())).toBeTruthy()
    })

    /**
     * **The second rejection case.** The refusal is the one every authenticated
     * route in this API sends — same status, same header, same body — so a
     * caller cannot learn from it whether any citizen exists.
     */
    it('refuses an unauthenticated call, revealing nothing', async () => {
      const { app } = await colony()

      const refused = await app.inject({ method: 'GET', url: '/v1/doctor' })
      const withABadKey = await app.inject({
        method: 'GET',
        url: '/v1/doctor',
        headers: { authorization: 'Bearer not-a-key' },
      })

      expect(refused.statusCode).toBe(401)
      expect(refused.headers['www-authenticate']).toBe('Bearer')
      expect(withABadKey.statusCode).toBe(401)
      expect(withABadKey.body).toBe(refused.body)
    })

    /**
     * A deployment that wired no source serves no route rather than an empty
     * answer. The fixture wires one by default — see `colony/agent.ts` — so this
     * takes it away explicitly, which is also the shape of the assertion: the
     * route's existence is a property of the dependency and of nothing else.
     */
    it('is absent where no source was wired', async () => {
      const { doctor: _unwired, ...withoutADoctor } = fakeColony()
      const app = buildApp(withoutADoctor)
      await app.ready()

      expect((await app.inject({ method: 'GET', url: '/v1/doctor' })).statusCode).toBe(404)
    })
  })

  describe('through the MCP door', () => {
    it('answers the same shape the HTTP route does', async () => {
      const base = fakeColony()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const { client, close } = await connectedClient(
        { ...base, doctor: fakeDoctorSource({ [registered.response.agent.id]: looping }, {}) },
        `Bearer ${registered.response.credentials.apiKey}`,
        registered.response.agent.id,
      )

      const result = await client.callTool({ name: 'kolonie.doctor', arguments: {} })
      await close()

      expect(DoctorAnswerSchema.parse(result.structuredContent)).toBeTruthy()
      const text = (result.content as { text: string }[])[0]?.text ?? ''
      expect(text).toContain('calls')
    })

    it('is not offered to a stranger, and not offered where no source was wired', async () => {
      const base = fakeColony()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const { doctor: _unwired, ...withoutADoctor } = base
      const stranger = await connectedClient({ ...base, doctor: fakeDoctorSource() })
      const unwired = await connectedClient(
        withoutADoctor,
        `Bearer ${registered.response.credentials.apiKey}`,
        registered.response.agent.id,
      )

      expect((await stranger.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'kolonie.doctor',
      )
      expect((await unwired.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'kolonie.doctor',
      )

      await Promise.all([stranger.close(), unwired.close()])
    })
  })

  /**
   * The return leg (`#1082`): a citizen saying whether a rule described anything
   * real. Everything here is about the two promises the description makes —
   * that answering changes nothing about the citizen, and that a second verdict
   * replaces the first rather than joining it.
   */
  describe('answering the doctor back', () => {
    const aCitizen = async (feedback: DoctorFeedbackInput[] = []) => {
      const base = fakeColony()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const { agent, credentials } = registered.response
      const connected = await connectedClient(
        { ...base, doctor: fakeDoctorSource({}, {}, {}, {}, undefined, feedback) },
        `Bearer ${credentials.apiKey}`,
        agent.id,
      )

      return { ...connected, base, agentId: agent.id, feedback }
    }

    it('records a verdict and says what it did with it', async () => {
      const { client, close, feedback, agentId } = await aCitizen()

      const result = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'wrong', note: 'I call it once a waking.' },
      })
      await close()

      expect(result.structuredContent).toMatchObject({
        kind: 'polling-loop',
        verdict: 'wrong',
        replaced: false,
      })
      expect(feedback).toEqual([
        { agentId, kind: 'polling-loop', verdict: 'wrong', note: 'I call it once a waking.' },
      ])
    })

    /**
     * The receipt is where the promise is checkable. A citizen weighing whether
     * to say *the rule is wrong* is deciding on the cost, and a tool that made
     * the claim in its description and went quiet in its answer would be asking
     * to be taken on trust at the one moment it need not be.
     */
    it('tells the citizen its standing did not move', async () => {
      const { client, close } = await aCitizen()

      const result = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'retry-storm', verdict: 'not-applicable' },
      })
      await close()

      const text = (result.content as { text: string }[])[0]?.text ?? ''
      expect(text).toContain('no reputation')
      expect(text).toContain('no attempt')
    })

    it('reports a second verdict about the same rule as a replacement', async () => {
      const { client, close, feedback } = await aCitizen()

      await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'wrong' },
      })
      const again = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'helpful' },
      })
      await close()

      expect(again.structuredContent).toMatchObject({ replaced: true, verdict: 'helpful' })
      expect(feedback).toHaveLength(1)
    })

    /**
     * **The rejection that must not be swallowed**, and the whole difference
     * from the consultation stamp beside it. That one is bookkeeping the citizen
     * did not ask for, so a failure is logged and the answer still goes out.
     * This one is the citizen's own request: a receipt saying *recorded* over a
     * write that threw would leave it believing the Colony holds an answer it
     * does not hold.
     */
    it('fails rather than reporting a write that did not happen', async () => {
      const base = fakeColony()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const source = fakeDoctorSource()
      const { client, close } = await connectedClient(
        {
          ...base,
          doctor: {
            ...source,
            recordFeedback: async () => {
              throw new Error('the verdict could not be stored')
            },
          },
        },
        `Bearer ${registered.response.credentials.apiKey}`,
        registered.response.agent.id,
      )

      const result = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'wrong' },
      })
      await close()

      expect(result.isError).toBe(true)
    })

    /**
     * The vocabulary is the rules' own. A kind no rule produces is refused at the
     * door rather than stored as a verdict about nothing, and a note that is only
     * whitespace is refused here as well as by the table — one door and one last
     * door, which is the same arrangement `#1082`'s storage tests assert.
     */
    it('refuses a kind, a verdict and a note the Colony has no meaning for', async () => {
      const { client, close, feedback } = await aCitizen()

      const kind = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'slow', verdict: 'wrong' },
      })
      const verdict = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'unhelpful' },
      })
      const note = await client.callTool({
        name: 'kolonie.doctor.feedback',
        arguments: { kind: 'polling-loop', verdict: 'wrong', note: '   ' },
      })
      await close()

      expect(kind.isError).toBe(true)
      expect(verdict.isError).toBe(true)
      expect(note.isError).toBe(true)
      expect(feedback).toEqual([])
    })

    /**
     * The same guard as the tool it answers, and asserted rather than assumed: a
     * Colony with no rollup produces no findings, and inviting a verdict on a
     * finding nobody was ever given is a question with no honest answer.
     */
    it('is absent wherever kolonie.doctor is', async () => {
      const base = fakeColony()
      const registered = await base.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const { doctor: _unwired, ...withoutADoctor } = base
      const stranger = await connectedClient({ ...base, doctor: fakeDoctorSource() })
      const unwired = await connectedClient(
        withoutADoctor,
        `Bearer ${registered.response.credentials.apiKey}`,
        registered.response.agent.id,
      )

      expect((await stranger.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'kolonie.doctor.feedback',
      )
      expect((await unwired.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'kolonie.doctor.feedback',
      )

      await Promise.all([stranger.close(), unwired.close()])
    })
  })

  describe('what it never does', () => {
    /**
     * The card's ordering is *understand, inform, then limit*, and this is the
     * inform. Asserted against the source's own surface rather than by reading
     * the handler: a seam that cannot name a method cannot acquire one by
     * accident.
     */
    it('is handed a source whose only writes are about the Doctor', () => {
      const reading = fakeDoctorSource()
      const writing = fakeDoctorSource({}, {}, {}, {}, async () => {})

      expect(Object.keys(reading).sort()).toEqual([
        'callHoursSince',
        'deprecatedRoutes',
        'progressOf',
        // `#840` added a fourth, and it is a **read** of what a runner wrote out
        // of band. Nothing on this seam asks a model for anything: that would
        // put the citizen surface behind a third party being up, which is the
        // one thing `#837` is built not to be.
        'proseFor',
        // `#1082` added the second write and it is required rather than
        // optional, so it is on the reading source too — there is no such thing
        // as a source that could not take a verdict. It is a write **about the
        // Doctor**: what a citizen made of a rule, which changes the rule's
        // standing with the Colony and nothing about the citizen's.
        'recordFeedback',
      ])

      // `#1081` added the first write, and it is the narrowest one there is: it
      // records that a citizen looked and nothing about what was found. Nothing
      // here decides anything, changes a standing or narrows what anybody may
      // do, so the surface is still the inform.
      expect(Object.keys(writing).sort()).toEqual([
        'callHoursSince',
        'deprecatedRoutes',
        'noteConsultation',
        'progressOf',
        'proseFor',
        'recordFeedback',
      ])
    })

    it('is unchanged by being called twice', async () => {
      const source = fakeDoctorSource({ [ONE]: looping }, { [ONE]: ESTABLISHED })

      expect(await doctorAnswerFor(ONE, source, NOW)).toEqual(
        await doctorAnswerFor(ONE, source, NOW),
      )
    })
  })
})

/**
 * The sentence beside the numbers (`#840`).
 *
 * The property worth testing here is the one the whole layer is built around:
 * the same fixture, run with prose and without, produces the same findings.
 * A gateway outage costs the Colony a sentence and never a finding, and this is
 * where that stops being a slogan.
 */
describe('the doctor surface, with and without a sentence', () => {
  const looping = [4, 3, 2, 1].map((n) => bucket(n))

  it('renders the same findings either way', async () => {
    const silent = await doctorAnswerFor(
      ONE,
      fakeDoctorSource({ [ONE]: looping }, { [ONE]: ESTABLISHED }),
      NOW,
    )
    const spoken = await doctorAnswerFor(
      ONE,
      fakeDoctorSource(
        { [ONE]: looping },
        { [ONE]: ESTABLISHED },
        {},
        {
          [ONE]: { 'polling-loop': 'You are calling one route every twelve seconds.' },
        },
      ),
      NOW,
    )

    expect(spoken.findings.map(({ prose: _sentence, ...rest }) => rest)).toEqual(
      silent.findings.map(({ prose: _sentence, ...rest }) => rest),
    )
    expect(silent.findings.every((finding) => finding.prose === null)).toBe(true)
    expect(spoken.findings.find((finding) => finding.kind === 'polling-loop')?.prose).toContain(
      'twelve seconds',
    )
  })

  /**
   * A sentence about a kind this citizen no longer has is not attached to a
   * different one. The join is on the kind, and a mismatch must produce an
   * absence rather than a sentence about the wrong finding.
   */
  it('attaches nothing when the stored sentence is about another kind', async () => {
    const answer = await doctorAnswerFor(
      ONE,
      fakeDoctorSource(
        { [ONE]: looping },
        { [ONE]: ESTABLISHED },
        {},
        {
          [ONE]: { 'stalled-arrival': 'You arrived and stopped.' },
        },
      ),
      NOW,
    )

    expect(answer.findings.every((finding) => finding.prose === null)).toBe(true)
  })

  it('answers with the findings when the sentences cannot be read at all', async () => {
    const source = fakeDoctorSource({ [ONE]: looping }, { [ONE]: ESTABLISHED })
    const broken = {
      ...source,
      proseFor: async () => {
        throw new Error('the sentences could not be read')
      },
    }

    const answer = await doctorAnswerFor(ONE, broken, NOW)

    expect(answer.findings.length).toBeGreaterThan(0)
    expect(answer.findings.every((finding) => finding.prose === null)).toBe(true)
  })
})

/**
 * Whether being told brings a citizen back (`#1081`).
 *
 * Announcing findings on waking has never been measured, so *the citizen was
 * told* and *the citizen looked* were the same fact in the record. Both doors
 * write, because a citizen that reads its answer over HTTP has consulted the
 * Doctor exactly as much as one that called the tool — and they are asserted
 * separately, because a shared helper is not evidence that both doors call it.
 *
 * **The rejection case is the one this block exists for.** A measurement that
 * can break the thing it measures is worse than no measurement: the write is
 * swallowed, and `kolonie.doctor` answers in full whatever the database does.
 */
describe('recording that a citizen consulted', () => {
  const CONSULTING = [4, 3, 2, 1].map((n) => bucket(n))

  /** A citizen, and a record of what the Doctor wrote about it looking. */
  const withARecorder = async (noteConsultation: (id: AgentId, at: Date) => Promise<void>) => {
    const base = fakeColony()
    const registered = await base.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const agentId = registered.response.agent.id
    const doctor = fakeDoctorSource({ [agentId]: CONSULTING }, {}, {}, {}, noteConsultation)

    return { base, doctor, agentId, apiKey: registered.response.credentials.apiKey }
  }

  it('records it through the MCP door, for the caller and nobody else', async () => {
    const consulted: { id: AgentId; at: Date }[] = []
    const { base, doctor, agentId, apiKey } = await withARecorder(async (id, at) => {
      consulted.push({ id, at })
    })

    const { client, close } = await connectedClient(
      { ...base, doctor },
      `Bearer ${apiKey}`,
      agentId,
    )
    const result = await client.callTool({ name: 'kolonie.doctor', arguments: {} })
    await close()

    expect(DoctorAnswerSchema.parse(result.structuredContent)).toBeTruthy()
    expect(consulted.map((row) => row.id)).toEqual([agentId])
    expect(consulted[0]?.at).toBeInstanceOf(Date)
  })

  /**
   * Asserted separately from the tool rather than through the shared helper.
   * The two doors having the same behaviour is the claim; a helper they both
   * *could* call is not evidence that they both do.
   */
  it('records it through the HTTP door as well', async () => {
    const consulted: AgentId[] = []
    const { base, doctor, agentId, apiKey } = await withARecorder(async (id) => {
      consulted.push(id)
    })

    const app = buildApp({ ...base, doctor })
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/v1/doctor',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    expect(consulted).toEqual([agentId])
  })

  /**
   * **The rejection case.** The write is the Colony measuring itself, and a
   * citizen asking what it looks like from here does not get an error because
   * the Colony's own bookkeeping failed.
   */
  it('answers in full when the write rejects, and says so in the log', async () => {
    const logged: string[] = []
    const { base, doctor, agentId, apiKey } = await withARecorder(async () => {
      throw new Error('the database went away')
    })

    const { client, close } = await connectedClient(
      { ...base, doctor, log: (message) => logged.push(message) },
      `Bearer ${apiKey}`,
      agentId,
    )
    const result = await client.callTool({ name: 'kolonie.doctor', arguments: {} })
    await close()

    expect(result.isError).toBeUndefined()
    expect(DoctorAnswerSchema.parse(result.structuredContent)).toBeTruthy()
    expect(logged).toContain('doctor.consultation.not-recorded')
  })

  /**
   * A deployment that wired no writer measures nothing and answers exactly as it
   * did before the column existed. That is the state every test above this file's
   * `#1081` block is in, and it has to stay a supported one rather than a
   * `TypeError` waiting for a deployment that skipped a migration.
   */
  it('answers a deployment that records nothing', async () => {
    const base = fakeColony()
    const registered = await base.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { client, close } = await connectedClient(
      { ...base, doctor: fakeDoctorSource({ [registered.response.agent.id]: CONSULTING }) },
      `Bearer ${registered.response.credentials.apiKey}`,
      registered.response.agent.id,
    )
    const result = await client.callTool({ name: 'kolonie.doctor', arguments: {} })
    await close()

    expect(result.isError).toBeUndefined()
    expect(DoctorAnswerSchema.parse(result.structuredContent)).toBeTruthy()
  })
})
