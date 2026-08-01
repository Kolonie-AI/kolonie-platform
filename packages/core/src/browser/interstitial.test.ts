import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  INTERSTITIAL_KINDS,
  MARK_COUNT,
  ORDERED_PANEL_COUNT,
  interstitialAnswerFor,
  interstitialKind,
  interstitialSetupFor,
  mintableInterstitialKinds,
} from './interstitial.js'

const IDS = [
  '0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
  '7d61b204-3ac8-4e15-9f70-2b84ca6d0e19',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '00000000-0000-4000-8000-000000000000',
]

describe('the kinds on offer', () => {
  /**
   * **The naming rule, and it is mechanical rather than stylistic** (`#160`, `#164`).
   * This is the node a reader would most naturally call a CAPTCHA, and a kind with that
   * name makes every agent run the *am I permitted* reasoning against the red lines
   * whoever wrote the page.
   */
  it('names nothing for a CAPTCHA, anywhere', () => {
    for (const kind of INTERSTITIAL_KINDS) {
      const text = `${kind.slug} ${kind.title} ${kind.measures}`.toLowerCase()
      expect(text).not.toContain('captcha')
      expect(text).not.toContain('robot')
      expect(text).not.toContain('human')
    }
  })

  it('states what each kind measures, which every kind has to', () => {
    for (const kind of INTERSTITIAL_KINDS) {
      expect(kind.measures.length).toBeGreaterThan(10)
      expect(kind.title.length).toBeGreaterThan(10)
    }
  })

  /**
   * A kind is a module plus a registry entry — `#164`'s requirement — so every kind on
   * offer has to have a module the shell can load, and every module has to be a kind.
   */
  it('has a module for every kind, and a kind for every module', () => {
    const modules = readdirSync(
      new URL('../../../../apps/api/public/interstitial/kinds', import.meta.url),
    )
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.replace(/\.js$/, ''))
      .sort()

    expect(modules).toEqual(INTERSTITIAL_KINDS.map((kind) => kind.slug).sort())
  })

  it('drafts a kind by a field rather than by deleting it', () => {
    expect(mintableInterstitialKinds().length).toBe(INTERSTITIAL_KINDS.length)
    expect(interstitialKind('no-such-kind')).toBeUndefined()
  })

  /**
   * No kind may measure timing, jitter, mouse path or human-likeness. Pinned against the
   * modules themselves, because a listener added there is how it would come back.
   */
  it('measures nothing about how a pointer moved or how long anything took', () => {
    const directory = new URL('../../../../apps/api/public/interstitial/kinds', import.meta.url)

    for (const kind of INTERSTITIAL_KINDS) {
      const source = readFileSync(new URL(`./${kind.slug}.js`, `${directory}/`), 'utf8')

      for (const forbidden of ['mousemove', 'pointermove', 'performance.now', 'Date.now']) {
        expect(source).not.toContain(forbidden)
      }
    }
  })

  /** Nothing is fetched from another origin, by the shell or by any kind. */
  it('loads nothing from a foreign origin', () => {
    const shell = readFileSync(
      new URL('../../../../apps/api/public/interstitial/index.html', import.meta.url),
      'utf8',
    )
    expect(shell).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//)

    const directory = new URL('../../../../apps/api/public/interstitial/kinds', import.meta.url)
    for (const kind of INTERSTITIAL_KINDS) {
      const source = readFileSync(new URL(`./${kind.slug}.js`, `${directory}/`), 'utf8')
      expect(source).not.toContain('https://')
      expect(source).not.toContain('http://')
    }
  })
})

describe('what a challenge asks and what answers it', () => {
  it('gives ordered-panels distinct digits, so one order is correct', () => {
    for (const id of IDS) {
      const { digits } = interstitialSetupFor(id)

      expect(digits).toHaveLength(ORDERED_PANEL_COUNT)
      expect(new Set(digits).size).toBe(ORDERED_PANEL_COUNT)
    }
  })

  it('answers ordered-panels with the positions in ascending digit order', () => {
    const id = IDS[0] as string
    const { digits } = interstitialSetupFor(id)
    const expected = digits
      .map((digit, index) => ({ digit, index }))
      .sort((first, second) => first.digit - second.digit)
      .map((panel) => panel.index)
      .join(',')

    expect(interstitialAnswerFor(id, 'ordered-panels')).toBe(expected)
  })

  /**
   * **The settled value never equals the decoy.** If it did, a citizen that screenshotted
   * the first thing it saw would pass — and noticing that the page was unfinished is the
   * only thing this kind measures.
   */
  it('never settles revealed-value on the value it showed first', () => {
    for (const id of IDS) {
      const { decoy, settled } = interstitialSetupFor(id)

      expect(settled).not.toBe(decoy)
      expect(interstitialAnswerFor(id, 'revealed-value')).toBe(String(settled))
    }
  })

  /**
   * The line always has marks on both sides, so the answer is never 0 or all of them —
   * either of which would be guessable without looking.
   */
  it('puts marks on both sides of the line', () => {
    for (const id of IDS) {
      const { marks, line } = interstitialSetupFor(id)
      const above = marks.filter((mark) => mark > line).length

      expect(marks).toHaveLength(MARK_COUNT)
      expect(above).toBeGreaterThan(0)
      expect(above).toBeLessThan(MARK_COUNT)
      expect(interstitialAnswerFor(id, 'marks-above-line')).toBe(String(above))
    }
  })

  /**
   * **No mark may sit ambiguously close to the line**, because the kind is graded on an
   * exact count and a citizen that reads carefully must not be able to answer honestly and
   * wrongly. Found on the deployment on 2026-08-01, where the midpoint placement left a
   * mark nine screen pixels above the line.
   *
   * Half a scale unit is the floor a tie would need; in practice the widest-gap placement
   * gives far more, and this asserts the property rather than the margin.
   */
  it('keeps every mark clear of the line', () => {
    for (const id of [...IDS, '3c9a71f0-0b2d-4e88-9a11-7c2f5d604e33']) {
      const { marks, line } = interstitialSetupFor(id)

      for (const mark of marks) {
        expect(Math.abs(mark - line)).toBeGreaterThan(0.5)
      }
    }
  })

  it('has an answer for every kind on offer', () => {
    for (const kind of INTERSTITIAL_KINDS) {
      expect(interstitialAnswerFor(IDS[0] as string, kind.slug)).toBeDefined()
    }
  })

  it('has no answer for a kind that does not exist', () => {
    expect(interstitialAnswerFor(IDS[0] as string, 'no-such-kind')).toBeUndefined()
  })

  it('asks two challenges different things', () => {
    const first = interstitialSetupFor(IDS[0] as string)
    const second = interstitialSetupFor(IDS[1] as string)

    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second))
  })
})
