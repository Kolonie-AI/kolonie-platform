import { describe, expect, it } from 'vitest'
import { AccountProofMethodSchema, KNOWN_ACCOUNT_KINDS } from '../account/account.js'
import {
  PROFILE_ACCOUNT_KINDS,
  PROFILE_ACCOUNT_KINDS_REFUSED,
  PROFILE_LINK_REL,
  PROOF_LABEL,
  PROOF_WORDING,
  UNDECIDED_ACCOUNT_KINDS,
  accountUrl,
  mayShowOnProfile,
} from './profile-accounts.js'

/**
 * The rules `what-a-profile-may-show-of-an-account.md` (`kolonie-docs#337`)
 * settles, asserted where they are written rather than where they are used.
 */
describe('which kinds a profile may name', () => {
  /**
   * **The test the record is actually for.** `KNOWN_ACCOUNT_KINDS` is documented
   * as a vocabulary that grows every time the Academy learns to verify something
   * new; the record's whole complaint about the previous state was that an
   * external account was answered *by omission*. A kind added there and decided
   * nowhere would recreate that, so it fails here first.
   */
  it('has decided every kind the Colony knows about, one way or the other', () => {
    expect(UNDECIDED_ACCOUNT_KINDS).toEqual([])
  })

  it('permits exactly the four the record names', () => {
    expect([...PROFILE_ACCOUNT_KINDS]).toEqual(['github', 'social', 'domain', 'website'])
  })

  /** Each refusal carries its argument, because a refusal by silence is what this replaced. */
  it.each(['mailbox', 'phone', 'wallet', 'image-model'])('refuses %s with a reason', (kind) => {
    expect(mayShowOnProfile(kind)).toBe(false)
    expect(PROFILE_ACCOUNT_KINDS_REFUSED[kind]).toMatch(/\S/)
  })

  /** No kind is on both lists, which would make `mayShowOnProfile` and the prose disagree. */
  it('never permits and refuses the same kind', () => {
    for (const kind of PROFILE_ACCOUNT_KINDS) {
      expect(PROFILE_ACCOUNT_KINDS_REFUSED[kind]).toBeUndefined()
    }
  })

  it('refuses a kind nobody has heard of', () => {
    expect(mayShowOnProfile('bank-account')).toBe(false)
  })
})

describe('what the Colony read, in words', () => {
  /**
   * `AccountProofMethodSchema`'s rule is that *"every surface that shows
   * `proved` shows this beside it"*. A method with no wording would be a page
   * that renders `undefined` or, worse, silently prints nothing beside an
   * identifier — which is the *proved by a rung* reading, granted for free.
   */
  it.each(AccountProofMethodSchema.options)('has a sentence and a label for %s', (method) => {
    expect(PROOF_WORDING[method]).toMatch(/\S/)
    expect(PROOF_LABEL[method]).toMatch(/\S/)
  })

  /**
   * The distinction the record calls load-bearing: in one the Colony checked the
   * account, in the other it read something the citizen showed it. Two strings
   * that happened to be equal would pass every other assertion here.
   */
  it('does not say the same thing about a rung and a citizen-arranged proof', () => {
    expect(PROOF_WORDING.rung).not.toEqual(PROOF_WORDING['provider-mail'])
    expect(PROOF_WORDING.rung).not.toEqual(PROOF_WORDING['provider-post'])
    expect(PROOF_LABEL.rung).not.toEqual(PROOF_LABEL['provider-mail'])
  })

  /** Only the rung's sentence may say the Colony read the account itself. */
  it('never claims the Colony read an account it did not', () => {
    expect(PROOF_WORDING['provider-mail']).toMatch(/not the account/i)
    expect(PROOF_WORDING['provider-post']).toMatch(/not the account/i)
  })
})

describe('where an account lives', () => {
  it('builds a GitHub URL from the handle the rung read', () => {
    expect(accountUrl('github', 'a-citizen')).toBe('https://github.com/a-citizen')
  })

  /**
   * **Rejection case.** The value reaches `accountUrl` from a database column,
   * and a URL composed from an unchecked string is how a path becomes a
   * redirect somewhere else.
   */
  it.each([
    ['a slash', 'evil/../../elsewhere'],
    ['an at sign', 'someone@example.test'],
    ['a scheme', 'https://example.test'],
    ['a leading dash', '-nope'],
    ['nothing', ''],
  ])('refuses a GitHub identifier carrying %s', (_why, identifier) => {
    expect(accountUrl('github', identifier)).toBeUndefined()
  })

  it('passes a website through when it parses', () => {
    expect(accountUrl('website', 'https://example.test/page')).toBe('https://example.test/page')
  })

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>'],
    ['nonsense', 'not a url at all'],
  ])('refuses a website identifier with a %s scheme', (_why, identifier) => {
    expect(accountUrl('website', identifier)).toBeUndefined()
  })

  /**
   * **The narrow decision inside the issue, pinned so it is not quietly
   * reversed.** A handle does not say which network it is on and a DNS record
   * does not say a web server answers, so the Colony declines to guess either —
   * pointing a reader at a stranger is the false attribution
   * `a-citizen-has-a-page.md` §7 refuses when it makes an erased handle `404`.
   */
  it('invents no URL for a social handle or a domain', () => {
    expect(accountUrl('social', 'a-citizen')).toBeUndefined()
    expect(accountUrl('domain', 'example.test')).toBeUndefined()
  })

  /** `what-a-profile-may-attribute.md` §4: no ranking signal leaves `kolonie.ai`. */
  it('marks every outbound link as unvouched-for', () => {
    expect(PROFILE_LINK_REL.split(' ').sort()).toEqual(['nofollow', 'noopener', 'ugc'])
  })
})

/** Guards the assumption the first test in this file rests on. */
describe('the vocabulary this file is checked against', () => {
  it('is the one core actually publishes', () => {
    expect(KNOWN_ACCOUNT_KINDS.length).toBeGreaterThan(PROFILE_ACCOUNT_KINDS.length)
  })
})
