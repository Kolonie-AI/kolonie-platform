import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isPerceptionNearMiss,
  PERCEPTION_ALPHABET,
  PERCEPTION_CODE_LENGTH,
  perceptionCodeFor,
} from './perception.js'

describe('the perception code', () => {
  /**
   * **A pinned vector, because this derivation exists twice.**
   *
   * The page in `apps/api/public/perception/index.html` computes the same code in
   * its own script — it has to, because the alternative was an endpoint that hands
   * the answer out one unauthenticated request away. Two implementations of one rule
   * drift, and the drift would be silent: the page would draw one code while the
   * server expected another, and every honest citizen would fail.
   *
   * So this fixes the answer for one id. If the derivation changes deliberately,
   * this test fails and the page has to change with it, which is the point.
   */
  it('derives one fixed code for one challenge id', () => {
    // Worked by hand from the id's hex, so the vector is checkable rather than
    // recorded from a run: 0f=15→T, 2c=44→V, 48=72→W, a1=161→9, 9b=155→Y.
    expect(perceptionCodeFor('0f2c48a1-9b7e-4d3f-8a62-15c9de704b83')).toBe('TVW9Y')
  })

  it('gives different challenges different codes', () => {
    const first = perceptionCodeFor('0f2c48a1-9b7e-4d3f-8a62-15c9de704b83')
    const second = perceptionCodeFor('7d61b204-3ac8-4e15-9f70-2b84ca6d0e19')

    expect(first).not.toBe(second)
  })

  it('gives the same challenge the same code twice, so a reloaded page still works', () => {
    const id = '7d61b204-3ac8-4e15-9f70-2b84ca6d0e19'

    expect(perceptionCodeFor(id)).toBe(perceptionCodeFor(id))
  })

  it('draws only from the alphabet, at the declared length', () => {
    for (const id of [
      '0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
      '7d61b204-3ac8-4e15-9f70-2b84ca6d0e19',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const code = perceptionCodeFor(id)
      expect(code).toHaveLength(PERCEPTION_CODE_LENGTH)
      for (const character of code) expect(PERCEPTION_ALPHABET).toContain(character)
    }
  })

  /**
   * **The ambiguous pairs are excluded, and this is not cosmetic.** The stage asks a
   * vision model to transcribe glyphs. `O` beside `0`, or `1` beside `l`, turns a
   * correct reading into a failed attempt — and then the rung measures luck rather
   * than perception.
   */
  it('excludes glyphs a reader would confuse', () => {
    for (const ambiguous of ['O', '0', 'I', 'l', '1', 'S', '5', 'Z', '2']) {
      expect(PERCEPTION_ALPHABET).not.toContain(ambiguous)
    }
  })

  /**
   * **The page and this file must agree, so the test reads the page.**
   *
   * Asserting the shared constants appear verbatim in the page's script is the
   * cheapest available guard against the two halves drifting: it does not prove the
   * arithmetic matches, which the pinned vector above is for, but it does catch
   * somebody changing the alphabet or the length on one side only.
   */
  it('shares its alphabet and length with the page that draws it', () => {
    const page = readFileSync(
      new URL('../../../../apps/api/public/perception/index.html', import.meta.url),
      'utf8',
    )

    expect(page).toContain(`const ALPHABET = '${PERCEPTION_ALPHABET}'`)
    expect(page).toContain(`const LENGTH = ${PERCEPTION_CODE_LENGTH}`)
  })

  /**
   * **`#162`'s central requirement, checked against the bytes actually served.**
   *
   * A citizen that fetches the document and searches it must come away with nothing.
   * The page carries the *derivation*, which is stated openly — this is a capability
   * signal and not a security boundary — but it must never carry a *code*, and it
   * must not name one in a `title`, an `aria-label` or the canvas fallback, because
   * any of those would put the answer in the accessibility tree and let a DOM reader
   * pass a stage about seeing.
   */
  it('does not carry any challenge code in the served page', () => {
    const page = readFileSync(
      new URL('../../../../apps/api/public/perception/index.html', import.meta.url),
      'utf8',
    )

    for (const id of [
      '0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
      '7d61b204-3ac8-4e15-9f70-2b84ca6d0e19',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
    ]) {
      expect(page).not.toContain(perceptionCodeFor(id))
    }

    // And nothing that would render the answer into the accessibility tree.
    expect(page).not.toMatch(/aria-label="[^"]*\$\{/)
    expect(page).not.toMatch(/title="[^"]*\$\{/)
    expect(page).not.toMatch(/textContent\s*=\s*[^\n]*codeFor/)
  })

  /**
   * The page must not fetch the answer either. `#162` requires the stage to embed
   * and fetch nothing external, and the reason it derives the code locally at all is
   * that an endpoint returning it would make the stage measure nothing.
   */
  it('fetches nothing that could hand the page its answer', () => {
    const page = readFileSync(
      new URL('../../../../apps/api/public/perception/index.html', import.meta.url),
      'utf8',
    )

    // The one request it makes is the observation report, which carries geometry
    // outward and returns no body.
    const requests = [...page.matchAll(/fetch\(([^)]*)/g)].map((match) => match[1] ?? '')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('/rendered')

    // No foreign origin anywhere in the document.
    expect(page).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//)
  })
})

describe('a near miss', () => {
  it('recognises one character out', () => {
    expect(isPerceptionNearMiss('TVW9Y', 'TVW9X')).toBe(true)
  })

  it('recognises two adjacent characters swapped', () => {
    expect(isPerceptionNearMiss('TVW9Y', 'TWV9Y')).toBe(true)
  })

  /**
   * Deliberately narrow. Two unrelated characters wrong is a different answer, not a
   * near one, and telling a citizen it was close when it was not sends it looking
   * for a scaling problem it does not have.
   */
  it('does not stretch to two unrelated characters', () => {
    expect(isPerceptionNearMiss('TVW9Y', 'XVW9X')).toBe(false)
  })

  it('is not a near miss when it is exactly right', () => {
    expect(isPerceptionNearMiss('TVW9Y', 'TVW9Y')).toBe(false)
  })

  it('is not a near miss at the wrong length', () => {
    expect(isPerceptionNearMiss('TVW9Y', 'TVW9')).toBe(false)
    expect(isPerceptionNearMiss('TVW9Y', 'TVW9YY')).toBe(false)
  })
})
