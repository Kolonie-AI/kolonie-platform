import { describe, expect, it } from 'vitest'
import {
  OPERATOR_MESSAGE_MAX_LENGTH,
  OPERATOR_MESSAGE_MIN_LENGTH,
  OpenOperatorRequestSchema,
  OperatorRequestAuthorSchema,
  looksLikeCredential,
} from './request.js'

/**
 * The credential refusal is the only logic in this module, and `#236` asks for it
 * to be enforced rather than requested — so the tests are about what it catches
 * and, just as importantly, what it lets through.
 *
 * A matcher that refuses ordinary sentences would close the channel it is
 * protecting, and the citizen has nowhere else to go.
 */
describe('looksLikeCredential', () => {
  it('catches a labelled secret, in the forms a person actually writes', () => {
    for (const text of [
      'password: hunter2',
      'The password is hunter2',
      'api_key = abc123def456',
      'api key -> abc123def456',
      'access-token: abcdefgh',
      'Bearer: eyJhbc',
      'totp secret: JBSWY3DPEHPK3PXP',
      'seed phrase: alpha bravo charlie delta',
      'Passphrase → correct horse',
    ]) {
      expect(looksLikeCredential(text), text).toBe(true)
    }
  })

  it('catches a private key block, a TOTP URI and a vendor-prefixed key', () => {
    for (const text of [
      'here you go\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n',
      '-----BEGIN RSA PRIVATE KEY-----',
      'scan this: otpauth://totp/X:me?secret=JBSWY3DPEHPK3PXP',
      'use sk-abcdefghijklmnopqrstuvwx for the calls',
      'the token is ghp_abcdefghijklmnopqrstuvwxyz01',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdef',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      expect(looksLikeCredential(text), text).toBe(true)
    }
  })

  it('catches a long unbroken high-entropy run even with no label at all', () => {
    // 40 characters, letters and digits, no separators. The shape a pasted key has
    // when whoever pasted it did not say what it was.
    expect(looksLikeCredential('a7Kd93LsPq2mZx8vRt4Nb6Yh1Wc5Ge0Uj7Fi3Ao9')).toBe(true)
  })

  /**
   * The half that decides whether this channel is usable. Every string here is
   * something a real exchange contains, and a matcher that refused any of them
   * would be worse than no matcher: the citizen would be told to use the vault for
   * a message that has no secret in it.
   */
  it('lets ordinary messages through, including ones that talk about credentials', () => {
    for (const text of [
      'I need a GitHub account. Could you create one and put the token in my vault?',
      'The handle @kolonie-one was taken, so I used @kolonie-one-ai instead.',
      'I could not remember the password, so I have asked you rather than guessing.',
      'Please do not publish anything this week.',
      'The account is made. I put the credential in the vault as you asked.',
      'The verifier wants a page at https://example.com/.well-known/kolonie-proof.txt',
      'My submission id is 3f2504e0-4f89-11d3-9a0c-0305e82c3301 if that helps.',
      'Rate limited for 3600 seconds, so I will try again tomorrow.',
    ]) {
      expect(looksLikeCredential(text), text).toBe(false)
    }
  })

  it('does not read a uuid or a URL as a key, which is what the length bound risks', () => {
    expect(looksLikeCredential('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false)
    expect(looksLikeCredential('https://github.com/Kolonie-AI/kolonie-platform/issues/236')).toBe(
      false,
    )
    // Thirty-one characters of letters only — a long word, not a key.
    expect(looksLikeCredential('abcdefghijklmnopqrstuvwxyzabcde')).toBe(false)
  })
})

describe('OpenOperatorRequestSchema', () => {
  it('requires a task, because a request that belongs to nothing is refused', () => {
    const parsed = OpenOperatorRequestSchema.safeParse({ body: 'I am blocked, please help.' })
    expect(parsed.success).toBe(false)
  })

  it('holds the message between its bounds', () => {
    const taskId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

    expect(
      OpenOperatorRequestSchema.safeParse({ taskId, body: 'x'.repeat(OPERATOR_MESSAGE_MIN_LENGTH) })
        .success,
    ).toBe(true)
    expect(OpenOperatorRequestSchema.safeParse({ taskId, body: 'x' }).success).toBe(false)
    expect(
      OpenOperatorRequestSchema.safeParse({
        taskId,
        body: 'x'.repeat(OPERATOR_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })
})

describe('OperatorRequestAuthorSchema', () => {
  /**
   * The attribution rule is the whole reason this is stored rather than inferred.
   * A third value — `colony` — would be the mistake to guard against: the Colony
   * does not write into this channel, and a value for it would invite text that
   * arrives at a citizen carrying the Colony's authority without the Colony
   * having said it.
   */
  it('has exactly two authors, and the Colony is not one of them', () => {
    expect(OperatorRequestAuthorSchema.options).toEqual(['citizen', 'operator'])
  })
})
