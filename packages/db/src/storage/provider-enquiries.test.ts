import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  markProviderEnquiryHandled,
  providerEnquiriesWaiting,
  providerEnquiryList,
  recordProviderEnquiry,
} from './provider-enquiries.js'

const target = databaseTestTarget()

const ENQUIRY = {
  product: 'A mailbox service agents can sign up for.',
  url: 'openmail.example',
  contact: 'Jo, jo@openmail.example',
  wants: 'We want to know whether an agent can complete our signup without a person.',
}

/**
 * Providers writing in about the Atlas (`#544`).
 *
 * The table exists to answer one question before the rest of the Atlas is built:
 * do providers want to be in it. So what is asserted is that an enquiry survives
 * intact, that *waiting* is distinguishable from *dealt with*, and that the
 * public boundary cannot be used to write something unbounded.
 */
describe('a provider writing in', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('keeps what was sent, and nothing about who sent it', async () => {
    const stored = await recordProviderEnquiry(db, ENQUIRY)

    expect(stored).toMatchObject(ENQUIRY)
    expect(stored.handledAt).toBeNull()
    // No address, no user agent, no fingerprint: the spam defence is the captcha
    // at the boundary, and a second one made of retained personal data would
    // cost more than it stops.
    const [row] = await db.execute<{ columns: string }>(
      sql`select string_agg(column_name, ',' order by column_name) as columns
            from information_schema.columns
           where table_name = 'provider_enquiries'`,
    )
    expect(row?.columns).toBe('contact,created_at,handled_at,id,product,url,wants')
  })

  it('answers how many are waiting, which is the number the page leads with', async () => {
    await recordProviderEnquiry(db, ENQUIRY)
    const second = await recordProviderEnquiry(db, { ...ENQUIRY, product: 'Another one.' })

    expect(await providerEnquiriesWaiting(db)).toBe(2)

    await markProviderEnquiryHandled(db, second.id)

    expect(await providerEnquiriesWaiting(db)).toBe(1)
  })

  /**
   * *Nobody wrote in* and *somebody wrote in and we dealt with it* are different
   * answers to the question the form exists to ask, so a handled enquiry stays
   * and sits below rather than disappearing.
   */
  it('keeps handled enquiries, and puts the waiting ones first', async () => {
    const first = await recordProviderEnquiry(db, { ...ENQUIRY, product: 'The first.' })
    await recordProviderEnquiry(db, { ...ENQUIRY, product: 'The second.' })
    await markProviderEnquiryHandled(db, first.id)

    const listed = await providerEnquiryList(db)

    expect(listed.map((enquiry) => enquiry.product)).toEqual(['The second.', 'The first.'])
    expect(listed[1]?.handledAt).not.toBeNull()
  })

  /**
   * Pressing it twice is how somebody uses a button they are unsure about, and
   * the second press must not move the date — *when was this dealt with* is the
   * answer, and re-stamping it would say the enquiry waited less than it did.
   */
  it('leaves the date alone when it is marked handled twice', async () => {
    const stored = await recordProviderEnquiry(db, ENQUIRY)
    expect(await markProviderEnquiryHandled(db, stored.id)).toBe(true)
    const [first] = await providerEnquiryList(db)

    expect(await markProviderEnquiryHandled(db, stored.id)).toBe(false)

    const [again] = await providerEnquiryList(db)
    expect(again?.handledAt).toBe(first?.handledAt)
  })

  it('answers false for an enquiry that is not there', async () => {
    expect(await markProviderEnquiryHandled(db, '00000000-0000-4000-8000-000000000000')).toBe(false)
  })

  /**
   * The rejection case, and it is about the public boundary: the route bounds
   * these first, and this is what holds under a caller that is not the API.
   */
  it('refuses a field longer than the boundary allows', async () => {
    await expectRejection(
      () => recordProviderEnquiry(db, { ...ENQUIRY, wants: 'x'.repeat(2001) }),
      /provider_enquiries_wants_length/,
    )
  })

  it('refuses an enquiry that says nothing at all', async () => {
    await expectRejection(
      () => recordProviderEnquiry(db, { ...ENQUIRY, product: '   ' }),
      /provider_enquiries_product_length/,
    )
  })
})
