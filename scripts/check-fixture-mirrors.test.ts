import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain script, as `check-theme-drift.test.ts` imports its own.
import { fingerprint, functionSource, markersIn } from './check-fixture-mirrors.mjs'

/**
 * `#735`: the check that makes a fixture unskippable when the rule it copies moves.
 *
 * What is worth testing here is the fingerprint's two promises, because everything
 * else about this check is a file read. It has to move when the code moves —
 * otherwise it is decoration — and it has to sit still when only the prose moves,
 * otherwise it is re-pinned reflexively and stops being read at all.
 */

const SOURCE = `import { thing } from 'somewhere'

/** A paragraph about why. */
export async function mintSomething(
  db: Database,
  replace: boolean,
): Promise<Outcome> {
  const open = await find(db)
  // The rule itself.
  if (open !== undefined && !replace) return { outcome: 'open' }
  return { outcome: 'minted' }
}

export function somethingElse(): void {}
`

describe('functionSource', () => {
  it('takes the named export and stops at the one that follows it', () => {
    const body = functionSource(SOURCE, 'mintSomething')

    expect(body).toContain('if (open !== undefined && !replace)')
    expect(body).not.toContain('somethingElse')
  })

  it('answers nothing for a symbol the file does not export', () => {
    expect(functionSource(SOURCE, 'mintNothing')).toBeUndefined()
  })

  /** A prefix match would pin the wrong function and never say so. */
  it('does not settle for a name the wanted one merely starts with', () => {
    expect(functionSource(SOURCE, 'mintSome')).toBeUndefined()
  })
})

describe('fingerprint', () => {
  it('moves when the rule moves', () => {
    const changed = SOURCE.replace('&& !replace', '&& replace !== true')

    expect(fingerprint(functionSource(changed, 'mintSomething'))).not.toBe(
      fingerprint(functionSource(SOURCE, 'mintSomething')),
    )
  })

  /**
   * The half that decides whether anybody keeps reading these failures. A pin
   * that fires on a reworded comment sends somebody to a fixture that is still
   * correct, and the second time that happens it is re-pinned without looking.
   */
  it('sits still when only the prose around the rule moves', () => {
    const reworded = SOURCE.replace('// The rule itself.', '// Rewritten, at length, later.')
      .replace('/** A paragraph about why. */', '/** A quite different paragraph. */')
      .replace('  const open = await find(db)', '\n  const open = await find(db)\n')

    expect(fingerprint(functionSource(reworded, 'mintSomething'))).toBe(
      fingerprint(functionSource(SOURCE, 'mintSomething')),
    )
  })
})

describe('markersIn', () => {
  it('reads the file, the symbol and the pin off a marker, with its line', () => {
    const fixture = `const a = 1\n\n// @mirrors packages/db/src/storage/totp.ts mintTotpSecretFor 12305a84\nmint: async () => {},\n`

    expect(markersIn(fixture, 'apps/api/src/__fixtures__/authenticator.ts')).toEqual([
      {
        fixture: 'apps/api/src/__fixtures__/authenticator.ts',
        line: 3,
        target: 'packages/db/src/storage/totp.ts',
        symbol: 'mintTotpSecretFor',
        pinned: '12305a84',
      },
    ])
  })

  it('finds nothing in a fixture that only stores rows', () => {
    expect(markersIn('const rows = []\n', 'apps/api/src/__fixtures__/store.ts')).toEqual([])
  })
})
