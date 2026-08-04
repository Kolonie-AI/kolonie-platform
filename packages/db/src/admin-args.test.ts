import { describe, expect, it } from 'vitest'
import { credits, flag } from './admin-args.js'

describe('an amount of credits', () => {
  it('is a whole number above zero', () => {
    expect(credits('300')).toBe(300)
    expect(credits('1')).toBe(1)
  })

  /**
   * Zero is the amount an operator types when they mean *no money*, and it is
   * the one the pilot's whole argument is about: at zero nothing is booked at
   * all (`state/decisions/the-pilot-pays-one-cent.md`). It fails here rather
   * than at the check constraint, where the message is about a constraint.
   */
  it('refuses zero and anything below it', () => {
    expect(() => credits('0')).toThrow(/not an amount/)
    expect(() => credits('-5')).toThrow(/not an amount/)
  })

  /**
   * The expensive mistake, and the reason the check is on the text. `3.00` is
   * somebody crediting three dollars; `Number('3.00')` is a whole number, so a
   * check on the value alone accepts it and books three cents.
   */
  it('refuses anything with a decimal point, including a whole one', () => {
    expect(() => credits('1.5')).toThrow(/one credit being one US cent/)
    expect(() => credits('3.00')).toThrow(/Three dollars is 300/)
  })

  it('refuses what is not a number at all', () => {
    expect(() => credits('three')).toThrow(/not an amount/)
    expect(() => credits('')).toThrow(/not an amount/)
  })
})

describe('a flag', () => {
  const argv = ['Vireo', '300', '--source', 'bootstrap', '--memo', 'pilot funding']

  it('reads the value after it', () => {
    expect(flag(argv, 'source')).toBe('bootstrap')
    expect(flag(argv, 'memo')).toBe('pilot funding')
  })

  it('is undefined when it was not given', () => {
    expect(flag(argv, 'reason')).toBeUndefined()
  })

  /**
   * `--source` last, and `--source --memo x`. Both read naively as *no source*,
   * which is refused with a sentence about recording the origin — true, and
   * about the wrong mistake.
   */
  it('is an error when it has no value to read', () => {
    expect(() => flag(['Vireo', '300', '--source'], 'source')).toThrow(/--source needs a value/)
    expect(() => flag(['--source', '--memo', 'x'], 'source')).toThrow(/--source needs a value/)
  })
})
