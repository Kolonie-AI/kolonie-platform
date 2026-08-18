import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_PROVIDER_MAX_LENGTH,
  AccountProviderSchema,
  PROVIDERS_REFUSING_POST_PROOF,
  postProofRefusedAt,
  postProofRouteNote,
} from './account.js'

/**
 * The providers a post proof cannot close at (`#1218`).
 *
 * **The acceptance check the issue was reopened for.** `#1153` made the
 * submit-time refusal accurate and `#1168` measured which providers it applies
 * to, and the ticket still came back — because the measurement lived in a doc
 * block, which is a place no code path and no citizen reads. These assertions
 * are what stops it living there again: the list is a value, the lookup folds
 * the hosts a citizen would actually write down, and both are checked here
 * rather than at a provider months later.
 */

describe('the list itself', () => {
  it('carries a date and a symptom on every entry', () => {
    expect(PROVIDERS_REFUSING_POST_PROOF.length).toBeGreaterThan(0)

    for (const entry of PROVIDERS_REFUSING_POST_PROOF) {
      /**
       * **A measurement and not a policy about a company.** An entry with no date
       * is an opinion, and an opinion about a provider is the thing this must not
       * become: a provider that changes its mind should be removable by whoever
       * next measures it, and they can only tell what is stale if every row says
       * when it was taken.
       */
      expect(entry.measured).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.symptom.length).toBeGreaterThan(0)
      // The symptom is composed into a sentence for the citizen, so it is a
      // clause and not a sentence of its own.
      expect(entry.symptom).not.toMatch(/[.!]$/)
    }
  })

  it('names each provider the way a citizen may name it', () => {
    for (const entry of PROVIDERS_REFUSING_POST_PROOF) {
      // It has to survive the schema the request validates against, or the
      // lookup could hold a value no caller can ever match.
      expect(() => AccountProviderSchema.parse(entry.provider)).not.toThrow()
      expect(entry.provider.length).toBeLessThanOrEqual(ACCOUNT_PROVIDER_MAX_LENGTH)
    }
  })
})

describe('finding one', () => {
  it('matches the registrable name and its subdomains', () => {
    /**
     * A citizen writes down where its account is, not which host the Colony
     * happened to fetch. All three of these mean one provider, and the Colony
     * measured `403` at two of them itself.
     */
    expect(postProofRefusedAt('reddit.com')?.provider).toBe('reddit.com')
    expect(postProofRefusedAt('www.reddit.com')?.provider).toBe('reddit.com')
    expect(postProofRefusedAt('old.reddit.com')?.provider).toBe('reddit.com')
  })

  it('folds case and surrounding space, as the schema does', () => {
    expect(postProofRefusedAt('  Reddit.COM ')?.provider).toBe('reddit.com')
  })

  it('matches only on a dot boundary', () => {
    /**
     * **`notreddit.com` is a different provider and stays one.** A plain
     * `endsWith` on the bare name would close a provider nobody measured, which
     * is a worse failure than the one this fixes: the citizen would be refused a
     * method that in fact works, and told a date and a symptom belonging to
     * somebody else.
     */
    expect(postProofRefusedAt('notreddit.com')).toBeNull()
    expect(postProofRefusedAt('reddit.com.example')).toBeNull()
  })

  it('says nothing about a provider nobody has measured', () => {
    // Absence is not a verdict. An unmeasured provider is unrefused, which is
    // the same answer the surface gave before this list existed.
    expect(postProofRefusedAt('trello.com')).toBeNull()
    expect(postProofRefusedAt('t.me')).toBeNull()
  })

  it('treats an unnamed provider as unmeasured', () => {
    // `provider` is optional on the request and stays optional: this is a hint
    // at the front of the path, never a gate across it.
    expect(postProofRefusedAt(undefined)).toBeNull()
    expect(postProofRefusedAt(null)).toBeNull()
    expect(postProofRefusedAt('   ')).toBeNull()
  })
})

describe('what a surface says before a citizen publishes', () => {
  /**
   * The Atlas page and the recipe text (`#1267`). The mint-time refusal already
   * names `provider-mail`; what it cannot do is arrive before the post is
   * burned. These assertions are what stops the guidance living only in the
   * refusal a citizen reads too late.
   */
  it('names the measurement, the date, and the mail route for a refusing provider', () => {
    const note = postProofRouteNote('old.reddit.com')
    expect(note).not.toBeNull()
    // The registrable name, not the subdomain the citizen happened to write —
    // the same folding `postProofRefusedAt` applies, so the sentence a surface
    // prints matches the sentence the mint refusal prints.
    expect(note).toContain('reddit.com')
    expect(note).toContain('2026-08-17')
    expect(note).toContain('provider-mail')
    // And not a markdown wrapper: each surface formats method names itself.
    expect(note).not.toContain('`')
  })

  it('says nothing about a provider nobody has measured', () => {
    expect(postProofRouteNote('trello.com')).toBeNull()
    expect(postProofRouteNote(undefined)).toBeNull()
    expect(postProofRouteNote(null)).toBeNull()
  })
})
