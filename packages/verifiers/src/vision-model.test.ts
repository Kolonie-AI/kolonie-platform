import { describe, expect, it } from 'vitest'
import type { ImageConstraints } from '@kolonie-ai/core'

/** Only the parts of the request body these tests assert on. */
interface OpenRouterBody {
  readonly model: string
  readonly temperature: number
  readonly response_format: { readonly json_schema: { readonly strict: boolean } }
  readonly messages: ReadonlyArray<{
    readonly content: ReadonlyArray<{
      readonly text?: string
      readonly image_url?: { readonly url: string }
    }>
  }>
}
import { DEFAULT_VISION_MODEL, openRouterVision, visionPromptFor } from './vision-model.js'

const CONSTRAINTS: ImageConstraints = {
  background: 'green',
  shape: 'cube',
  shapeColor: 'red',
  position: 'top-left',
  secondary: 'a small star',
}

const IMAGE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

/** A `fetch` that answers one OpenRouter body and records what it was sent. */
function endpoint(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: OpenRouterBody }> = []

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    })

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

const answered = (content: unknown) => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
})

const allTrue = {
  backgroundCorrect: true,
  shapeCorrect: true,
  shapeColorCorrect: true,
  positionCorrect: true,
  secondaryCorrect: true,
  notes: '',
}

const check = (impl: typeof fetch, options: { readonly key?: string | undefined } = {}) =>
  openRouterVision('key' in options ? options.key : 'a-key', DEFAULT_VISION_MODEL, impl).check({
    image: IMAGE,
    format: 'image/png',
    constraints: CONSTRAINTS,
  })

describe('openRouterVision', () => {
  it('reads a well-formed answer as a check', async () => {
    const { impl } = endpoint(answered(allTrue))

    expect(await check(impl)).toMatchObject({
      outcome: 'checked',
      model: DEFAULT_VISION_MODEL,
      check: { backgroundCorrect: true, secondaryCorrect: true },
    })
  })

  it('sends the image as a data URL under the format that was sniffed', async () => {
    const { impl, calls } = endpoint(answered(allTrue))
    await check(impl)

    const content = calls[0]?.body.messages[0]?.content
    expect(content?.[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('sends every constraint to the model', async () => {
    const { impl, calls } = endpoint(answered(allTrue))
    await check(impl)

    const text = calls[0]?.body.messages[0]?.content[0]?.text ?? ''
    for (const value of Object.values(CONSTRAINTS)) {
      expect(text, `${value} never reached the model`).toContain(value)
    }
  })

  it('asks for a strict schema and no creativity', async () => {
    const { impl, calls } = endpoint(answered(allTrue))
    await check(impl)

    expect(calls[0]?.body.temperature).toBe(0)
    expect(calls[0]?.body.response_format.json_schema.strict).toBe(true)
  })

  /**
   * An unconfigured Colony must not fail agents for its own deploy. Same rule as
   * `httpGitHubReader` with a missing token.
   */
  it('answers unavailable with no key, rather than failing the agent', async () => {
    const { impl, calls } = endpoint(answered(allTrue))

    expect(await check(impl, { key: undefined })).toMatchObject({ outcome: 'unavailable' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['out of credit', 402],
    ['rate limited', 429],
    ['a bad day at the vendor', 503],
  ])('answers unavailable when the model is %s', async (_case, status) => {
    const { impl } = endpoint({ error: 'no' }, status)

    expect(await check(impl)).toMatchObject({ outcome: 'unavailable' })
  })

  it('answers unavailable when the endpoint cannot be reached', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    expect(await check(impl)).toMatchObject({ outcome: 'unavailable' })
  })

  it('answers unavailable when the reply is not JSON at all', async () => {
    const { impl } = endpoint({ choices: [{ message: { content: 'sure, looks fine to me' } }] })

    expect(await check(impl)).toMatchObject({ outcome: 'unavailable' })
  })

  /**
   * The important one. A reply missing a field must not read as `false` — that
   * would fail an honest agent because the Colony configured a model that does
   * not honour the schema.
   */
  it('answers unavailable for a partial reply, rather than reading it as failure', async () => {
    const { impl } = endpoint(answered({ backgroundCorrect: true, shapeCorrect: true }))

    expect(await check(impl)).toMatchObject({ outcome: 'unavailable' })
  })

  it('answers unavailable when there is no content at all', async () => {
    const { impl } = endpoint({ choices: [] })

    expect(await check(impl)).toMatchObject({ outcome: 'unavailable' })
  })
})

describe('the model it asks', () => {
  /**
   * Same hazard as the RPC endpoint, one variable over: Compose writes
   * `VISION_MODEL: ${VISION_MODEL:-}`, which is an empty string rather than
   * `undefined`, and a default parameter does not fire on it. Without this the
   * Colony would ask OpenRouter for a model called `""` on every submission.
   */
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('falls back to the default when the name is %s', async (_case, model) => {
    const { impl, calls } = endpoint(answered(allTrue))

    const result = await openRouterVision('a-key', model, impl).check({
      image: IMAGE,
      format: 'image/png',
      constraints: CONSTRAINTS,
    })

    expect(calls[0]?.body.model).toBe(DEFAULT_VISION_MODEL)
    expect(result).toMatchObject({ outcome: 'checked', model: DEFAULT_VISION_MODEL })
  })

  it('uses a model it was actually given', async () => {
    const { impl, calls } = endpoint(answered(allTrue))

    await openRouterVision('a-key', 'some/other-model', impl).check({
      image: IMAGE,
      format: 'image/png',
      constraints: CONSTRAINTS,
    })

    expect(calls[0]?.body.model).toBe('some/other-model')
  })
})

describe('visionPromptFor', () => {
  it('turns an absent secondary element into something a model can check', () => {
    const prompt = visionPromptFor({ ...CONSTRAINTS, secondary: 'none' })

    expect(prompt).toContain('no element other than the primary shape')
  })

  it('asks that a present secondary element be smaller than the primary shape', () => {
    expect(visionPromptFor(CONSTRAINTS)).toContain('clearly smaller')
  })
})
