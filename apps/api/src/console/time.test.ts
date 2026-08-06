import { describe, expect, it } from 'vitest'
import { absolute, FALLBACK_ZONE, relative, zoneFrom } from './time.js'

/**
 * Times a person reads (`#461`).
 *
 * **The property every test here is circling is not the offset.** It is that the
 * output says which clock it is on. `2026-08-06 10:56` was the right instant and
 * the wrong page, because nothing on it admitted to being UTC.
 */
describe('the zone a request is rendered in', () => {
  it('is the one the edge says the visitor is in', () => {
    expect(zoneFrom({ 'x-kolonie-timezone': 'Europe/Berlin' })).toBe('Europe/Berlin')
  })

  /**
   * **Both headers, and ours wins** (`kolonie-docs#188`).
   *
   * The managed transform that sent `cf-timezone` also sent latitude, longitude,
   * city, region and postal code, so it is off and a narrow transform rule sets
   * `x-kolonie-timezone` instead. `cf-timezone` stays readable because the edge
   * change and a deploy cannot land in the same instant — and because that is
   * what makes the edge change revertible on its own.
   */
  it('prefers the narrow header, and still reads Cloudflare’s', () => {
    expect(zoneFrom({ 'cf-timezone': 'Europe/Berlin' })).toBe('Europe/Berlin')
    expect(
      zoneFrom({ 'x-kolonie-timezone': 'Pacific/Auckland', 'cf-timezone': 'Europe/Berlin' }),
    ).toBe('Pacific/Auckland')
  })

  /**
   * **The rejection case the issue asks for, first half.** A deployment behind
   * no Cloudflare, a request from inside the network, a transform switched off —
   * all of them land here, and none of them may throw or print a bare number.
   */
  it('falls back to a written-out UTC when the header is absent', () => {
    expect(zoneFrom({})).toBe(FALLBACK_ZONE)
    expect(FALLBACK_ZONE).toBe('UTC')
  })

  /** **And the second half.** A value that is not a zone is not a zone. */
  it('falls back rather than throwing on a nonsense value', () => {
    expect(zoneFrom({ 'cf-timezone': 'Europe/Berlyn' })).toBe(FALLBACK_ZONE)
    expect(zoneFrom({ 'cf-timezone': '' })).toBe(FALLBACK_ZONE)
    expect(zoneFrom({ 'cf-timezone': '../../etc/passwd' })).toBe(FALLBACK_ZONE)
    expect(zoneFrom({ 'cf-timezone': 42 })).toBe(FALLBACK_ZONE)
  })

  /**
   * **Validated by asking `Intl` rather than by a pattern**, which is why a
   * zone this file has never heard of still works. The IANA set changes without
   * this repository being edited.
   */
  it('accepts a zone nobody wrote down here', () => {
    expect(zoneFrom({ 'cf-timezone': 'Pacific/Chatham' })).toBe('Pacific/Chatham')
  })
})

describe('a time whose question is how long', () => {
  const now = new Date('2026-08-06T12:56:00.000Z')

  it('reads as an interval, not a clock face', () => {
    expect(relative('2026-08-06T10:56:00.000Z', now)).toBe('2 hours ago')
    expect(relative('2026-08-05T12:56:00.000Z', now)).toBe('yesterday')
    expect(relative('2026-08-06T12:41:00.000Z', now)).toBe('15 minutes ago')
    expect(relative('2026-08-06T12:55:45.000Z', now)).toBe('just now')
  })

  /**
   * **The case that made this worth writing down.** A link code expires ten
   * minutes from now, and the dashboard renders it on every visit while it is
   * live. *in -1 hours* is what an interval formatter does if nobody thinks
   * about the sign.
   */
  it('reads a future time forwards', () => {
    expect(relative('2026-08-06T13:06:00.000Z', now)).toBe('in 10 minutes')
    expect(relative('2026-08-07T12:56:00.000Z', now)).toBe('tomorrow')
    expect(relative('2026-08-06T13:06:00.000Z', now)).not.toContain('-')
  })

  it('hands back a timestamp it cannot parse, rather than inventing one', () => {
    expect(relative('not a date', now)).toBe('not a date')
  })
})

describe('a time whose question is when', () => {
  /**
   * The maintainer's report: `Last awake 10:56` read at 12:56 in Berlin. The
   * same instant, on the clock the reader is actually holding, and saying so.
   */
  it('renders in the visitor’s zone and names it', () => {
    const rendered = absolute('2026-08-06T10:56:00.000Z', 'Europe/Berlin')

    expect(rendered).toContain('12:56')
    expect(rendered).toContain('Europe/Berlin')
  })

  /**
   * **The zone name is part of the output, not decoration.** A time in the wrong
   * zone is a defect a reader can see and correct for; a time with no zone at
   * all is the defect they cannot.
   */
  it('names UTC in words when that is all that is known', () => {
    const rendered = absolute('2026-08-06T10:56:00.000Z', zoneFrom({}))

    expect(rendered).toContain('10:56')
    expect(rendered).toContain('UTC')
    expect(rendered).not.toMatch(/[+-]\d{2}:?\d{2}$/)
  })

  it('crosses a date boundary rather than only shifting the clock', () => {
    expect(absolute('2026-08-06T23:30:00.000Z', 'Pacific/Auckland')).toContain('7 Aug 2026')
  })

  it('hands back a timestamp it cannot parse, rather than inventing one', () => {
    expect(absolute('not a date', 'Europe/Berlin')).toBe('not a date')
  })
})
