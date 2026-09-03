import { describe, expect, it } from 'vitest'
import { ERROR_STATUS } from './errors.js'
import {
  CREDENTIAL_REFUSAL_MESSAGE,
  credentialFinding,
  credentialRefusalMessage,
  keyMaterialFinding,
  keyMaterialNotice,
  keyMaterialRefusalMessage,
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

  /**
   * **The operator channel is where a person writes their own language**
   * (`#1529`), and the guard read one. Measured 2026-08-21 against
   * `packages/core/dist`: of these thirteen rows exactly the first was caught.
   *
   * `credentialFinding` states the case itself — *the answer is where a password
   * is most likely to actually arrive, an operator who has just created an
   * account is holding one* — and that is precisely the send path where a person
   * is writing freely. A message in production carries a plaintext account
   * password in a German sentence of the third shape below.
   *
   * **The Italian rows are the sharpest and are why the separator list had to
   * widen too.** `password` is the ordinary Italian word, so the *label* is one
   * the pattern already had; what it lacked was the copula. A vocabulary
   * widening on its own would have left both of them missed.
   *
   * Accent-less spellings are here on purpose. People type them, and a channel
   * that has lost its diacritics produces them.
   */
  it.each([
    ['en', 'the password is Xk9-Placeholder'],
    ['de', 'das Passwort ist Xk9-Placeholder'],
    ['de', 'hier ist das Passwort: Xk9-Placeholder'],
    ['de', 'Kennwort: Xk9-Placeholder'],
    ['de', 'Zugangsdaten: Xk9-Placeholder'],
    ['de', 'Der API-Schlüssel lautet Xk9-Placeholder'],
    ['fr', 'le mot de passe est Xk9-Placeholder'],
    ['fr', 'la clé API est Xk9-Placeholder'],
    ['es', 'la contraseña es Xk9-Placeholder'],
    ['es', 'la contrasena es Xk9-Placeholder'],
    ['nl', 'het wachtwoord is Xk9-Placeholder'],
    ['pt', 'a senha é Xk9-Placeholder'],
    ['pt', 'a senha e Xk9-Placeholder'],
    ['it', 'la password è Xk9-Placeholder'],
    ['it', 'la password e Xk9-Placeholder'],
  ])('catches a labelled secret written in %s', (_language, text) => {
    expect(looksLikeCredential(text), text).toBe(true)
  })

  /**
   * **The half that decides whether the widening was worth doing.** Every string
   * here is an ordinary sentence in one of the six languages, containing the
   * label and no secret — the same bar the English negatives below are held to,
   * because a guard that refuses a person writing *the password is something you
   * choose* has closed the channel in their language instead of only in English.
   */
  it.each([
    ['de', 'Das Passwort ist etwas, das du dir aussuchst — sag es mir nicht.'],
    ['de', 'Die Zugangsdaten sind schon im Vault, du musst mir nichts schicken.'],
    ['de', 'Ich habe das Kennwort vergessen und frage dich lieber, statt zu raten.'],
    ['fr', 'Le mot de passe est dans le coffre, je ne vous le demande pas.'],
    ['es', 'La contraseña es algo que eliges tú, no me la digas.'],
    ['nl', 'Het wachtwoord is al opgeslagen in de kluis, dus stuur het niet.'],
    ['pt', 'A senha é escolhida por si, não preciso de a saber.'],
    ['it', 'la password e nome utente sono nel vault'],
  ])('lets an ordinary sentence in %s through', (_language, text) => {
    expect(looksLikeCredential(text), text).toBe(false)
  })

  /**
   * **Alternation is ordered, not greedy, and both lists were bitten by it.**
   *
   * With `is` before `ist`, `das Passwort ist Xk9-…` matched the separator `is`,
   * took `t` as the value and left ` Xk9-…` as the rest — at which point
   * `looksLikeAValue` correctly answered that a bare letter mid-sentence is not a
   * value, and the disclosure went through *a guard that had matched it*. The
   * same shape one language along with `es` inside `est`.
   *
   * Fixed by sorting longest-first and giving a word separator the same boundary
   * the label carries. This is the rejection case for both.
   */
  it.each([
    'das Passwort ist Xk9-Placeholder',
    'die Zugangsdaten sind Xk9-Placeholder',
    'le mot de passe est Xk9-Placeholder',
    'het wachtwoord zijn Xk9-Placeholder',
  ])('does not let a longer separator be shadowed by a shorter one: %s', (text) => {
    expect(credentialFinding(text)?.reason).toBe('labelled-secret')
  })

  it('allows an opaque guest handoff URL to cross ordinary messaging without exempting nearby credentials', () => {
    const url = 'https://kolonie.ai/handoff/0Hn7Gv9mM3xP8qW2rT5yU1iO6pA4sD7fJ9kL2zX5cV8'
    expect(looksLikeCredential(`Open ${url} and reveal it once.`)).toBe(false)
    expect(looksLikeCredential(`Open ${url}; password: hunter2`)).toBe(true)
    expect(looksLikeCredential(`${url}/ghp_abcdefghijklmnopqrstuvwxyz01`)).toBe(true)
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

/**
 * `#1685`: the vault refuses a PEM private-key block and nothing else this
 * detector names. The other reasons still belong in a message; a vault write
 * is where a password, a token and a TOTP secret are supposed to go.
 */
describe('key material the vault must not hold', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE-SENTINEL-DO-NOT-ECHO\n-----END RSA PRIVATE KEY-----'

  it('finds a PEM private-key block and names the class, never the body', () => {
    const finding = keyMaterialFinding(pem)

    expect(finding).toEqual({ reason: 'private-key-block', matched: 'private-key-block' })
    expect(JSON.stringify(finding)).not.toContain('MIIE-SENTINEL-DO-NOT-ECHO')
  })

  it('lets every other finding through, which is what a vault is for', () => {
    expect(keyMaterialFinding('password: hunter2')).toBeNull()
    expect(keyMaterialFinding('otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP')).toBeNull()
    expect(keyMaterialFinding('ghp_abcdefghijklmnopqrstuvwxyz01')).toBeNull()
    expect(keyMaterialFinding('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6')).toBeNull()
  })

  it('refuses with a code an agent can branch on, naming both reasons', () => {
    const finding = keyMaterialFinding(pem)
    if (finding === null) throw new Error('expected a private-key-block finding')

    const message = keyMaterialRefusalMessage(finding)
    expect(ERROR_STATUS.key_material_refused).toBe(422)
    expect(message).toContain('PEM private-key block')
    expect(message).toMatch(/stays where (it was |you )?generat/)
    expect(message).toContain('API key')
    expect(message).not.toContain('MIIE-SENTINEL-DO-NOT-ECHO')
    expect(message).not.toContain(CREDENTIAL_REFUSAL_MESSAGE.slice(0, 40))
  })

  it('notices a block as an object, and omits the field when there is none', () => {
    expect(keyMaterialNotice(pem)).toEqual({
      noticed: { reason: 'private-key-block', matched: 'private-key-block' },
    })
    expect(keyMaterialNotice('hunter2')).toEqual({})
    expect(keyMaterialNotice(null)).toEqual({})
  })
})
