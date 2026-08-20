import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * The envelope's format tag, and the first thing `openVaultValue` reads.
 *
 * A version prefix rather than an implicit format, because the one thing this
 * module can be sure of is that its choices will be revisited. A stored value
 * that names its own scheme can be migrated by a reader that understands both;
 * a stored value that does not can only be migrated by a reader that already
 * knows which era it came from, and nothing records that.
 */
export const VAULT_ENVELOPE_VERSION = 'k1'

/** AES-256-GCM. 32-byte key, 12-byte nonce, 16-byte tag — the sizes below. */
export const VAULT_CIPHER = 'aes-256-gcm'

/** 256 bits, because the cipher is AES-**256**-GCM. */
const KEY_BYTES = 32

/**
 * 96 bits, which is the nonce size GCM is specified for.
 *
 * A random nonce is safe here only because it is random *per write* and the
 * number of writes under one derived key is small — a citizen's vault holds
 * tens of entries, not billions. What makes that argument hold rather than
 * merely sound plausible is the per-row salt below: two entries encrypted with
 * the same token do not even share a key, so a nonce collision would have to
 * happen twice over to matter.
 */
const IV_BYTES = 12

/**
 * 128 bits of HKDF salt, fresh for every write.
 *
 * Per row rather than per agent or per deployment. It costs 24 characters in
 * the envelope and it means every stored entry has its own encryption key, so a
 * weakness found in one ciphertext reaches exactly one secret.
 */
const SALT_BYTES = 16

/**
 * What the derived key is *for*, mixed into HKDF so a key derived here can
 * never coincide with one derived for some other purpose from the same token.
 */
const HKDF_INFO = 'kolonie:vault:v1'

/**
 * Turn a citizen's plaintext API key into an encryption key.
 *
 * **HKDF-SHA256, not PBKDF2 or Argon2, and this is the decision worth reading
 * before changing anything here.** The instinct is right in general and wrong
 * for this input, for the same reason `api-key.ts` gives under D-010: a slow KDF
 * exists to make each guess expensive when the number of plausible guesses is
 * small, which is the situation with a human-chosen password. The input here is
 * `API_KEY_ENTROPY_BYTES` of `randomBytes` — 256 bits with no structure and no
 * plausible guesses. There is nothing for iterations to slow down.
 *
 * What iterations *would* do is cost real latency on a path an agent hits on
 * every wake-up, and do it in the API process rather than in an attacker's. A
 * hundred thousand rounds of PBKDF2 on every `kolonie.vault.get` is a tax the
 * Colony pays and an attacker holding a database dump does not.
 *
 * HKDF is the right primitive for the actual job: turning one high-entropy
 * secret into a distinct key bound to a purpose and a salt. It is fast because
 * the hard part — having 256 bits of unguessable input — was already done at
 * registration.
 *
 * **What this deliberately does not claim.** It does not protect a stolen key.
 * An attacker holding the plaintext token can read that citizen's vault, exactly
 * as it can call every other authenticated endpoint as that citizen. What it
 * protects is the *database*: `credentials` stores only a SHA-256 of the token,
 * so a dump of both tables yields ciphertext and a hash that cannot produce the
 * key that would open it.
 */
function deriveKey(token: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), salt, HKDF_INFO, KEY_BYTES))
}

/**
 * What a ciphertext is bound to, so it cannot be moved.
 *
 * GCM's additional authenticated data is not encrypted — it is *authenticated*,
 * which is what is wanted: an attacker with write access to the database can
 * copy a row, and without this it could copy one citizen's `github` ciphertext
 * onto another citizen's row and wait for the owner of the second key to read
 * it. Binding the agent and the key name into the tag makes any such move
 * decrypt to an authentication failure rather than to a secret.
 *
 * It is also why the plaintext `key` column is not merely a convenience for
 * listing: renaming an entry by an `UPDATE` in the database breaks it, on
 * purpose.
 */
function associatedData(agentId: string, key: string): Buffer {
  return Buffer.from(`${agentId}\0${key}`, 'utf8')
}

/**
 * What a description is sealed against, which is not quite what the value is.
 *
 * The envelope binds ciphertext to the citizen and to the entry's name through
 * its associated data. Sealing both fields under the *same* associated data
 * would leave the two interchangeable: a row whose description ciphertext was
 * swapped into its value column would still open, and the citizen would read its
 * own note where it expected a credential. One suffix removes that, at the cost
 * of a string concatenation.
 *
 * **It lives here rather than in `storage/vault.ts` because two modules seal a
 * description now** (`#1439`): the vault itself, under the citizen's key, and a
 * share, under the Colony's. Two copies of this string would be two chances for
 * them to drift, and a drift here is a description that opens as nothing.
 */
export function vaultDescriptionScope(key: string): string {
  return `${key}#description`
}

/**
 * Encrypt one value for one citizen, under the key it is presenting right now.
 *
 * The returned string is what goes in `agent_vault.encrypted_value`, and it is
 * self-describing: version, salt, nonce, tag, ciphertext, dot-separated in
 * base64url. One column rather than five, because these five values are only
 * ever read together and a schema that could hold a salt from one write beside a
 * tag from another would be a schema that permits an unopenable row.
 */
export function sealVaultValue(token: string, agentId: string, key: string, value: string): string {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(VAULT_CIPHER, deriveKey(token, salt), iv)
  cipher.setAAD(associatedData(agentId, key))

  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return [
    VAULT_ENVELOPE_VERSION,
    salt.toString('base64url'),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

/**
 * Read one value back, or `null` if this token cannot open it.
 *
 * **`null` rather than a thrown error, and the distinction is the contract.**
 * Every way this can fail — a token that did not write the row, a tampered
 * ciphertext, a row copied between agents, an envelope from a scheme this build
 * does not know — is the same fact to the caller: *what is stored here is not
 * readable with what you presented*. Distinguishing them would tell an attacker
 * which of its guesses was closer, and there is no repair the caller could make
 * that depends on knowing which.
 *
 * A malformed envelope collapses into the same answer for the same reason,
 * rather than being an exception: a caller that has to handle `null` anyway
 * gains nothing from a second failure channel, and a 500 on a corrupt row would
 * take out the whole request instead of the one entry.
 */
export function openVaultValue(
  token: string,
  agentId: string,
  key: string,
  envelope: string,
): string | null {
  const [version, salt, iv, tag, ciphertext] = envelope.split('.')

  if (version !== VAULT_ENVELOPE_VERSION) return null
  if (salt === undefined || iv === undefined || tag === undefined || ciphertext === undefined) {
    return null
  }

  try {
    const decipher = createDecipheriv(
      VAULT_CIPHER,
      deriveKey(token, Buffer.from(salt, 'base64url')),
      Buffer.from(iv, 'base64url'),
    )
    decipher.setAAD(associatedData(agentId, key))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))

    // `final()` is where GCM checks the tag, so this throws rather than
    // returning wrong bytes when anything above did not match.
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
