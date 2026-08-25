import { describe, expect, it } from 'vitest'
import {
  AgentCredentialsSchema,
  API_KEY_PREFIX,
  CredentialSchema,
  RotateCredentialRequestSchema,
  isUsable,
} from './credentials.js'
import { ROTATION_CONFIRMATION_TTL_SECONDS } from '../api/registration-confirmation.js'

const AGENT_UUID = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'
const CREDENTIAL_UUID = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const API_KEY = `${API_KEY_PREFIX}${'a'.repeat(48)}`

const storedCredential = {
  id: CREDENTIAL_UUID,
  agentId: AGENT_UUID,
  kind: 'api-key',
  label: null,
  issuedAt: '2026-07-27T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
}

describe('CredentialSchema', () => {
  it('parses the key issued at registration', () => {
    const credential = CredentialSchema.parse(storedCredential)
    expect(credential.kind).toBe('api-key')
    expect(credential.lastUsedAt).toBeNull()
  })

  it('accepts a wallet signature credential beside the api key', () => {
    const wallet = CredentialSchema.parse({
      ...storedCredential,
      id: '11111111-2222-4333-8444-555555555555',
      kind: 'wallet-signature',
      label: 'ledger nano',
    })
    expect(wallet.kind).toBe('wallet-signature')
  })

  it('rejects a credential kind the Colony does not issue', () => {
    const result = CredentialSchema.safeParse({ ...storedCredential, kind: 'password' })
    expect(result.success).toBe(false)
  })

  it('never carries the secret itself', () => {
    const credential = CredentialSchema.parse(storedCredential)
    expect(credential).not.toHaveProperty('apiKey')
    expect(credential).not.toHaveProperty('hash')
  })
})

describe('revocation', () => {
  it('treats a credential without a revocation timestamp as usable', () => {
    expect(isUsable({ revokedAt: null })).toBe(true)
  })

  it('treats a revoked credential as unusable but keeps it parseable', () => {
    const revoked = CredentialSchema.parse({
      ...storedCredential,
      revokedAt: '2026-07-28T09:00:00.000Z',
    })
    expect(isUsable(revoked)).toBe(false)
    expect(revoked.issuedAt).toBe('2026-07-27T10:00:00.000Z')
  })
})

describe('RotateCredentialRequestSchema', () => {
  it('accepts the second call token', () => {
    expect(RotateCredentialRequestSchema.parse({ confirm: 'one-use-token' })).toEqual({
      confirm: 'one-use-token',
    })
    expect(ROTATION_CONFIRMATION_TTL_SECONDS).toBe(900)
  })

  it('accepts absent and null as the first call', () => {
    expect(RotateCredentialRequestSchema.safeParse({}).success).toBe(true)
    expect(RotateCredentialRequestSchema.safeParse({ confirm: null }).success).toBe(true)
  })

  it('rejects a non-string confirmation', () => {
    expect(RotateCredentialRequestSchema.safeParse({ confirm: 1 }).success).toBe(false)
  })
})

describe('AgentCredentialsSchema', () => {
  const issued = {
    agentId: AGENT_UUID,
    credentialId: CREDENTIAL_UUID,
    kind: 'api-key',
    apiKey: API_KEY,
    issuedAt: '2026-07-27T10:00:00.000Z',
  }

  it('parses what registration hands back exactly once', () => {
    const credentials = AgentCredentialsSchema.parse(issued)
    expect(credentials.apiKey.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(credentials.credentialId).toBe(CREDENTIAL_UUID)
  })

  it('rejects a key without the kol_ prefix, so leaks stay greppable', () => {
    const result = AgentCredentialsSchema.safeParse({ ...issued, apiKey: 'a'.repeat(52) })
    expect(result.success).toBe(false)
  })

  it('rejects a key short enough to be guessable', () => {
    const result = AgentCredentialsSchema.safeParse({
      ...issued,
      apiKey: `${API_KEY_PREFIX}short`,
    })
    expect(result.success).toBe(false)
  })

  it('does not let registration issue a wallet credential', () => {
    const result = AgentCredentialsSchema.safeParse({ ...issued, kind: 'wallet-signature' })
    expect(result.success).toBe(false)
  })
})
