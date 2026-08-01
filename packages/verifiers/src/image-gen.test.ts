import { describe, expect, it } from 'vitest'
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
  ImageGenVerifier,
  type ImageChallenges,
  type ImageChallengeState,
  type VisionCheckResult,
  type VisionChecker,
} from './image-gen.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

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
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
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
})

/** A PNG header of a given size. Only the header is ever read. */
function png(width = 512, height = 512): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)

  return bytes
}

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
  return new ImageGenVerifier({
    challenges: challenges(options.challenge === undefined ? CHALLENGE : options.challenge),
    vision: options.vision ?? says({}),
  }).verify(submissionWith(options.payload ?? { image: png().toString('base64') }), { agent })
}

describe('ImageGenVerifier', () => {
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
})
