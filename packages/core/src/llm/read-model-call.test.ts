import { describe, expect, it } from 'vitest'
import type { LogFields, LogLevel } from '../log/log.js'
import { readModelCall } from './read-model-call.js'

/** A log that keeps what it was told, so a warning can be asserted rather than assumed. */
function recordingLog(): {
  readonly lines: { level: LogLevel; message: string; fields: LogFields }[]
  readonly log: {
    info: (message: string, fields?: LogFields) => void
    warn: (message: string, fields?: LogFields) => void
    error: (message: string, fields?: LogFields) => void
  }
} {
  const lines: { level: LogLevel; message: string; fields: LogFields }[] = []
  const at =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields })
    }
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } }
}

/** A gateway-stamped response, which is how `routeOf` learns what answered. */
function gatewayResponse(): Response {
  return new Response('', { headers: { 'x-kolonie-route': 'gateway' } })
}

describe('reading a model call', () => {
  it('records the model, the route and the counts a provider reported', () => {
    const { lines, log } = recordingLog()

    const call = readModelCall(
      {
        model: 'vendor/model-that-answered',
        usage: { prompt_tokens: 308, completion_tokens: 5, total_tokens: 313 },
      },
      log,
      gatewayResponse(),
    )

    expect(call).toEqual({
      route: 'gateway',
      model: 'vendor/model-that-answered',
      tokens: { prompt: 308, completion: 5, total: 313 },
    })
    expect(lines.map((line) => line.fields['event'])).toEqual(['model.call.completed'])
  })

  /**
   * The whole reason this function exists (`#716`). The gateway wraps CLI
   * subscriptions, which bill nothing per token and report no `usage` — and until
   * 2026-08-11 that threw a `ZodError` out of a request the model had answered
   * correctly, failing the moderation the call was part of.
   */
  it('records a call whose provider reported no usage at all', () => {
    const { lines, log } = recordingLog()

    const call = readModelCall({ model: 'vendor/subscription-model' }, log, gatewayResponse())

    expect(call).toEqual({ route: 'gateway', model: 'vendor/subscription-model' })
    expect(call?.tokens).toBeUndefined()
    expect(lines.every((line) => line.level === 'info')).toBe(true)
  })

  it('leaves out a partial count rather than recording arithmetic nobody can check', () => {
    const { log } = recordingLog()

    const call = readModelCall(
      { model: 'vendor/model', usage: { prompt_tokens: 308 } },
      log,
      gatewayResponse(),
    )

    expect(call?.tokens).toBeUndefined()
    expect(call?.model).toBe('vendor/model')
  })

  it('answers nothing, and warns, when no model can be named', () => {
    const { lines, log } = recordingLog()

    const call = readModelCall(
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      log,
    )

    expect(call).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.fields['event']).toBe('model.call.unaccountable')
  })

  it('does not throw on a body that is not an object at all', () => {
    const { log } = recordingLog()

    expect(readModelCall(null, log)).toBeUndefined()
    expect(readModelCall('a paragraph where JSON was expected', log)).toBeUndefined()
  })

  it('reads OpenRouter, and the gateway attempt behind it, off a fallback response', () => {
    const { log } = recordingLog()

    const call = readModelCall(
      { model: 'vendor/model', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      log,
      new Response('', {
        headers: { 'x-kolonie-route': 'openrouter', 'x-kolonie-fallback-reason': 'timeout' },
      }),
    )

    expect(call?.route).toBe('openrouter')
    expect(call?.fallback).toEqual({ route: 'gateway', reason: 'timeout' })
  })
})
