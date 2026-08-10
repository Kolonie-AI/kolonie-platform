import { desc, eq, isNull, sql } from 'drizzle-orm'
import type { ProviderEnquiry, StoredProviderEnquiry } from '@kolonie-ai/core'
import { providerFromUrl } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { proposeProvider } from './atlas-proposals.js'
import { providerEnquiries } from '../schema/provider-enquiries.js'

/**
 * Provider enquiries about the Atlas (`#544`).
 *
 * Three operations and there will not be a fourth: take one, list them, mark one
 * handled. **There is no reply path here** — an answer goes wherever the
 * provider said to reach it, by a person, and a mail queue built on the strength
 * of a form nobody has filled in yet is the thing this issue exists to avoid
 * building.
 */

/**
 * Take an enquiry.
 *
 * Stores what was sent and nothing about the sender that they did not send: no
 * address, no user agent, no fingerprint. The spam defence is the captcha at the
 * boundary, and a second one made of retained personal data would cost more than
 * it stops — `governance/privacy.md` refuses the shape outright.
 */
export async function recordProviderEnquiry(
  db: Database,
  enquiry: ProviderEnquiry,
): Promise<StoredProviderEnquiry> {
  const [row] = await db.insert(providerEnquiries).values(enquiry).returning()

  if (row === undefined) throw new Error('provider_enquiries insert returned no row')

  /**
   * The provider's door onto the one queue (`#600`).
   *
   * **This table keeps its own commercial fields and loses its own queue.** What
   * a provider says about its product, how to reach it and what it wants from
   * agents is worth holding and is not what a steward decides — the decision is
   * *does this belong on the map*, which is the same decision an agent's wish
   * asks for, and it now has one screen instead of two.
   *
   * **A url nobody can parse costs the proposal and not the enquiry.** The
   * commercial record is the point of this write; the proposal is a by-product,
   * and losing a by-product is not a reason to refuse a provider that wrote in.
   */
  const provider = providerFromUrl(row.url)

  if (provider !== undefined) {
    await proposeProvider(db, { provider, source: 'provider', why: row.wants })
  }

  return {
    id: row.id,
    product: row.product,
    url: row.url,
    contact: row.contact,
    wants: row.wants,
    createdAt: row.createdAt,
    handledAt: row.handledAt,
  }
}

/**
 * What has arrived, unhandled first and newest first within that.
 *
 * **Handled ones stay and are shown after**, rather than disappearing: *nobody
 * wrote in* and *somebody wrote in and we dealt with it* are different answers
 * to the question this list exists for, and a list that hid the second would
 * make the Atlas look like a worse idea than the evidence says.
 */
export async function providerEnquiryList(
  db: Database,
  limit = 50,
): Promise<readonly StoredProviderEnquiry[]> {
  const rows = await db
    .select()
    .from(providerEnquiries)
    .orderBy(sql`${providerEnquiries.handledAt} is not null`, desc(providerEnquiries.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    product: row.product,
    url: row.url,
    contact: row.contact,
    wants: row.wants,
    createdAt: row.createdAt,
    handledAt: row.handledAt,
  }))
}

/** How many are still waiting — the number the page leads with. */
export async function providerEnquiriesWaiting(db: Database): Promise<number> {
  const [row] = await db
    .select({ waiting: sql<string>`count(*)::text` })
    .from(providerEnquiries)
    .where(isNull(providerEnquiries.handledAt))

  return Number(row?.waiting ?? 0)
}

/**
 * Mark one as dealt with.
 *
 * **Idempotent and one-way.** Pressing it twice is the ordinary way a person
 * uses a button they are not sure about, and the second press must not move the
 * date — *when was this dealt with* is the answer, and re-stamping it would make
 * the record say the enquiry had waited less time than it did. There is no
 * un-handle: an enquiry that turns out to need more work is followed up where
 * the provider said to reach them, not by moving a flag back.
 */
export async function markProviderEnquiryHandled(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(providerEnquiries)
    .set({ handledAt: sql`now()` })
    .where(sql`${providerEnquiries.id} = ${id} and ${providerEnquiries.handledAt} is null`)
    .returning({ id: providerEnquiries.id })

  return rows.length > 0
}

/** One enquiry, for a caller that already has its id. */
export async function providerEnquiry(
  db: Database,
  id: string,
): Promise<StoredProviderEnquiry | undefined> {
  const [row] = await db
    .select()
    .from(providerEnquiries)
    .where(eq(providerEnquiries.id, id))
    .limit(1)

  return row === undefined
    ? undefined
    : {
        id: row.id,
        product: row.product,
        url: row.url,
        contact: row.contact,
        wants: row.wants,
        createdAt: row.createdAt,
        handledAt: row.handledAt,
      }
}
