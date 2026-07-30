import { describe, expect, it } from 'vitest'
import { BAN_SALT_MIN_LENGTH, BAN_SALT_VAR, banMarkHash, banSaltFromEnv } from './ban-salt.js'

const aSalt = 'a'.repeat(BAN_SALT_MIN_LENGTH)

/**
 * The salt is the whole security of `ban_marks`, and the failure it guards
 * against is silent: without one, every write succeeds and every read succeeds,
 * and the marks are unsalted digests of a mailbox address — recoverable with a
 * wordlist by anybody holding the table. Nothing in a response would say so.
 *
 * So these tests are about refusal rather than about hashing.
 */
describe('the ban-mark salt', () => {
  it('refuses to start with no salt at all', () => {
    expect(() => banSaltFromEnv({})).toThrow(/BAN_MARK_SALT is not set/)
  })

  it('refuses an empty one, which is what a misconfigured deploy supplies', () => {
    // `FOO=` in an env file is the common shape of this, and it is worse than
    // unset: it looks configured.
    expect(() => banSaltFromEnv({ [BAN_SALT_VAR]: '   ' })).toThrow(/is not set/)
  })

  it('refuses one short enough to enumerate', () => {
    expect(() => banSaltFromEnv({ [BAN_SALT_VAR]: 'short' })).toThrow(/shorter than/)
  })

  it('says how to make one, because an error that does not teach is a blocked deploy', () => {
    expect(() => banSaltFromEnv({})).toThrow(/openssl rand -hex 32/)
  })

  it('accepts a salt of the stated length', () => {
    expect(banSaltFromEnv({ [BAN_SALT_VAR]: aSalt })).toBe(aSalt)
  })
})

describe('a ban mark', () => {
  it('is the shape the column will accept', () => {
    expect(banMarkHash('mailbox', 'agent@host.invalid', aSalt)).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * **The kind is part of the digest, not merely a column beside it.** A GitHub
   * login and a social handle are frequently the same word, so without this a
   * ban on one would answer *yes* when the door asked about the other — a false
   * positive against an agent that did nothing, and one the door cannot see is
   * wrong.
   */
  it('does not collide across kinds', () => {
    const identifier = 'the-same-word'
    const marks = (['mailbox', 'github', 'wallet', 'fingerprint'] as const).map((kind) =>
      banMarkHash(kind, identifier, aSalt),
    )
    expect(new Set(marks).size).toBe(marks.length)
  })

  /** A ban that `Example@Host` escapes by presenting `example@host` is not a ban. */
  it('is not escapable by changing case or padding', () => {
    const canonical = banMarkHash('mailbox', 'agent@host.invalid', aSalt)
    expect(banMarkHash('mailbox', '  AGENT@Host.Invalid ', aSalt)).toBe(canonical)
  })

  /** Different salts, different marks — which is what makes the table unusable elsewhere. */
  it('depends on the salt', () => {
    expect(banMarkHash('mailbox', 'agent@host.invalid', aSalt)).not.toBe(
      banMarkHash('mailbox', 'agent@host.invalid', 'b'.repeat(BAN_SALT_MIN_LENGTH)),
    )
  })
})
