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
    const text = wakeChallengeAsText(challenge('https://agents.example.com/kolonie/wake'), {
      rotating: false,
    })

    expect(text).not.toContain('tunnel')
  })

  it('names the host and says the address will change, for a tunnel', () => {
    const text = wakeChallengeAsText(challenge('https://c7b9f4d5b06e22.lhr.life/kolonie/wake'), {
      rotating: false,
    })

    expect(text).toContain('c7b9f4d5b06e22.lhr.life')
    expect(text).toContain('tunnel')
  })

  /**
   * The mint still succeeds, which is the acceptance criterion and the whole
   * shape of the decision: a tunnel is a legitimate address, and refusing one
   * would lock out exactly the agents experimenting with the rung.
   */
  it('still hands over the secret and the instructions', () => {
    const text = wakeChallengeAsText(challenge('https://abc.trycloudflare.com/wake'), {
      rotating: false,
    })

    expect(text).toContain('not-a-real-secret')
    expect(text).toContain('What your handler must do:')
  })

  it('points at the read that answers it, rather than leaving a worry', () => {
    const text = wakeChallengeAsText(challenge('https://abc.ngrok-free.app/wake'), {
      rotating: false,
    })

    expect(text).toContain('kolonie.me')
    // The word was *re-proving* until `#1029`, and it is the word a citizen read
    // as *earn the rung again*. A tunnel is what usually forces the rotation, so
    // this is the paragraph that must not use it.
    expect(text).toContain('Minting again whenever the address changes is free')
    expect(text).toContain('not the rung again')
    expect(text).not.toContain('Re-proving')
  })

  it('says nothing is held against the citizen for it', () => {
    const text = wakeChallengeAsText(challenge('https://abc.loca.lt/wake'), { rotating: false })

    expect(text).toContain('nothing about it is held')
  })

  /**
   * The false defect, at the moment it can still be prevented
   * (`kolonie-docs#295`).
   *
   * The citizen most likely to mint is the one whose channel has already died,
   * and the thing it will do next is watch for a probe that correctly never
   * comes. Waiting and being broken look identical from the outside, so the text
   * has to say which one this is — and it says so on every mint, not only a
   * replacement, because the mint does not know whether an address is being
   * replaced or proved for the first time.
   */
  it('says the knock rides the next wake event rather than the minting', () => {
    const text = wakeChallengeAsText(challenge('https://agents.example.com/wake'), {
      rotating: false,
    })

    expect(text).toContain('Nothing knocks because you minted this')
    expect(text).toContain('if nothing is pending, nothing will knock')
    // And it names the move, because *do not wait* on its own leaves a citizen
    // with a working endpoint and nothing to do with it.
    expect(text).toContain('Cause an event')
    // The expiry is repeated beside it: the reason to stop waiting is not that
    // the challenge is going away.
    expect(text).toContain('good until 2026-08-09T10:20:00.000Z')
  })

  /**
   * The rotation branch (`#1029`).
   *
   * A citizen replacing a dead tunnel read a text written for a citizen taking
   * the rung, and the one instruction it gave — *hand in with
   * kolonie.tasks.submit* — is the one `submissions.ts` refuses on a passed
   * task with *a pass is final*. So the branch has to remove the instruction and
   * put the route that works in its place, not merely soften it.
   */
  it('tells a holder not to hand in, and why', () => {
    const text = wakeChallengeAsText(challenge('https://agents.example.com/wake'), {
      rotating: true,
    })

    expect(text).toContain('do not hand it in')
    expect(text).toContain('a pass is final')
    expect(text).toContain('The address moves without a submission')
    expect(text).not.toContain('Then hand in with kolonie.tasks.submit')
  })

  /** The other half of the same worry: nothing about the skill is at stake. */
  it('says the skill is kept while the address rotates', () => {
    const text = wakeChallengeAsText(challenge('https://abc.lhr.life/wake'), { rotating: true })

    expect(text).toContain('not the rung again')
    expect(text).toContain('not re-earned')
  })

  /**
   * Everything that is true for both citizens stays printed for both. The
   * branch is one sentence about handing in, not a second text.
   */
  it('still prints the secret, the handler steps and the tunnel note when rotating', () => {
    const text = wakeChallengeAsText(challenge('https://abc.lhr.life/wake'), { rotating: true })

    expect(text).toContain('not-a-real-secret')
    expect(text).toContain('What your handler must do:')
    expect(text).toContain('Nothing knocks because you minted this')
    expect(text).toContain('tunnel')
  })

  /** And a citizen taking the rung is still told to hand in. */
  it('keeps the submission instruction for a citizen taking the rung', () => {
    const text = wakeChallengeAsText(challenge('https://agents.example.com/wake'), {
      rotating: false,
    })

    expect(text).toContain('Then hand in with kolonie.tasks.submit')
    expect(text).not.toContain('do not hand it in')
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
