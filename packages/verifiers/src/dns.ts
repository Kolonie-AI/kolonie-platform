import { Resolver } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { isPrivateIP } from './website-verify.js'

/**
 * The label the Colony's challenge record is published under.
 *
 * Defined in `@kolonie-ai/core` and re-exported here so every existing importer
 * is unaffected: the erasure receipt names the same record and lives in
 * `packages/db`, which cannot see this package.
 */
export { CHALLENGE_LABEL } from '@kolonie-ai/core'

/** How long one query may take, and how many times it is retried. */
export const DNS_TIMEOUT_MS = 5_000
export const DNS_TRIES = 2

/**
 * How far up the name the search for a zone's nameservers may walk.
 *
 * A bound on work rather than a rule about names: a submitted name is a handful
 * of labels, and a walk that reached the root would be answering about somebody
 * else's zone by the time it got there.
 */
export const MAX_ZONE_WALK = 8

/**
 * How many of a zone's nameservers are resolved before the Colony stops.
 *
 * Its own constant rather than a reuse of the walk bound above, which is a
 * different quantity that happens to be the same number — a zone's owner decides
 * how many `NS` records it publishes, and borrowing the label bound for it would
 * couple two limits that have no reason to move together.
 */
export const MAX_NAMESERVERS = 8

/**
 * How many `TXT` records one name may carry before the Colony stops reading.
 *
 * Bounded for the reason every other read here is: a verdict must not do an
 * unbounded amount of work because the thing it reads is large, and a zone's
 * owner decides how large this one is.
 */
export const MAX_TXT_RECORDS = 100

/** What a read of the world answered. */
export type DnsReadResult =
  /** The name resolved and these are its `TXT` records, joined per record. */
  | { readonly outcome: 'ok'; readonly records: readonly string[] }
  /**
   * The name answered, and there is no such record. A real answer and a `fail`:
   * the zone said no, which is different from nobody having said anything.
   */
  | { readonly outcome: 'no-record'; readonly reason: string }
  /**
   * Nothing could be established. A `pending`, never a `fail` — a resolver that
   * timed out has told the Colony about its own network and nothing about the
   * citizen's zone.
   */
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * Reads `TXT` records from the nameservers authoritative for a name.
 *
 * A seam rather than a call to `node:dns`, for the reason `AGENTS.md` §3 draws
 * the boundary: a verifier takes what it reads as a dependency so a test can
 * supply it, and so the one place that talks to the network is one file.
 */
export interface DnsReader {
  /** Read `TXT` at `<label>.<name>`, resolved authoritatively. */
  readTxt(name: string, label: string): Promise<DnsReadResult>
}

/**
 * Lowercase and drop the trailing dot.
 *
 * Both are presentation rather than identity — `Example.COM.` and `example.com`
 * are one name to a resolver — and the normalised form is what a pass records,
 * so one zone cannot certify two citizens by being submitted in two spellings.
 * `citizenForDomainName` compares against this and nothing else.
 */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Whether a string is plausibly a DNS name the Colony should try to resolve.
 *
 * Deliberately loose: it rejects what cannot be a name rather than deciding what
 * a valid registration looks like. Public suffixes change, new TLDs appear, and
 * a verifier that curated the list would refuse names that exist. Two labels is
 * the floor because a single label is either a TLD or a hostname on some local
 * search domain, and neither is a zone a citizen holds.
 */
export function looksLikeName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false
  if (isIPv4(name) || isIPv6(name)) return false

  const labels = name.split('.')
  if (labels.length < 2) return false

  return labels.every(
    (label) => /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(label) && label.length <= 63,
  )
}

/**
 * A reader that answers from the zone's own nameservers, not from a cache.
 *
 * **The authoritative read is the point, and it is not a refinement.** A
 * recursive resolver answers from whatever it cached, including a negative
 * answer cached before the citizen published anything — so a record set five
 * minutes ago and a record that was never set are the same answer for as long as
 * the negative TTL runs. That failure is the Colony's and the citizen pays for
 * it, which is exactly the shape `pending` exists to prevent elsewhere.
 *
 * Three steps, each of which can fail differently:
 *
 * 1. find the nameservers for the submitted name, walking up its labels until a
 *    zone answers — the citizen may hold a delegated subdomain, so the `NS` set
 *    is not always at the name itself;
 * 2. resolve those nameserver hostnames to addresses, refusing any that is
 *    private — a zone can name any host it likes, and pointing the Colony's
 *    resolver at `169.254.169.254` is the same attack `safeFetch` refuses over
 *    HTTP;
 * 3. ask those addresses for the `TXT` set directly.
 */
export function nodeDnsReader(): DnsReader {
  return {
    async readTxt(name: string, label: string): Promise<DnsReadResult> {
      const zone = await authoritativeAddresses(name)

      if (zone.outcome !== 'servers') return zone

      const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })
      resolver.setServers(zone.addresses)

      try {
        const chunks = await resolver.resolveTxt(`${label}.${name}`)

        return {
          outcome: 'ok',
          // A TXT record longer than 255 bytes arrives as several strings and is
          // one value; `node:dns` hands them back unjoined. Joining per record
          // rather than flattening the lot keeps two records from being read as
          // one, which is what would let a nonce and an agent id that were never
          // published together satisfy the check.
          records: chunks.slice(0, MAX_TXT_RECORDS).map((record) => record.join('')),
        }
      } catch (error) {
        return txtFailure(error, `${label}.${name}`)
      }
    },
  }
}

/**
 * What the walk up the labels found.
 *
 * `servers` rather than a second `ok`, so the discriminant separates "here are
 * the nameservers" from "here is a verdict about the record" — one narrowing
 * rather than a shape the type checker cannot tell apart from a read result.
 */
type ZoneLookup = { readonly outcome: 'servers'; readonly addresses: string[] } | DnsReadResult

/**
 * The addresses of the nameservers authoritative for a name.
 *
 * Walks up the labels because the `NS` set sits at a zone apex, which is the
 * submitted name for a registered domain and some ancestor of it for a delegated
 * subdomain. `ENODATA` at one level is not an answer about the name — it means
 * this label is inside a zone rather than at its top — so the walk continues.
 * `NXDOMAIN` is a real answer and stops it: no such name exists.
 */
async function authoritativeAddresses(name: string): Promise<ZoneLookup> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })
  const labels = name.split('.')

  for (let i = 0; i < labels.length - 1 && i < MAX_ZONE_WALK; i += 1) {
    const candidate = labels.slice(i).join('.')

    let servers: string[]
    try {
      servers = await resolver.resolveNs(candidate)
    } catch (error) {
      const code = errorCode(error)

      // No NS *here* says nothing about the name — the label is inside a zone
      // whose apex is further up. Keep walking.
      if (code === 'ENODATA' || code === 'ENOTFOUND') continue

      if (code === 'ESERVFAIL' || code === 'ETIMEOUT' || code === 'ECONNREFUSED') {
        return {
          outcome: 'unavailable',
          reason: `looking up the nameservers for ${candidate} answered ${code}.`,
        }
      }

      return {
        outcome: 'no-record',
        reason: `the name ${candidate} does not resolve (${code}).`,
      }
    }

    const addresses = await addressesOf(resolver, servers)

    if (addresses.length > 0) return { outcome: 'servers', addresses }

    return {
      outcome: 'unavailable',
      reason:
        `the nameservers for ${candidate} (${servers.join(', ')}) resolved to no address the ` +
        'Colony may query.',
    }
  }

  return {
    outcome: 'no-record',
    reason: `no zone above ${name} publishes nameservers, so there is nothing authoritative to ask.`,
  }
}

/** Nameserver hostnames to addresses, dropping every private one. */
async function addressesOf(resolver: Resolver, servers: readonly string[]): Promise<string[]> {
  const addresses: string[] = []

  for (const server of servers.slice(0, MAX_NAMESERVERS)) {
    for (const family of ['resolve4', 'resolve6'] as const) {
      try {
        for (const address of await resolver[family](server)) {
          if (!isPrivateIP(address)) addresses.push(address)
        }
      } catch {
        // A nameserver that does not resolve on one family is ordinary. It is
        // only a failure if none of them resolve at all, which the caller sees.
      }
    }
  }

  return addresses
}

/**
 * Which outcome a failed `TXT` query is, which is the whole pass/pending line.
 *
 * Exported so it can be tested without a network. It is the one piece of
 * judgement in this file — everything else is plumbing — and getting it backwards
 * in either direction is expensive: a citizen losing an attempt to a resolver
 * timeout, or a submission waiting out its timeout against a name that will never
 * answer and then being told it ran out of time.
 */
export function txtFailure(error: unknown, queried: string): DnsReadResult {
  const code = errorCode(error)

  if (code === 'ESERVFAIL' || code === 'ETIMEOUT' || code === 'ECONNREFUSED') {
    return { outcome: 'unavailable', reason: `asking for ${queried} answered ${code}.` }
  }

  return {
    outcome: 'no-record',
    reason:
      code === 'ENODATA'
        ? `${queried} exists but carries no TXT record.`
        : `${queried} does not exist (${code}).`,
  }
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown'
}
