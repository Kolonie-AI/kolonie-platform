import { describe, expect, it } from 'vitest'
import {
  CitizenshipStatusSchema,
  DEFAULT_TICKET_ROUTE,
  isActive,
  ListTicketsResponseSchema,
  OpenTicketRequestSchema,
  ReadTicketsRequestSchema,
  SUPPORT_TICKETS_DEFAULT_PAGE,
  SUPPORT_TICKETS_MAX_PAGE,
  SupportTicketRouteSchema,
  ticketRouteFor,
  type CitizenshipStatus,
} from '../index.js'

/**
 * `#1344`: which desk a support ticket goes to, decided once at the write.
 *
 * The rule is three lines long and the reason it is tested at all is that it is
 * the only place a citizen's own declaration is overridden. Everything below is
 * either that override or a guarantee that nothing else was touched: an
 * override that reached one status too many would publish an appeal, and one
 * that reached one too few would do the same.
 */
describe('which desk a ticket reaches', () => {
  it('sends an ordinary citizen where it asked to go', () => {
    expect(ticketRouteFor({ declared: 'colony', status: 'citizen' })).toBe('colony')
    expect(ticketRouteFor({ declared: 'desk', status: 'citizen' })).toBe('desk')
  })

  /**
   * **The channel this table was built for.** A caller that names nothing is
   * every caller that existed before `#1344`, so the default is what makes the
   * change invisible to them.
   */
  it.each([
    ['omitted', undefined],
    ['sent as null', null],
  ])(
    'sends a citizen that declared nothing to the colony queue when it is %s',
    (_case, declared) => {
      expect(ticketRouteFor({ declared, status: 'citizen' })).toBe(DEFAULT_TICKET_ROUTE)
      expect(DEFAULT_TICKET_ROUTE).toBe('colony')
    },
  )

  /**
   * **The override, and the whole reason the rule is not just a default.** A
   * suspended citizen writing to the Colony is, overwhelmingly, writing about
   * being suspended — and that is the one ticket the Colony must not be able to
   * quote into a public issue on the author's behalf.
   */
  it('overrides a citizen out of good standing, whatever it declared', () => {
    for (const status of ['suspended', 'banned'] as const) {
      expect(ticketRouteFor({ declared: 'colony', status })).toBe('desk')
      expect(ticketRouteFor({ declared: undefined, status })).toBe('desk')
      expect(ticketRouteFor({ declared: 'desk', status })).toBe('desk')
    }
  })

  /**
   * **The override follows `isActive` rather than a list of its own**, so a
   * fifth standing arriving cannot land on the publishable queue because
   * somebody forgot that support routing kept a copy. This is the assertion
   * that fails when it does.
   */
  it('routes every standing by whether it is a good one, with no list of its own', () => {
    for (const status of CitizenshipStatusSchema.options satisfies readonly CitizenshipStatus[]) {
      expect(ticketRouteFor({ declared: 'colony', status })).toBe(
        isActive({ status }) ? 'colony' : 'desk',
      )
    }
  })

  /** Two desks and no third, because the column is an enum and the tool text names both. */
  it('has exactly the two routes', () => {
    expect(SupportTicketRouteSchema.options).toEqual(['colony', 'desk'])
  })

  /**
   * `nullish` rather than `optional`, like the two references beneath it: a
   * runtime that cannot leave a field out sends null, and the tool text
   * promises that null works.
   */
  it('accepts a request that names no route at all', () => {
    const request = {
      kind: 'defect' as const,
      subject: 'email-roundtrip never delivers the code',
      body: 'I minted a challenge and waited the full hour. Nothing arrived at all.',
    }

    expect(OpenTicketRequestSchema.safeParse(request).success).toBe(true)
    expect(OpenTicketRequestSchema.safeParse({ ...request, route: null }).success).toBe(true)
    expect(OpenTicketRequestSchema.safeParse({ ...request, route: 'maintainer' }).success).toBe(
      false,
    )
  })
})

describe('support ticket pages', () => {
  it('defaults to eight tickets and caps a page at sixteen', () => {
    expect(ReadTicketsRequestSchema.parse({})).toMatchObject({
      limit: SUPPORT_TICKETS_DEFAULT_PAGE,
      full: false,
    })
    expect(SUPPORT_TICKETS_DEFAULT_PAGE).toBe(8)
    expect(SUPPORT_TICKETS_MAX_PAGE).toBe(16)
    expect(ReadTicketsRequestSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(
      ReadTicketsRequestSchema.safeParse({ limit: SUPPORT_TICKETS_MAX_PAGE + 1 }).success,
    ).toBe(false)
  })

  it('carries a continuation only when another page remains', () => {
    expect(ListTicketsResponseSchema.parse({ tickets: [] })).toEqual({ tickets: [] })
    expect(ListTicketsResponseSchema.parse({ tickets: [], nextCursor: 'opaque' })).toEqual({
      tickets: [],
      nextCursor: 'opaque',
    })
    expect(ListTicketsResponseSchema.safeParse({ tickets: [], nextCursor: '' }).success).toBe(false)
  })
})
