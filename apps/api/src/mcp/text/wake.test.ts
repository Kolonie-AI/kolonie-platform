import { describe, expect, it } from 'vitest'
import { looksEphemeralHost, type WakeChallenge } from '@kolonie-ai/core'
import { wakeChallengeAsText } from './wake.js'

/**
 * What a citizen is told at the moment it mints a wake challenge (`#585`).
 *
 * **Both endpoints proved at this rung by 2026-08-08 were tunnels** — an
 * `lhr.life` host and a `run.pin` one, 31 minutes apart. That is not two agents
 * making the same mistake; it is what clearing this rung normally looks like the
 * first time. So the tunnel sentence is about the ordinary case, not the edge
 * one, and the thing it must never become is a refusal.
 */
describe('the wake challenge text', () => {
  const challenge = (url: string): WakeChallenge => ({
    challengeId: '00000000-0000-4000-8000-000000000001',
    url,
    secret: 'not-a-real-secret',
    expiresAt: '2026-08-09T10:20:00.000Z',
  })

  it('says nothing about tunnels for an ordinary address', () => {
    const text = wakeChallengeAsText(challenge('https://agents.example.com/kolonie/wake'))

    expect(text).not.toContain('tunnel')
  })

  it('names the host and says the address will change, for a tunnel', () => {
    const text = wakeChallengeAsText(challenge('https://c7b9f4d5b06e22.lhr.life/kolonie/wake'))

    expect(text).toContain('c7b9f4d5b06e22.lhr.life')
    expect(text).toContain('tunnel')
  })

  /**
   * The mint still succeeds, which is the acceptance criterion and the whole
   * shape of the decision: a tunnel is a legitimate address, and refusing one
   * would lock out exactly the agents experimenting with the rung.
   */
  it('still hands over the secret and the instructions', () => {
    const text = wakeChallengeAsText(challenge('https://abc.trycloudflare.com/wake'))

    expect(text).toContain('not-a-real-secret')
    expect(text).toContain('What your handler must do:')
  })

  it('points at the read that answers it, rather than leaving a worry', () => {
    const text = wakeChallengeAsText(challenge('https://abc.ngrok-free.app/wake'))

    expect(text).toContain('kolonie.me')
    expect(text).toContain('Re-proving is free')
  })

  it('says nothing is held against the citizen for it', () => {
    const text = wakeChallengeAsText(challenge('https://abc.loca.lt/wake'))

    expect(text).toContain('nothing about it is held')
  })
})

describe('looksEphemeralHost', () => {
  it('recognises the services agents have actually used', () => {
    expect(looksEphemeralHost('c7b9f4d5b06e22.lhr.life')).toBe(true)
    expect(looksEphemeralHost('something.trycloudflare.com')).toBe(true)
    expect(looksEphemeralHost('x.ngrok-free.app')).toBe(true)
  })

  it('is case-insensitive, because a hostname is', () => {
    expect(looksEphemeralHost('C7B9F4.LHR.LIFE')).toBe(true)
  })

  /**
   * The rejection case, and the reason the match is on a label boundary: a host
   * that merely *contains* a service's name is not one of its tunnels, and
   * accusing it would put a false sentence in front of a citizen that did
   * everything right.
   */
  it('does not accuse a host that merely ends in the same letters', () => {
    expect(looksEphemeralHost('notlhr.life')).toBe(false)
    expect(looksEphemeralHost('myngrok.io')).toBe(false)
    expect(looksEphemeralHost('agents.example.com')).toBe(false)
  })
})
