import { describe, expect, it, vi } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type ImageCheck,
  type ImageConstraints,
  type Submission,
} from '@kolonie-ai/core'
import {
  RasterVerifier,
  type ImageChallenges,
  type ImageChallengeState,
  type VisionCheckResult,
  type VisionChecker,
} from './raster.js'
import { completePng } from './testing/png.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

/**
 * **A specification the Colony no longer mints, on purpose** (`#215`).
 *
 * `cube` was retired with the other two solids, and this fixture keeps it so the
 * whole suite runs against a specification issued before the rename. That is the
 * case worth protecting: a citizen holding a `cube` challenge was legitimately
 * given it, the row is still on its table, and verification may happen weeks
 * later. Refusing it as an unknown shape would fail an agent for holding exactly
 * what the Colony handed it — so the verifier reads retired shapes and the draw
 * never produces another one.
 */
const CONSTRAINTS: ImageConstraints = {
  background: 'green',
  shape: 'cube',
  shapeColor: 'red',
  position: 'top-left',
  secondary: 'a small star',
}

const CHALLENGE: ImageChallengeState = {
  constraints: CONSTRAINTS,
  prompt: 'Generate an image with a red cube on a green background.',
  expiresAt: '2026-07-31T13:00:00.000Z',
}

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'illustrator',
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
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:00:00.000Z',
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
  submittedAt: '2026-07-31T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
})

/**
 * A complete PNG of a given size.
 *
 * **This was a bare header until `#273`**, which is the defect in miniature: the
 * verifier read twenty-four bytes, declared the file good, and handed it to a
 * vendor's model that would not take it. A fixture that is only a header cannot
 * fail that way, so it never did.
 */
const png = completePng

const allTrue: ImageCheck = {
  backgroundCorrect: true,
  shapeCorrect: true,
  shapeColorCorrect: true,
  positionCorrect: true,
  secondaryCorrect: true,
}

const challenges = (state: ImageChallengeState | null): ImageChallenges => ({
  latest: async () => state,
})

const vision = (result: VisionCheckResult): VisionChecker => ({ check: async () => result })
const says = (check: Partial<ImageCheck>): VisionChecker =>
  vision({ outcome: 'checked', check: { ...allTrue, ...check }, model: 'a-model' })

function verify(options: {
  readonly payload?: Record<string, unknown>
  readonly challenge?: ImageChallengeState | null
  readonly vision?: VisionChecker
}) {
  return new RasterVerifier({
    challenges: challenges(options.challenge === undefined ? CHALLENGE : options.challenge),
    vision: options.vision ?? says({}),
  }).verify(submissionWith(options.payload ?? { image: png().toString('base64') }), { agent })
}

describe('RasterVerifier', () => {
  it('passes an image the model says matches all five', async () => {
    const result = await verify({})

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('red cube')
    expect(result.metadata).toMatchObject({ width: 512, height: 512, format: 'image/png' })
  })

  /**
   * An agent that fails needs to know which of the five to fix. "The image does
   * not match" tells it to regenerate blind, which is the failure mode the
   * per-constraint schema exists to avoid.
   */
  it('names the constraints that failed, not just that it failed', async () => {
    const result = await verify({ vision: says({ shapeColorCorrect: false }) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('the shape should be red')
    expect(result.evidence).not.toContain('the background should be')
    expect(result.metadata).toMatchObject({ failed: 1 })
  })

  it('renders the no-other-element constraint as the instruction it was', async () => {
    const result = await verify({
      challenge: { ...CHALLENGE, constraints: { ...CONSTRAINTS, secondary: 'none' } },
      vision: says({ secondaryCorrect: false }),
    })

    expect(result.evidence).toContain('no other element')
  })

  it('refuses an agent with no open specification, and says how to get one', async () => {
    const result = await verify({ challenge: null })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.image.challenge')
  })

  /**
   * The specification is read first, so an agent that never minted one is told
   * that rather than being told its PNG is the wrong shape.
   */
  it('checks for a specification before it looks at the payload', async () => {
    const result = await verify({ challenge: null, payload: {} })

    expect(result.evidence).toContain('No image specification')
  })

  it('refuses a payload carrying no image', async () => {
    const result = await verify({ payload: {} })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('base64')
  })

  it('refuses base64 that decodes to nothing', async () => {
    const result = await verify({ payload: { image: '!!!!' } })

    expect(result.status).toBe('fail')
  })

  /** The commonest thing to paste by accident. Stripping it beats failing on it. */
  it('accepts a data URL prefix rather than failing on it', async () => {
    const result = await verify({
      payload: { image: `data:image/png;base64,${png().toString('base64')}` },
    })

    expect(result.status).toBe('pass')
  })

  it('refuses bytes that are not an image, whatever the payload called them', async () => {
    const result = await verify({
      payload: {
        image: Buffer.from('<html>nice try</html>').toString('base64'),
        mimeType: 'image/png',
      },
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('not a PNG')
  })

  /**
   * **What a citizen needs in order to find a cut it cannot see** (`#340`).
   *
   * `#273` taught this verifier to say *your file ends early*, which was the
   * missing half then and is not enough now: a citizen hit it on 2026-08-05,
   * concluded the MCP transport was truncating its base64, and filed a defect
   * after fourteen attempts. Nothing the Colony said could have told it
   * otherwise, because the one number that separates *my transport cut it* from
   * *my encoder is broken* is how much arrived — and only the Colony has it.
   */
  it('says how much arrived when the image is not all there', async () => {
    const whole = png().toString('base64')
    const result = await verify({ payload: { image: whole.slice(0, 40) } })

    expect(result.status).toBe('fail')
    // The count is of the base64 the citizen held and can measure, not only of
    // the bytes it decoded to.
    expect(result.evidence).toContain('40 characters of base64')
    expect(result.evidence).toContain('if that is not what you sent')
    // `#1048` — the next step, not only the diagnosis: host the PNG.
    expect(result.evidence).toContain('imageUrl')
  })

  /**
   * A transport that injects noise must not become a CRC blame (`#1048`).
   *
   * `Buffer.from` would silently skip the `!` and hand a wrong buffer to the
   * PNG walk; the alphabet check refuses first and points at `imageUrl`.
   */
  it('refuses base64 with characters outside the alphabet before the PNG walk', async () => {
    const whole = png().toString('base64')
    const noisy = `${whole.slice(0, 10)}!${whole.slice(10)}`
    let asked = false
    const result = await verify({
      payload: { image: noisy },
      vision: {
        check: async () => {
          asked = true
          return { outcome: 'checked', check: allTrue, model: 'a-model' }
        },
      },
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('not well-formed base64')
    expect(result.evidence).toContain('imageUrl')
    expect(asked).toBe(false)
  })

  /**
   * The number is separated by thousands, because these are six-digit counts an
   * agent compares against its own by eye. `448884` and `481232` look alike.
   */
  it('groups a large count so two of them can be told apart', async () => {
    const result = await verify({ payload: { image: 'A'.repeat(120_000) } })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('120,000 characters of base64')
  })

  it('says how many characters arrived when nothing decodes at all', async () => {
    const result = await verify({ payload: { image: 'data:image/jpeg;base64,' } })

    expect(result.status).toBe('fail')
    // Exactly what one citizen sent on its seventh attempt: the prefix, and
    // nothing behind it. Being told "0 characters arrived" is what makes that
    // legible as *the data never got here* rather than as a bad image.
    expect(result.evidence).toContain('0 characters arrived')
  })

  it('refuses an image that is not square, before asking a model', async () => {
    let asked = false
    const result = await verify({
      payload: { image: png(1920, 1080).toString('base64') },
      vision: {
        check: async () => {
          asked = true
          return { outcome: 'checked', check: allTrue, model: 'a-model' }
        },
      },
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('square')
    // The whole reason the cheap checks run first: this rung costs money per
    // model call, and a 16:9 render should not spend one.
    expect(asked).toBe(false)
  })

  it('accepts a nearly-square image, since no generator is exact', async () => {
    const result = await verify({ payload: { image: png(1024, 1000).toString('base64') } })

    expect(result.status).toBe('pass')
  })

  /**
   * A model that was rate-limited or out of credit said nothing about the image.
   * Reporting that as "your image does not match" would fail an agent that did
   * the work, for our budget (#19).
   */
  it('waits rather than failing when no model could be asked', async () => {
    const result = await verify({
      vision: vision({ outcome: 'unavailable', reason: 'the model answered 429.' }),
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain("Colony's problem")
    // #253: a model we configured is our machinery, and nothing was watching.
    expect(result.evidence).toContain('kolonie.support.open')
  })

  /**
   * The other half of the same rule (`#217`). *Try again* and *this will never
   * work* must not produce the same behaviour: a refusal the vendor will repeat
   * is decided now, and decided in the citizen's favour.
   */
  describe('when the vendor refused the Colony’s own request', () => {
    const rejected = vision({
      outcome: 'rejected',
      reason: "the model refused the Colony's request with 400.",
      status: 400,
      body: '{"error":"invalid image"}',
    })

    it('stops rather than retrying, and does not fail the citizen', async () => {
      const result = await verify({ vision: rejected })

      // `timeout` and not `fail`: terminal for the submission, and
      // `recordVerdict` leaves the attempt open on it.
      expect(result.status).toBe('timeout')
      expect(result.evidence).toContain("your submission's fault")
      expect(result.evidence).toContain('does not count as an attempt')
    })

    it('records the vendor’s own answer, so the Colony can say why', async () => {
      const result = await verify({ vision: rejected })

      expect(result.metadata).toMatchObject({ vendorStatus: 400, vendorBody: expect.any(String) })
      expect(String(result.metadata?.['vendorBody'])).toContain('invalid image')
    })

    /**
     * The flag `recordVerdict` reads to keep the specification alive. Without
     * `challenge` the repair silently does not happen and the citizen is told in
     * writing that it did.
     */
    it('marks the verdict as the Colony’s fault, naming the specification to keep', async () => {
      const result = await verify({ vision: rejected })

      expect(result.metadata).toMatchObject({ colonyFault: true, challenge: 'image' })
    })
  })

  it('records which model decided, so a verdict can be traced to one', async () => {
    const result = await verify({})

    expect(result.metadata).toMatchObject({ model: 'a-model' })
  })

  it('refuses a URL that is not one', async () => {
    const result = await verify({ payload: { imageUrl: 'not a url' } })

    expect(result.status).toBe('fail')
  })

  it('refuses a non-http URL scheme', async () => {
    const result = await verify({ payload: { imageUrl: 'file:///etc/passwd' } })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('http')
  })

  /**
   * An address inside our own network is the submission's problem and is failed
   * outright — it must never verdict `pending`, which would have the Colony
   * retry an attempt on itself on a schedule until the task timed out.
   */
  it('fails an SSRF attempt rather than leaving it to be retried', async () => {
    const result = await verify({ payload: { imageUrl: 'http://127.0.0.1:5432/' } })

    expect(result.status).toBe('fail')
    expect(result.status).not.toBe('pending')
  })

  /**
   * `#401`: the refusal above is right about the case it was written for and had
   * been generalised past it. A citizen whose host blipped has not failed at
   * drawing, and charging it an attempt for somebody else's outage is what
   * `pending` exists to prevent.
   */
  describe('a URL the Colony could not reach (#401)', () => {
    /** A public IP literal, so the SSRF check passes without asking a resolver. */
    const REACHABLE = 'http://203.0.113.10/square.png'

    it('leaves a submission open when the host could not be reached', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))

      const result = await verify({ payload: { imageUrl: REACHABLE } })

      vi.unstubAllGlobals()

      expect(result.status).toBe('pending')
      expect(result.status).not.toBe('fail')
    })

    it('leaves a submission open when the host answered 502', async () => {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('bad gateway', { status: 502 })))

      const result = await verify({ payload: { imageUrl: REACHABLE } })

      vi.unstubAllGlobals()

      expect(result.status).toBe('pending')
    })

    it('still fails a URL that answered 404', async () => {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })))

      const result = await verify({ payload: { imageUrl: REACHABLE } })

      vi.unstubAllGlobals()

      expect(result.status).toBe('fail')
    })
  })
})
