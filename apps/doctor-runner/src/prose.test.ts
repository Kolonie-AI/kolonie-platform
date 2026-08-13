import { describe, expect, it, vi } from 'vitest'
import type { Finding, Gateway, Log } from '@kolonie-ai/core'
import { PROSE_MAX_LENGTH, gatewayProse, noProse, promptFor } from './prose.js'

/**
 * A gateway that answers, so nothing here needs a network or a key that works.
 *
 * The base URL is a value the test invents rather than a host of ours — §9 keeps
 * host names out of every committed file, tests included, and a gateway a test
 * points at is exactly the kind of literal that gets copied into a comment
 * somewhere real.
 */
const GATEWAY: Gateway = {
  baseUrl: 'https://gateway.invalid/v1',
  apiKey: 'not-a-key',
  model: 'a-model-the-repository-does-not-name',
}

const answering = (text: string | null, status = 200) =>
  vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: { message: 'upstream said no' } }), { status }),
  )

const aFinding = (overrides: Partial<Finding> = {}): Finding => ({
  kind: 'polling-loop',
  severity: 'serious',
  scope: 'agent',
  subject: '11111111-1111-4111-8111-111111111111',
  evidence: {
    routeKeys: ['/v1/tasks'],
    figures: { hours: 30, calls: 8_790, callsPerHour: 293 },
  },
  confidence: 0.9,
  recommendation: 'poll-less-often',
  retryAfterSeconds: 1_200,
  since: '2026-08-01T00:00:00.000Z',
  until: '2026-08-02T06:00:00.000Z',
  ...overrides,
})

/**
 * The prose layer (`#840`): the model writes and decides nothing.
 *
 * The two rejection cases are what this file exists for. The first is that a
 * finding cannot carry free text into the prompt — which is `#838`'s refusal of
 * free text in stored evidence, seen from the end where it would do damage. The
 * second is that a gateway answering 500 costs a sentence and never a finding,
 * and that the log line says the status and nothing that could carry a key.
 */
describe('the doctor’s prose', () => {
  it('asks the gateway and returns what it said', async () => {
    const fetchImpl = answering('You are calling one route every twelve seconds.')
    const writer = gatewayProse(GATEWAY, { fetchImpl })

    expect(await writer.describe(aFinding())).toBe(
      'You are calling one route every twelve seconds.',
    )
    expect(writer.available).toBe(true)
    expect(writer.model).toBe(GATEWAY.model)
  })

  /**
   * **The rejection case.** The prompt builder takes the typed `Finding`, so
   * there is no parameter through which a string could arrive — and therefore no
   * path from a stored column to a model's instructions. Asserted on what the
   * builder produces rather than on what the caller believes it produces.
   */
  describe('what can reach the prompt', () => {
    it('is built from the structured fields and carries nothing else', () => {
      const prompt = promptFor(aFinding())

      expect(prompt).toContain('kind: polling-loop')
      expect(prompt).toContain('callsPerHour: 293')
      expect(prompt).toContain('/v1/tasks')
      // The citizen is not in it. A sentence addressed to *you* needs no name,
      // and an identifier in a prompt is an identifier at a third party.
      expect(prompt).not.toContain('11111111-1111-4111-8111-111111111111')
    })

    /**
     * Every line of the prompt comes from a typed field, so the only strings in
     * it are the rules' own vocabulary and route keys. A figure that somehow
     * held text would still be rendered as a figure — and `#838` refuses to
     * store one, which is the other half of the same guarantee.
     */
    it('renders every figure as its own name and value, and nothing free-form', () => {
      const prompt = promptFor(
        aFinding({ evidence: { routeKeys: ['/v1/tasks'], figures: { hours: 3 } } }),
      )

      const figures = prompt.split('\n').filter((line) => line.startsWith('  '))
      expect(figures).toEqual(['  hours: 3'])
    })
  })

  describe('when the gateway will not answer', () => {
    /**
     * **The second rejection case.** The pass completes, the diagnosis is stored
     * with `prose: null`, and the log carries the status and the message — never
     * the key, the host, or the prompt. An error body from a provider can echo
     * the request back, and the request carries the key.
     */
    it('answers with no sentence and logs the status and nothing else', async () => {
      const warn = vi.fn<(message: string, fields?: Record<string, unknown>) => void>()
      const writer = gatewayProse(GATEWAY, { fetchImpl: answering(null, 500), log: logWith(warn) })

      expect(await writer.describe(aFinding())).toBeNull()

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('500'),
        expect.objectContaining({ event: 'doctor.prose.refused', reason: 'status' }),
      )
      const said = JSON.stringify(warn.mock.calls)
      expect(said).not.toContain(GATEWAY.apiKey)
      expect(said).not.toContain(GATEWAY.baseUrl)
      expect(said).not.toContain('callsPerHour')
    })

    it('answers with no sentence when the transport fails', async () => {
      const writer = gatewayProse(GATEWAY, {
        fetchImpl: vi.fn(async () => {
          throw new Error('econnrefused')
        }),
      })

      expect(await writer.describe(aFinding())).toBeNull()
    })
  })

  /**
   * An empty completion is what a model returns when it ran out of room
   * mid-sentence; an over-long one is a sentence no surface can show. Both are
   * failures rather than things to store — a truncated sentence stopping
   * mid-clause reads as a defect in the Colony.
   */
  describe('what is not worth storing', () => {
    it('refuses an empty completion', async () => {
      const writer = gatewayProse(GATEWAY, { fetchImpl: answering('   ') })

      expect(await writer.describe(aFinding())).toBeNull()
    })

    it('refuses an over-long one rather than truncating it', async () => {
      const writer = gatewayProse(GATEWAY, {
        fetchImpl: answering('x'.repeat(PROSE_MAX_LENGTH + 1)),
      })

      expect(await writer.describe(aFinding())).toBeNull()
    })

    it('accepts one exactly at the bound', async () => {
      const writer = gatewayProse(GATEWAY, { fetchImpl: answering('x'.repeat(PROSE_MAX_LENGTH)) })

      expect((await writer.describe(aFinding()))?.length).toBe(PROSE_MAX_LENGTH)
    })
  })

  /**
   * A deployment that wired no gateway asks nothing, ever. Every diagnosis is
   * stored complete and silent, which every surface below treats as an answer
   * rather than as a half-written one.
   */
  it('asks nothing when no gateway was configured', async () => {
    expect(noProse.available).toBe(false)
    expect(await noProse.describe(aFinding())).toBeNull()
  })

  /**
   * **No committed file names a model.** The slug arrives in configuration and is
   * written onto the diagnosis row for audit — the database is not the
   * repository, and `#207` is about the repository.
   */
  it('names no model of its own', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(fileURLToPath(new URL('./prose.ts', import.meta.url)), 'utf8')

    /**
     * A provider slug is `vendor/model` in a quoted string. Media types are the
     * one shape that looks like one and is not, so they are excluded by name
     * rather than by loosening the pattern — a check that had to be loosened
     * once has to be loosened again.
     */
    const slugs = [...source.matchAll(/['"]([a-z0-9-]+\/[a-z0-9.-]+)['"]/g)]
      .map((match) => match[1] as string)
      .filter((slug) => !slug.startsWith('application/') && !slug.startsWith('text/'))

    expect(slugs).toEqual([])
  })
})

const logWith = (warn: (message: string, fields?: Record<string, unknown>) => void): Log => ({
  info: vi.fn(),
  warn,
  error: vi.fn(),
})
