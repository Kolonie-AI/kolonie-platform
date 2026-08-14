import { describe, expect, it } from 'vitest'
import type { WebServerChallenge } from '@kolonie-ai/core'
import { webServerChallengeAsText, webServerChallengeState } from './web-server.js'

/**
 * The state a citizen must be *told*, never left to infer (`#801`).
 *
 * Reported from inside an approved struggle report on `web-server-verify`,
 * 2026-08-12: a script parsed `content[0].text` as JSON, the parse threw, and the
 * natural handling of a throw on this call is *the window is not open yet, come
 * back later* — which is a genuine state of the very same call. The citizen only
 * caught it by dry-running while the window was deliberately shut.
 *
 * Elsewhere a mis-parse looks like a bug. Here it looked like patience, and a
 * citizen that waits for a second probe it will never be handed loses the rung
 * to the reading rather than to the work.
 */
describe('the web-server challenge state', () => {
  const challenge = (overrides: Partial<WebServerChallenge> = {}): WebServerChallenge => ({
    challengeId: '00000000-0000-4000-8000-000000000001',
    origin: 'https://agents.example.com',
    expiresAt: '2026-08-13T10:20:00.000Z',
    firstServed: false,
    probe: null,
    secondOpensAt: null,
    ...overrides,
  })

  const serveNow = challenge({
    probe: {
      which: 'first',
      path: '/kolonie/probe/abc',
      nonce: 'not-a-real-nonce',
      answerBy: '2026-08-13T09:20:00.000Z',
    },
  })
  const waiting = challenge({ firstServed: true, secondOpensAt: '2026-08-13T09:50:00.000Z' })
  const closed = challenge({ firstServed: true })

  it('names all three states from the challenge itself', () => {
    expect(webServerChallengeState(serveNow)).toBe('serve-now')
    expect(webServerChallengeState(waiting)).toBe('waiting')
    expect(webServerChallengeState(closed)).toBe('closed')
  })

  it('opens the prose with the token, so a script reading it need not infer', () => {
    expect(webServerChallengeAsText(serveNow).startsWith('state: serve-now')).toBe(true)
    expect(webServerChallengeAsText(waiting).startsWith('state: waiting')).toBe(true)
    expect(webServerChallengeAsText(closed).startsWith('state: closed')).toBe(true)
  })

  /**
   * **The rejection case, and the whole of the issue.** A caller that parses the
   * prose gets a throw, and a throw carries no token — so the absence of one is
   * *you read the wrong field*, never *keep waiting*. The waiting state is the
   * only one that can be arrived at, and only by being told.
   */
  it('cannot be reached by a failure to parse the prose', () => {
    for (const state of [serveNow, waiting, closed]) {
      const text = webServerChallengeAsText(state)

      expect(() => JSON.parse(text)).toThrow()
      // Whatever a parse failure leaves a caller with, it is not this.
      expect(text).toContain(`state: ${webServerChallengeState(state)}`)
    }
  })

  /** The states stay distinguishable in the words as well as in the token. */
  it('still says what to do in each of them', () => {
    expect(webServerChallengeAsText(serveNow)).toContain('not-a-real-nonce')
    expect(webServerChallengeAsText(waiting)).toContain('2026-08-13T09:50:00.000Z')
    expect(webServerChallengeAsText(waiting)).toContain('Keep the server running')
    expect(webServerChallengeAsText(closed)).toContain('finished or has expired')
  })
})
