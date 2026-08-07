import {
  markProviderEnquiryHandled,
  providerEnquiriesWaiting,
  providerEnquiryList,
  recordProviderEnquiry,
  type Database,
} from '@kolonie-ai/db'
import type { ProviderEnquiry, StoredProviderEnquiry } from '@kolonie-ai/core'

/**
 * The desk the Atlas enquiry route and `/backend` take (`#544`).
 *
 * A desk rather than the storage functions directly, for the reason every other
 * dependency here is one: the routes are tested against a fake, and the SQL is
 * tested in `packages/db` against a real Postgres.
 */
export interface ProviderEnquiryDesk {
  record(enquiry: ProviderEnquiry): Promise<StoredProviderEnquiry>
  /** What has arrived, unhandled first. Bounded, because a page is not an archive. */
  list(): Promise<readonly StoredProviderEnquiry[]>
  /** How many are still waiting — the number the section leads with. */
  waiting(): Promise<number>
  /** `false` when it was already handled, which is the ordinary double-press. */
  markHandled(id: string): Promise<boolean>
}

/**
 * A desk that takes nothing and holds nothing.
 *
 * `buildApp` defaults to this so the many tests that build an app and never
 * touch an enquiry do not each have to say so — the same trade `noSettings()`
 * makes one file over. It **records** rather than refusing, because a route test
 * asserting the confirmation should not have to stand up a store.
 */
export function noProviderEnquiries(): ProviderEnquiryDesk {
  const held: StoredProviderEnquiry[] = []

  return {
    record: async (enquiry) => {
      const stored: StoredProviderEnquiry = {
        ...enquiry,
        id: `enquiry-${held.length + 1}`,
        createdAt: new Date().toISOString(),
        handledAt: null,
      }
      held.push(stored)
      return stored
    },
    list: async () => [...held].reverse(),
    waiting: async () => held.filter((enquiry) => enquiry.handledAt === null).length,
    markHandled: async (id) => {
      const found = held.findIndex((enquiry) => enquiry.id === id && enquiry.handledAt === null)
      if (found === -1) return false
      held[found] = { ...held[found]!, handledAt: new Date().toISOString() }
      return true
    },
  }
}

export function databaseProviderEnquiries(db: Database): ProviderEnquiryDesk {
  return {
    record: (enquiry) => recordProviderEnquiry(db, enquiry),
    list: () => providerEnquiryList(db),
    waiting: () => providerEnquiriesWaiting(db),
    markHandled: (id) => markProviderEnquiryHandled(db, id),
  }
}
