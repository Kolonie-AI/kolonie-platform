import { describe, expect, it } from 'vitest'
import {
  CreateGuestVaultHandoffRequestSchema,
  CreateGuestVaultHandoffResponseSchema,
  GUEST_VAULT_HANDOFF_DEFAULT_MINUTES,
  GUEST_VAULT_HANDOFF_MAX_MINUTES,
  GUEST_VAULT_HANDOFF_MIN_MINUTES,
  GuestVaultHandoffSchema,
  ListGuestVaultHandoffsResponseSchema,
  RevokeGuestVaultHandoffResponseSchema,
  VAULT_KEY_SHAPES,
  VaultKeySchema,
  VaultShareNotifyStatusSchema,
} from './vault.js'

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

describe('portable guest vault handoffs', () => {
  const request = {
    key: 'github/octocat',
    purpose: 'use this machine account credential',
  }

  it('accepts the default and both minute boundaries', () => {
    expect(CreateGuestVaultHandoffRequestSchema.parse(request)).toEqual({
      ...request,
      minutes: GUEST_VAULT_HANDOFF_DEFAULT_MINUTES,
    })
    expect(
      CreateGuestVaultHandoffRequestSchema.safeParse({
        ...request,
        minutes: GUEST_VAULT_HANDOFF_MIN_MINUTES,
      }).success,
    ).toBe(true)
    expect(
      CreateGuestVaultHandoffRequestSchema.safeParse({
        ...request,
        minutes: GUEST_VAULT_HANDOFF_MAX_MINUTES,
        passphrase: 'a separate phrase',
      }).success,
    ).toBe(true)
  })

  it('rejects an expiry outside the configured bounds and any plaintext value', () => {
    expect(
      CreateGuestVaultHandoffRequestSchema.safeParse({
        ...request,
        minutes: GUEST_VAULT_HANDOFF_MIN_MINUTES - 1,
      }).success,
    ).toBe(false)
    expect(
      CreateGuestVaultHandoffRequestSchema.safeParse({
        ...request,
        minutes: GUEST_VAULT_HANDOFF_MAX_MINUTES + 1,
      }).success,
    ).toBe(false)
    expect(
      CreateGuestVaultHandoffRequestSchema.safeParse({ ...request, value: 'must-not-enter' })
        .success,
    ).toBe(false)
  })

  it('keeps capability data on the creation response only', () => {
    const handoff = {
      id: '11111111-1111-4111-8111-111111111111',
      key: 'github/octocat',
      purpose: 'use this machine account credential',
      state: 'active' as const,
      passphraseRequired: false,
      createdAt: '2026-09-03T12:00:00.000Z',
      expiresAt: '2026-09-03T12:15:00.000Z',
      consumedAt: null,
      revokedAt: null,
    }

    expect(
      CreateGuestVaultHandoffResponseSchema.parse({
        handoff,
        url: 'https://kolonie.ai/handoff/opaque-capability',
      }).url,
    ).toContain('/handoff/')
    expect(ListGuestVaultHandoffsResponseSchema.parse({ handoffs: [handoff] })).not.toHaveProperty(
      'url',
    )
    expect(RevokeGuestVaultHandoffResponseSchema.parse({ handoff })).not.toHaveProperty('url')
    expect(
      ListGuestVaultHandoffsResponseSchema.safeParse({
        handoffs: [handoff],
        url: 'https://kolonie.ai/handoff/must-not-return',
      }).success,
    ).toBe(false)
  })

  it.each(['active', 'consumed', 'revoked', 'expired'] as const)(
    'publishes the %s lifecycle state without capability data',
    (state) => {
      const handoff = GuestVaultHandoffSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        key: 'github/octocat',
        purpose: 'use this machine account credential',
        state,
        passphraseRequired: false,
        createdAt: '2026-09-03T12:00:00.000Z',
        expiresAt: '2026-09-03T12:15:00.000Z',
        consumedAt: state === 'consumed' ? '2026-09-03T12:01:00.000Z' : null,
        revokedAt: state === 'revoked' ? '2026-09-03T12:01:00.000Z' : null,
      })

      expect(handoff.state).toBe(state)
      expect(handoff).not.toHaveProperty('token')
      expect(handoff).not.toHaveProperty('value')
      expect(handoff).not.toHaveProperty('passphrase')
    },
  )
})

describe('the outcome of telling an operator about a share', () => {
  it.each(['delivered', 'no-address', 'capped', 'undeliverable'] as const)(
    'publishes %s as a result an agent can branch on',
    (status) => {
      expect(VaultShareNotifyStatusSchema.parse(status)).toBe(status)
    },
  )

  it('rejects an invented outcome rather than making callers interpret prose', () => {
    expect(VaultShareNotifyStatusSchema.safeParse('queued').success).toBe(false)
  })
})
