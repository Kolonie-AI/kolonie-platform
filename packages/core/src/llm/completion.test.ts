import { describe, expect, it } from 'vitest'
import {
  COMPLETION_TRUNCATED,
  TruncatedCompletion,
  chatRequestBody,
  throwIfTruncated,
} from './completion.js'

/**
 * A reply cut off at a ceiling is a failed call (`#1694`).
 *
 * The output ceiling is gone, so nothing in this repository knows what the
 * ceiling was — the gateway may impose one no constant here can see. What is
 * always visible is `finish_reason`, and a truncated answer is well-formed:
 * accepted, it is a verdict nobody finished writing.
 */
describe('a truncated completion', () => {
  const truncated = { choices: [{ message: { content: 'half a ver' }, finish_reason: 'length' }] }

  it('throws rather than returning an answer', () => {
    expect(() => throwIfTruncated(truncated)).toThrow(TruncatedCompletion)
  })

  it('carries a stable code an agent can branch on', () => {
    try {
      throwIfTruncated(truncated)
      expect.unreachable('a truncated reply must not return')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(TruncatedCompletion)
      expect((thrown as TruncatedCompletion).code).toBe(COMPLETION_TRUNCATED)
      expect(COMPLETION_TRUNCATED).toBe('completion_truncated')
    }
  })

  /**
   * Interrupted before the first character is the same failure as interrupted
   * halfway: the ceiling went on reasoning and nothing was written.
   */
  it('throws when the ceiling went entirely on reasoning', () => {
    expect(() => throwIfTruncated({ choices: [{ message: {}, finish_reason: 'length' }] })).toThrow(
      TruncatedCompletion,
    )
  })

  it('lets a complete reply through', () => {
    expect(() =>
      throwIfTruncated({ choices: [{ message: { content: 'a verdict' }, finish_reason: 'stop' }] }),
    ).not.toThrow()
  })

  /**
   * A reply that says nothing about why it stopped is not this failure. It is
   * handled by whatever the caller already does with a missing content field,
   * and reading it as truncation would attribute a cause nobody measured.
   */
  it('says nothing about a reply that named no finish reason', () => {
    expect(() => throwIfTruncated({ choices: [{ message: { content: 'x' } }] })).not.toThrow()
    expect(() => throwIfTruncated({})).not.toThrow()
    expect(() => throwIfTruncated(null)).not.toThrow()
  })
})

/**
 * `"stream": false` is set explicitly wherever a reply is parsed as JSON
 * (`#1694`).
 *
 * Measured 2026-08-25: omitting the field yields `text/event-stream`, so
 * `JSON.parse` fails on an HTTP 200 — a failure that reads as a broken key
 * rather than as a wrong request.
 */
describe('the request body a caller sends', () => {
  it('asks for a whole response and not a stream', () => {
    expect(chatRequestBody({ model: '@preset/tier-2', messages: [] })).toMatchObject({
      stream: false,
    })
  })

  it('sends the model string exactly as the caller asked, with nothing added', () => {
    expect(chatRequestBody({ model: '@preset/tier-1', messages: [] }).model).toBe('@preset/tier-1')
  })

  /**
   * Unset means the field is absent from the body entirely, not a default
   * number a later reader would mistake for a considered limit.
   */
  it('omits max_tokens when no operator ceiling is set', () => {
    const body = chatRequestBody({ model: '@preset/tier-3', messages: [] })
    expect('max_tokens' in body).toBe(false)
  })

  it('carries max_tokens when an operator set a ceiling', () => {
    const body = chatRequestBody({ model: '@preset/tier-3', messages: [], maxTokens: 4000 })
    expect(body['max_tokens']).toBe(4000)
  })

  it('keeps every other field the caller passed', () => {
    const body = chatRequestBody({
      model: '@preset/tier-2',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    expect(body).toMatchObject({
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: false,
    })
  })
})
