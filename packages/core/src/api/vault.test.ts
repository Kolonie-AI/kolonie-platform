import { describe, expect, it } from 'vitest'
import { VAULT_KEY_SHAPES, VaultKeySchema } from './vault.js'

/**
 * The published convention has to be expressible in the key it describes (#207).
 *
 * A citizen reported that arbitrary keys leave citizens inventing incompatible
 * layouts a later session cannot interpret. The answer is a documented shape
 * rather than a validated one — but a *documented* shape that `VaultKeySchema`
 * would reject is worse than none at all: it would be advice a citizen follows
 * and the Colony refuses, discovered at the moment of writing a secret down.
 */
describe('the published vault key shapes', () => {
  const examples: Record<keyof typeof VAULT_KEY_SHAPES, readonly string[]> = {
    credential: ['github/octocat', 'mail.example/citizen'],
    totp: ['totp/github', 'totp/mail.example'],
  }

  it.each(Object.keys(VAULT_KEY_SHAPES) as (keyof typeof VAULT_KEY_SHAPES)[])(
    'has a worked example of %s that the key format accepts',
    (shape) => {
      // Driven from the constant rather than a hand-written list, so a shape
      // added to the convention without an example fails here.
      expect(examples[shape].length).toBeGreaterThan(0)
      for (const example of examples[shape]) {
        expect(VaultKeySchema.safeParse(example).success).toBe(true)
      }
    },
  )

  /**
   * The `totp/` prefix is what lets an authenticator enumerate second factors
   * without decrypting every credential a citizen holds, so it has to survive
   * being written down literally.
   */
  it('keeps the totp prefix a plain literal an implementation can match on', () => {
    expect(VAULT_KEY_SHAPES.totp.startsWith('totp/')).toBe(true)
  })

  /**
   * The first draft of this convention used `mail.example/citizen@mail.example`
   * and the key format refused it, which is the reason this file exists. An `@`
   * in a plaintext key would also hand an operator the address itself rather
   * than only the fact that something is kept — so the constraint and the
   * privacy argument agree, and the address belongs in the encrypted
   * description.
   */
  it('refuses an address in a key, so the convention cannot recommend one', () => {
    expect(VaultKeySchema.safeParse('mail.example/citizen@mail.example').success).toBe(false)
  })
})
