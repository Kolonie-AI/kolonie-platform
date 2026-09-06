import { describe, expect, it } from 'vitest'
import { UNREADABLE_RESPONSE_BYTES } from '../doctor/thresholds.js'
import { API_BASE_PATH } from './version.js'
import {
  CreateGuestVaultHandoffRequestSchema,
  CreateGuestVaultHandoffResponseSchema,
  GUEST_VAULT_HANDOFF_DEFAULT_MINUTES,
  GUEST_VAULT_HANDOFF_MAX_MINUTES,
  GUEST_VAULT_HANDOFF_MIN_MINUTES,
  GetVaultEntryMcpReceiptSchema,
  ListVaultEntriesRequestSchema,
  ListVaultEntriesResponseSchema,
  GuestVaultHandoffSchema,
  ListGuestVaultHandoffsResponseSchema,
  RevokeGuestVaultHandoffResponseSchema,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_ENTRY_WORST_CASE_BYTES,
  VAULT_KEY_SHAPES,
  VAULT_MAX_ENTRIES,
  VAULT_PAGE_SIZE,
  VAULT_VALUE_MAX_LENGTH,
  VaultKeySchema,
  VaultShareNotifyStatusSchema,
  vaultEntryRetrieval,
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
    conversationId: '11111111-1111-4111-8111-111111111111',
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

/**
 * A vault read over MCP is a transcript event (`#1874`).
 *
 * The receipt is what a default read answers with: everything about the entry
 * except the one field a conversational transcript must not carry, plus the
 * named route that hands the plaintext over outside it.
 */
describe('the transcript-safe vault read receipt', () => {
  const entry = {
    key: 'github/octocat',
    description: null,
    spentAt: null,
    share: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }

  it('projects a read into a receipt that carries no value', () => {
    const receipt = GetVaultEntryMcpReceiptSchema.parse({
      entry,
      value: 'a-synthetic-fixture-value',
      retrieval: {
        method: 'GET',
        path: `${API_BASE_PATH}/vault/github%2Foctocat`,
        authorization: 'Bearer <your API key>',
      },
    })

    expect(receipt).not.toHaveProperty('value')
    expect(JSON.stringify(receipt)).not.toContain('a-synthetic-fixture-value')
    expect(receipt.retrieval.path).toBe(`${API_BASE_PATH}/vault/github%2Foctocat`)
  })

  it('refuses a receipt whose retrieval route is missing', () => {
    expect(GetVaultEntryMcpReceiptSchema.safeParse({ entry }).success).toBe(false)
  })

  it('names the route for one key, escaped so a slash in the name survives', () => {
    expect(vaultEntryRetrieval('totp/github')).toEqual({
      method: 'GET',
      path: `${API_BASE_PATH}/vault/totp%2Fgithub`,
      authorization: 'Bearer <your API key>',
    })
  })
})

/**
 * The ceiling, and the two things the old number was paying for (`#1872`).
 *
 * A citizen doing account-scouting work holds one entry per provider walked,
 * per earn rail and per inherited account, so sixty-four is a wall an ordinary
 * handover runs into. Raising it is one constant; keeping the listing honest at
 * the new size is the rest of this.
 */
describe('the vault quota and what a listing costs at it', () => {
  it('holds a thousand and twenty-four credentials', () => {
    expect(VAULT_MAX_ENTRIES).toBe(1024)
  })

  it('leaves how large one entry may be exactly as it was', () => {
    expect(VAULT_VALUE_MAX_LENGTH).toBe(8 * 1024)
    expect(VAULT_DESCRIPTION_MAX_LENGTH).toBe(512)
  })

  it('pages the listing, with a page far under what a runtime refuses', () => {
    expect(VAULT_PAGE_SIZE).toBeLessThan(VAULT_MAX_ENTRIES)
    expect(VAULT_PAGE_SIZE * VAULT_ENTRY_WORST_CASE_BYTES).toBeLessThan(UNREADABLE_RESPONSE_BYTES)
  })

  it('carries a cursor and the quota on a listing', () => {
    const page = ListVaultEntriesResponseSchema.parse({
      entries: [],
      maxEntries: VAULT_MAX_ENTRIES,
      nextCursor: 'opaque',
    })

    expect(page.nextCursor).toBe('opaque')
    expect(
      ListVaultEntriesResponseSchema.parse({ entries: [], maxEntries: VAULT_MAX_ENTRIES })
        .nextCursor,
    ).toBeNull()
  })

  it('refuses a page larger than the one it will serve', () => {
    expect(ListVaultEntriesRequestSchema.safeParse({ limit: VAULT_PAGE_SIZE }).success).toBe(true)
    expect(ListVaultEntriesRequestSchema.safeParse({ limit: VAULT_PAGE_SIZE + 1 }).success).toBe(
      false,
    )
    expect(ListVaultEntriesRequestSchema.safeParse({ limit: 0 }).success).toBe(false)
  })
})
