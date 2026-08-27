import { describe, expect, it } from 'vitest'
import {
  AgentCredentialsSchema,
  API_KEY_PREFIX,
  CredentialRecoveryChallengeSchema,
  CredentialRecoveryRequestSchema,
  CredentialRecoveryResponseSchema,
  RECOVERY_ATTEMPT_LIMIT,
  RECOVERY_ATTEMPT_WINDOW_SECONDS,
  RECOVERY_CHALLENGE_TTL_SECONDS,
  RECOVERY_NOMINATION_DELAY_SECONDS,
  RecoveryNominationRequestSchema,
  RecoveryNominationSchema,
  CredentialSchema,
  EMAIL_LINK_TTL_MS,
  RotateCredentialRequestSchema,
  isUsable,
} from './credentials.js'
import { ROTATION_CONFIRMATION_TTL_SECONDS } from '../api/registration-confirmation.js'
import { MAX_SIGNATURE_LENGTH } from '../common/signature.js'

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

/**
 * Recovery, nominated in advance (`#1684`).
 *
 * The rejection cases are the point here, exactly as they are everywhere else in
 * this package: a nomination schema that accepted an agent id would be a surface
 * on which recovering somebody else is expressible, and a recovery request that
 * accepted one would be the same defect one call later.
 */
describe('the numbers recovery is built on', () => {
  it('gives a recovery nonce the same fifteen minutes a confirmation token gets', () => {
    expect(RECOVERY_CHALLENGE_TTL_SECONDS).toBe(900)
    expect(RECOVERY_CHALLENGE_TTL_SECONDS * 1000).toBe(EMAIL_LINK_TTL_MS)
  })

  it('allows three attempts a day and makes a nomination wait two', () => {
    expect(RECOVERY_ATTEMPT_LIMIT).toBe(3)
    expect(RECOVERY_ATTEMPT_WINDOW_SECONDS).toBe(24 * 60 * 60)
    expect(RECOVERY_NOMINATION_DELAY_SECONDS).toBe(48 * 60 * 60)
  })
})

describe('RecoveryNominationRequestSchema', () => {
  it('takes the account being nominated and nothing else', () => {
    const parsed = RecoveryNominationRequestSchema.parse({ accountId: CREDENTIAL_UUID })
    expect(parsed.accountId).toBe(CREDENTIAL_UUID)
  })

  it('refuses an agent id, so a nomination cannot be aimed at another citizen', () => {
    const result = RecoveryNominationRequestSchema.safeParse({
      accountId: CREDENTIAL_UUID,
      agentId: AGENT_UUID,
    })
    expect(result.success).toBe(false)
  })

  it('refuses an account id that is not an id at all', () => {
    expect(RecoveryNominationRequestSchema.safeParse({ accountId: 'the mailbox' }).success).toBe(
      false,
    )
  })
})

describe('RecoveryNominationSchema', () => {
  const nomination = {
    accountId: CREDENTIAL_UUID,
    kind: 'wallet',
    identifier: 'a-base58-address',
    nominatedAt: '2026-08-24T10:00:00.000Z',
    effectiveAt: '2026-08-26T10:00:00.000Z',
    effective: false,
  }

  it('says when a nomination starts working, and whether it has', () => {
    const parsed = RecoveryNominationSchema.parse(nomination)
    expect(parsed.effective).toBe(false)
    expect(parsed.effectiveAt).toBe('2026-08-26T10:00:00.000Z')
  })

  it('refuses a nomination that names no moment it becomes usable', () => {
    const { effectiveAt: _dropped, ...without } = nomination
    expect(RecoveryNominationSchema.safeParse(without).success).toBe(false)
  })
})

describe('CredentialRecoveryChallengeSchema', () => {
  const challenge = {
    nonce: 'a-nonce',
    expiresAt: '2026-08-27T10:15:00.000Z',
    algorithm: 'ed25519',
    attemptsRemaining: 3,
  }

  it('carries what to sign, by when, and how many tries are left', () => {
    const parsed = CredentialRecoveryChallengeSchema.parse(challenge)
    expect(parsed.attemptsRemaining).toBe(3)
    expect(parsed.algorithm).toBe('ed25519')
  })

  it('accepts a wallet nomination, which signs without naming a curve', () => {
    expect(
      CredentialRecoveryChallengeSchema.safeParse({ ...challenge, algorithm: null }).success,
    ).toBe(true)
  })

  it('never carries a public key, which nothing about signing a nonce needs', () => {
    const parsed = CredentialRecoveryChallengeSchema.parse(challenge)
    expect(parsed).not.toHaveProperty('publicKey')
  })

  it('refuses a negative number of remaining attempts', () => {
    expect(
      CredentialRecoveryChallengeSchema.safeParse({ ...challenge, attemptsRemaining: -1 }).success,
    ).toBe(false)
  })
})

describe('CredentialRecoveryRequestSchema', () => {
  const request = { handle: 'canary', nonce: 'a-nonce', signature: 'a-signature' }

  it('takes a handle, the nonce it was issued with, and a signature over it', () => {
    expect(CredentialRecoveryRequestSchema.parse(request)).toEqual(request)
  })

  it('refuses an agent id, which is the whole reason the shape is strict', () => {
    expect(
      CredentialRecoveryRequestSchema.safeParse({ ...request, agentId: AGENT_UUID }).success,
    ).toBe(false)
  })

  it('refuses a request carrying no signature, which is the one factor that counts', () => {
    const { signature: _dropped, ...without } = request
    expect(CredentialRecoveryRequestSchema.safeParse(without).success).toBe(false)
  })

  it('refuses a signature longer than any algorithm the Colony accepts produces', () => {
    const result = CredentialRecoveryRequestSchema.safeParse({
      ...request,
      signature: 'a'.repeat(MAX_SIGNATURE_LENGTH + 1),
    })
    expect(result.success).toBe(false)
  })
})

describe('CredentialRecoveryResponseSchema', () => {
  const response = {
    credentials: {
      agentId: AGENT_UUID,
      credentialId: CREDENTIAL_UUID,
      kind: 'api-key',
      apiKey: API_KEY,
      issuedAt: '2026-08-27T10:00:00.000Z',
    },
    vault: { stranded: 4 },
  }

  it('hands back a key and says how many vault entries it does not open', () => {
    const parsed = CredentialRecoveryResponseSchema.parse(response)
    expect(parsed.vault.stranded).toBe(4)
    expect(parsed.credentials.apiKey).toBe(API_KEY)
  })

  /**
   * **The structural fact of `#1684`, asserted rather than described.** A
   * recovery has no old key, so nothing can re-seal — a response carrying a
   * `resealed` count would be describing an operation that cannot happen.
   */
  it('has nowhere to report a re-seal, because a recovery cannot perform one', () => {
    const parsed = CredentialRecoveryResponseSchema.parse(response)
    expect(parsed.vault).not.toHaveProperty('resealed')
    expect(
      CredentialRecoveryResponseSchema.safeParse({
        ...response,
        vault: { stranded: 4, resealed: 1 },
      }).success,
    ).toBe(false)
  })
})
