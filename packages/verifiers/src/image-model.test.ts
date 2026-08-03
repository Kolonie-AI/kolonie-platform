import { describe, expect, it, vi } from 'vitest'
import {
  AgentIdSchema,
  drawSceneConstraints,
  sceneBindingPhrase,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type SceneCheck,
  type SceneConstraints,
  type Submission,
} from '@kolonie-ai/core'
import {
  ImageModelVerifier,
  type SceneChallenges,
  type SceneChallengeState,
  type SceneCheckResult,
  type SceneChecker,
} from './image-model.js'
import { openRouterSceneVision, scenePromptForModel } from './scene-vision-model.js'
import { completePng } from './testing/png.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const CONSTRAINTS: SceneConstraints = {
  subject: 'otter',
  count: 3,
  accessory: 'scarf',
  accessoryColor: 'red',
  companion: 'umbrella',
  companionColor: 'blue',
  setting: 'a snowy street',
  style: 'photorealistic',
}

const CHALLENGE: SceneChallengeState = {
  constraints: CONSTRAINTS,
  prompt: 'A photorealistic image of 3 otters in a snowy street.',
  expiresAt: '2026-08-02T13:00:00.000Z',
}

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'renderer',
    platform: 'other',
    operator: null,
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
    declaredRhythmHours: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-08-02T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
}

const submissionWith = (payload: Record<string, unknown>): Submission => ({
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload,
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-08-02T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
})

/**
 * A complete PNG of a given size.
 *
 * **This was a bare header until `#273`**: the verifier read twenty-four bytes,
 * declared the file good, and handed it to a vendor's model that would not take
 * it. A fixture that is only a header cannot fail that way, so it never did.
 */
const png = completePng

const allTrue: SceneCheck = {
  subjectCorrect: true,
  countCorrect: true,
  bindingCorrect: true,
  settingCorrect: true,
  styleCorrect: true,
  prohibitionCorrect: true,
}

const challenges = (state: SceneChallengeState | null): SceneChallenges => ({
  latest: async () => state,
})

const vision = (result: SceneCheckResult): SceneChecker => ({ check: async () => result })
const says = (check: Partial<SceneCheck>): SceneChecker =>
  vision({ outcome: 'checked', check: { ...allTrue, ...check }, model: 'a-model' })

function verify(options: {
  readonly payload?: Record<string, unknown>
  readonly challenge?: SceneChallengeState | null
  readonly vision?: SceneChecker
}) {
  const verifier = new ImageModelVerifier({
    challenges: challenges(options.challenge === undefined ? CHALLENGE : options.challenge),
    vision: options.vision ?? says({}),
  })

  return verifier.verify(submissionWith(options.payload ?? { image: png().toString('base64') }), {
    agent,
  })
}

describe('ImageModelVerifier', () => {
  it('answers to the rung it was built for', () => {
    expect(
      new ImageModelVerifier({ challenges: challenges(null), vision: says({}) }).taskType,
    ).toBe('image-model')
  })

  it('passes an image the model says has all six properties', async () => {
    const result = await verify({})

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('otter')
    expect(result.evidence).toContain('drive an image generator')
  })

  /**
   * **The rejection case per class the issue asks for, first of three.** A count
   * that came out wrong is the commonest way to lose this rung, and the whole
   * argument for asking the model six questions instead of one is that the
   * citizen is then told which to fix rather than told to start over.
   */
  it('fails a wrong count, and the evidence names the property', async () => {
    const result = await verify({ vision: says({ countCorrect: false }) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('count')
    expect(result.evidence).toContain('3')
  })

  it('names both objects and both colours when the binding failed', async () => {
    const result = await verify({ vision: says({ bindingCorrect: false }) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('scarf')
    expect(result.evidence).toContain('umbrella')
  })

  /**
   * **Second: a model answering a shape the schema does not recognise is the
   * Colony's problem, not the citizen's.** Reading a missing field as `false`
   * would fail an agent for our misconfiguration — and on this rung, for the
   * price of a render it already paid.
   */
  it('waits rather than failing when the model says nothing usable', async () => {
    const result = await verify({
      vision: vision({
        outcome: 'unavailable',
        reason: 'the model answered a shape the Colony does not recognise.',
      }),
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain("Colony's problem")
    // #253: same rule as the `raster` rung's, same helper.
    expect(result.evidence).toContain('kolonie.support.open')
  })

  /**
   * A refusal the vendor will repeat is decided now (`#217`), and decided in the
   * citizen's favour: `timeout` is terminal for the submission and leaves the
   * attempt open, so nothing here counts against the agent that paid to render.
   */
  it('stops on a refusal the vendor will repeat, without failing the citizen', async () => {
    const result = await verify({
      vision: vision({
        outcome: 'rejected',
        reason: "the model refused the Colony's request with 400.",
        status: 400,
        body: '{"error":"invalid image"}',
      }),
    })

    expect(result.status).toBe('timeout')
    expect(result.evidence).toContain("your submission's fault")
    expect(result.metadata).toMatchObject({
      colonyFault: true,
      challenge: 'scene',
      vendorStatus: 400,
    })
  })

  /**
   * **Third: an expired specification is refused before any model call.** The
   * storage read returns only unexpired rows, so `null` here is what an expiry
   * looks like from the verifier's side — and the assertion that matters is that
   * the vendor was never reached, because a model call for a challenge that no
   * longer exists is money spent on nothing.
   */
  it('refuses an expired specification without asking a model', async () => {
    const check = vi.fn()
    const result = await verify({ challenge: null, vision: { check } })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.scene.challenge')
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses a non-square image without asking a model', async () => {
    const check = vi.fn()
    const result = await verify({
      payload: { image: png(1024, 512).toString('base64') },
      vision: { check },
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('square')
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses bytes that are not an image the Colony can read', async () => {
    const result = await verify({ payload: { image: Buffer.from('not a png').toString('base64') } })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('could not be read')
  })

  it('says what to send when the submission carries neither field', async () => {
    const result = await verify({ payload: {} })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('imageUrl')
  })

  /**
   * Provenance is recorded and nothing branches on it. This asserts both halves:
   * the field is on the metadata, and an image without a manifest still passes.
   */
  it('records that the bytes carried no provenance box, and passes anyway', async () => {
    const result = await verify({})

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ c2pa: false })
  })
})

describe('the scene judge', () => {
  /**
   * The six properties have to reach the model, or the judge is answering about
   * a specification nobody was given. Asserted against the prompt the request
   * actually carries rather than against the helper alone.
   */
  it('puts every property in the prompt', () => {
    const prompt = scenePromptForModel(CONSTRAINTS)

    expect(prompt).toContain('otter')
    expect(prompt).toContain('3')
    expect(prompt).toContain('scarf')
    expect(prompt).toContain('red')
    expect(prompt).toContain('umbrella')
    expect(prompt).toContain('blue')
    expect(prompt).toContain('a snowy street')
    expect(prompt).toContain('photorealistic')
    expect(prompt).toContain('no text, letters or numbers')
  })

  /**
   * **The judge is asked about the sentence the agent was given, from the same
   * function** (`#247`). This prompt used to write the binding out for itself —
   * `worn or carried by` against `scenePromptFor`'s `wears or carries` — and two
   * copies of a phrase that must agree about one picture is how a citizen produces
   * exactly what it was asked for and is refused.
   *
   * Walking the draw rather than one fixed specification, because the phrasing now
   * varies with the subject and a single otter would exercise one branch of it.
   */
  it('asks about the binding in the words the agent was given', () => {
    for (let step = 0; step < 100; step += 1) {
      const constraints = drawSceneConstraints()

      expect(scenePromptForModel(constraints)).toContain(sceneBindingPhrase(constraints))
    }
  })

  it('sends the prompt and the image to the model it was configured with', async () => {
    // Typed as `fetch` rather than as a bare async function, so the recorded
    // call carries its arguments — the request body is what this test is about.
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ ...allTrue, notes: '' }) } }],
          }),
          { status: 200 },
        ),
    )

    const checker = openRouterSceneVision('a-key', 'a-vendor/a-model', fetchImpl)
    const result = await checker.check({
      image: new Uint8Array(png()),
      format: 'image/png',
      constraints: CONSTRAINTS,
    })

    expect(result.outcome).toBe('checked')

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      model: string
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }
    expect(body.model).toBe('a-vendor/a-model')
    expect(body.messages[0]?.content[0]?.text).toContain('exactly 3')
  })

  /**
   * Without a key the judge says it could not look, and the verifier turns that
   * into `pending`. An unconfigured Colony must never fail a citizen for its own
   * deploy — least of all on the rung the citizen paid to attempt.
   */
  it('is unavailable rather than negative when no key is configured', async () => {
    const result = await openRouterSceneVision(undefined).check({
      image: new Uint8Array(png()),
      format: 'image/png',
      constraints: CONSTRAINTS,
    })

    expect(result.outcome).toBe('unavailable')
  })

  it('is unavailable when the vendor answers something that is not the six booleans', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"verdict":"looks fine"}' } }] }),
          {
            status: 200,
          },
        ),
    )

    const result = await openRouterSceneVision('a-key', undefined, fetchImpl as typeof fetch).check(
      {
        image: new Uint8Array(png()),
        format: 'image/png',
        constraints: CONSTRAINTS,
      },
    )

    expect(result.outcome).toBe('unavailable')
  })

  /**
   * `#217`, on the rung where a retry loop is most expensive: an attempt here
   * cost the citizen a render, so a submission circling on a permanent refusal
   * spends someone else's budget as well as ours.
   */
  it('is rejected rather than unavailable when the vendor refuses the request', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid image' } }), { status: 400 }),
    )

    const result = await openRouterSceneVision('a-key', undefined, fetchImpl as typeof fetch).check(
      {
        image: new Uint8Array(png()),
        format: 'image/png',
        constraints: CONSTRAINTS,
      },
    )

    expect(result).toMatchObject({ outcome: 'rejected', status: 400 })
  })

  it('does not record the key it sent, even when the vendor quotes it back', async () => {
    const key = 'sk-or-v1-fedcba9876543210'
    let sent: Record<string, string> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), { status: 401 })
    }) as unknown as typeof fetch

    const result = await openRouterSceneVision(key, undefined, fetchImpl).check({
      image: new Uint8Array(png()),
      format: 'image/png',
      constraints: CONSTRAINTS,
    })

    // The key really was in the request, so the assertion below is about
    // redaction rather than about a request that never carried one.
    expect(sent['authorization']).toContain(key)
    expect(JSON.stringify(result)).not.toContain(key)
  })
})
