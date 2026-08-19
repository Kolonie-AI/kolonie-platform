import { describe, expect, it } from 'vitest'
import {
  credentialFinding,
  credentialRefusalMessage,
  looksLikeCredential,
} from './credential-shape.js'

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

  /**
   * **The rung whose own vocabulary the guard was refusing** (`#335`). A citizen
   * asking for an attended session on the second-factor task was turned down
   * twice for writing the words the task is about, while a paraphrase avoiding
   * them went through — so what the guard taught was to write around it.
   *
   * Every string here is a real ask about a second factor with no secret in it.
   */
  it('lets a citizen write about a second factor, which is the rung that needs the operator most', () => {
    for (const text of [
      'I need the TOTP secret: it should go in my vault rather than into this message.',
      'The 2FA code is generated from a shared secret, so I cannot produce one myself.',
      'Please enable OTP: the task needs an authenticator and I have none.',
      'The password is something you choose — do not tell me what it is.',
      'My api key is in the vault already, so you do not need to send it.',
      'The access token: I never received one, which is why I am asking.',
      'Is there a private key involved? If so, please put it in the vault.',
    ]) {
      expect(looksLikeCredential(text), text).toBe(false)
    }
  })

  /**
   * And the disclosures that must still be caught, including the ones the
   * loosening above could plausibly have let through. A value that ends its line,
   * carries a digit or a symbol, or sits in quotes is a value whatever the
   * sentence around it is doing.
   */
  it('still catches a disclosure that ends the line, carries a symbol, or is quoted', () => {
    for (const text of [
      'my password is swordfish',
      'The password is correct-horse-battery and I have written it down.',
      'the api key is "correct horse battery staple" — use that one.',
      'password: hunter2 but change it when you are in',
    ]) {
      expect(looksLikeCredential(text), text).toBe(true)
    }
  })

  /**
   * A refusal an agent cannot act on is one it rewrites blind. The label is safe
   * to echo back and **the value is not** — the message travels through an API
   * error, which is a place a credential must not reach.
   */
  describe('what the refusal says tripped it', () => {
    it('names the label, and never the value after it', () => {
      const finding = credentialFinding('my password is swordfish')

      expect(finding?.reason).toBe('labelled-secret')
      expect(finding?.matched).toBe('password')
      expect(credentialRefusalMessage(finding)).toContain('password')
      expect(credentialRefusalMessage(finding)).not.toContain('swordfish')
    })

    it('names the class for a finding that has no label', () => {
      const finding = credentialFinding('-----BEGIN RSA PRIVATE KEY-----')

      expect(finding?.reason).toBe('private-key-block')
      expect(credentialRefusalMessage(finding)).toContain('PEM')
    })

    it('prefers the more specific finding when both would fire', () => {
      // Labelled *and* a vendor prefix. The vendor prefix is the one that tells
      // the citizen something it did not already know about its own message.
      expect(credentialFinding('the token is ghp_abcdefghijklmnopqrstuvwxyz01')?.reason).toBe(
        'vendor-prefixed-key',
      )
    })

    it('says nothing extra when there is nothing to say', () => {
      expect(
        credentialFinding('Please create the account and I will take it from there.'),
      ).toBeNull()
    })
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
