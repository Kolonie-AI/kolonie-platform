import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateApiKey } from './api-key.js'
import { openVaultValue, sealVaultValue, VAULT_ENVELOPE_VERSION } from './vault-crypto.js'

const agentId = randomUUID()
const token = String(generateApiKey())
const other = String(generateApiKey())

describe('sealing a vault value', () => {
  it('opens again with the token that sealed it', () => {
    const sealed = sealVaultValue(token, agentId, 'email', 'hunter2')

    expect(openVaultValue(token, agentId, 'email', sealed)).toBe('hunter2')
  })

  it('names its own format, so a later scheme can be told apart', () => {
    const sealed = sealVaultValue(token, agentId, 'email', 'hunter2')

    expect(sealed.startsWith(`${VAULT_ENVELOPE_VERSION}.`)).toBe(true)
  })

  it('leaves no trace of the plaintext or the token in what is stored', () => {
    const sealed = sealVaultValue(token, agentId, 'github', 'ghp_a_secret_value')

    expect(sealed).not.toContain('ghp_a_secret_value')
    expect(sealed).not.toContain('a_secret_value')
    expect(sealed).not.toContain(token)
  })

  it('seals the same value differently every time', () => {
    // A fresh salt and nonce per write, so two citizens storing the same
    // password — or one citizen storing it twice — produce unrelated rows.
    // Equal ciphertexts would let anyone with a dump group agents by secret.
    const first = sealVaultValue(token, agentId, 'email', 'hunter2')
    const second = sealVaultValue(token, agentId, 'email', 'hunter2')

    expect(first).not.toBe(second)
    expect(openVaultValue(token, agentId, 'email', second)).toBe('hunter2')
  })
})

/**
 * The acceptance criterion of `#98`, as an assertion rather than a claim.
 *
 * Each of these is a way an attacker could hold the database and try to read it:
 * with the wrong key, with no key, with the row moved to another citizen, with
 * the row renamed, or with the bytes edited. All of them answer `null`.
 */
describe('a vault value without the token that sealed it', () => {
  const sealed = sealVaultValue(token, agentId, 'email', 'hunter2')

  it('does not open with another citizen’s key', () => {
    expect(openVaultValue(other, agentId, 'email', sealed)).toBeNull()
  })

  it('does not open with a key that is close to the right one', () => {
    expect(openVaultValue(`${token}x`, agentId, 'email', sealed)).toBeNull()
    expect(openVaultValue(token.slice(0, -1), agentId, 'email', sealed)).toBeNull()
  })

  it('does not open once the row is moved to another agent', () => {
    // The agent id is authenticated data, so copying a row between citizens in
    // SQL produces something the recipient's key cannot open either.
    expect(openVaultValue(token, randomUUID(), 'email', sealed)).toBeNull()
  })

  it('does not open once the entry is renamed in the database', () => {
    expect(openVaultValue(token, agentId, 'github', sealed)).toBeNull()
  })

  /**
   * Flip one bit of one **decoded byte**, and re-encode.
   *
   * Editing the base64url text directly is the obvious way to write this and it
   * is wrong: the final character of a base64url string carries unused low bits
   * whenever the payload length is not a multiple of three, so changing it can
   * leave the decoded bytes identical — and the value then opens exactly as it
   * should, failing the test at random depending on what the nonce produced.
   * Tampering has to happen on the bytes GCM actually authenticates.
   */
  const tamperWith = (envelope: string, part: number): string => {
    const parts = envelope.split('.')
    const bytes = Buffer.from(parts[part] ?? '', 'base64url')
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0)

    return parts
      .map((value, index) => (index === part ? bytes.toString('base64url') : value))
      .join('.')
  }

  it('does not open once a single byte of the ciphertext is edited', () => {
    expect(openVaultValue(token, agentId, 'email', tamperWith(sealed, 4))).toBeNull()
  })

  it('does not open once the authentication tag is edited', () => {
    expect(openVaultValue(token, agentId, 'email', tamperWith(sealed, 3))).toBeNull()
  })

  it('does not open once the nonce or the salt is edited', () => {
    // Neither is secret, and neither needs to be — but changing either must
    // still produce a refusal rather than plausible-looking bytes.
    expect(openVaultValue(token, agentId, 'email', tamperWith(sealed, 1))).toBeNull()
    expect(openVaultValue(token, agentId, 'email', tamperWith(sealed, 2))).toBeNull()
  })

  it('does not open when the ciphertext is truncated', () => {
    const parts = sealed.split('.')
    const shortened = Buffer.from(parts[4] ?? '', 'base64url').subarray(0, -1)

    expect(
      openVaultValue(
        token,
        agentId,
        'email',
        [parts[0], parts[1], parts[2], parts[3], shortened.toString('base64url')].join('.'),
      ),
    ).toBeNull()
  })
})

describe('an envelope this build cannot read', () => {
  it('answers null rather than throwing, for every malformed shape', () => {
    // A corrupt row must cost the caller that one entry, not the request.
    for (const malformed of ['', 'k1', 'k1.a.b.c', 'not-an-envelope', 'k2.a.b.c.d', '....']) {
      expect(openVaultValue(token, agentId, 'email', malformed)).toBeNull()
    }
  })
})
