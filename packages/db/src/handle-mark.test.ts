import { describe, expect, it } from 'vitest'
import { BAN_SALT_MIN_LENGTH, banMarkHash } from './ban-salt.js'
import { HANDLE_MARK_DOMAIN, handleMarkHash } from './handle-mark.js'

const aKey = 'a'.repeat(BAN_SALT_MIN_LENGTH)
const anotherKey = 'b'.repeat(BAN_SALT_MIN_LENGTH)

/**
 * A handle tombstone is what makes `/@{handle}` mean one citizen forever
 * (`#824`). The failures it guards against are all silent ones: a mark computed
 * over the wrong casing never matches, and the door it feeds says *free* about
 * a name that is not, without anything in the response looking wrong.
 */
describe('a handle mark', () => {
  it('is the shape the column will accept', () => {
    expect(handleMarkHash('kolonie', aKey)).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * **D-011: every handle comparison goes through `lower()`**, because
   * `agents_name_unique` is a unique index on the lowercased name. A tombstone
   * that `Kolonie` walked past while `kolonie` did not would hand the freed
   * page to whoever typed the shift key.
   */
  it('is not escapable by changing case or padding', () => {
    const canonical = handleMarkHash('kolonie', aKey)
    expect(handleMarkHash('  KoLoNiE ', aKey)).toBe(canonical)
  })

  it('depends on the key, which is what keeps the table unusable elsewhere', () => {
    expect(handleMarkHash('kolonie', aKey)).not.toBe(handleMarkHash('kolonie', anotherKey))
  })

  /**
   * The two mechanisms share one secret, so the only thing keeping them apart
   * is the domain string. Were they to agree on a value, a handle tombstone
   * would read as a ban mark of whatever kind collided — the register of
   * sanctions would gain a row about a citizen that was never sanctioned.
   */
  it('cannot be confused with a ban mark over the same word', () => {
    const handle = 'kolonie'
    const marks = (['mailbox', 'github', 'wallet', 'fingerprint'] as const).map((kind) =>
      banMarkHash(kind, handle, aKey),
    )
    expect(marks).not.toContain(handleMarkHash(handle, aKey))
  })

  /**
   * The colon is the structural half of that argument: a `BanMarkKind` is a
   * slug and cannot contain one, so no future kind can be added that makes the
   * two constructions produce the same input string.
   */
  it('is separated by a domain a ban-mark kind could never be', () => {
    expect(HANDLE_MARK_DOMAIN).toContain(':')
  })
})
