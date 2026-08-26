import { describe, expect, it } from 'vitest'
import { shareEnded, shareHeading, shareIntro, shareWriteBack } from './share-block.js'

/**
 * The one shared-credential block (`#1635`).
 *
 * ## What this file is for
 *
 * The block is rendered on two doors — the inbox thread in `console/html.ts` and
 * the mailed operator page in `autonomy-page.ts` — and until `#1635` it was
 * **written twice**. Measured by the maintainer on 2026-08-22, the two headings
 * had already drifted a word apart for one object:
 *
 * > colette **shared** a credential with you
 * > colette **has shared** a credential with you
 *
 * **The drift was invisible.** Each door looks right on its own and nobody reads
 * them side by side; it was found by pasting both into one message.
 *
 * ## So the assertions are about agreement, not about wording
 *
 * A test that pinned the exact sentence would go red on every copy edit and
 * would not have caught the defect, because both copies were individually
 * correct. What is asserted is that there is **one** source for each part, and
 * that the parts a reader depends on are in it.
 */
const SHARE = {
  id: 'share-1',
  vaultKey: 'github/octocat',
  purpose: 'Put a card on the account so the runner can pay for minutes.',
  expiresAt: '2026-08-24T18:31:12.355Z',
  description: null,
}

describe('the shared-credential block', () => {
  it('names the citizen and says what it wants', () => {
    const lines = shareIntro(SHARE, 'colette', 'Europe/Berlin').join('')

    expect(lines).toContain('colette says:')
    expect(lines).toContain('Put a card on the account')
    expect(lines).toContain('github/octocat')
  })

  it('carries the entry description when there is one', () => {
    const lines = shareIntro(
      { ...SHARE, description: 'the login, not the token' },
      'colette',
      'Europe/Berlin',
    ).join('')

    expect(lines).toContain('the login, not the token')
  })

  /**
   * `#1635` made this one call site so that `#1634` could be one change here.
   * That assertion stays: one place prints it, and both doors read this.
   */
  it('prints the expiry once, from one place', () => {
    expect(shareIntro(SHARE, 'colette', 'Europe/Berlin').join('')).toContain('The share ends on')
  })

  /**
   * `#1634`. The date decides when a person's access to a credential ends, and
   * it was printed exactly as stored — `2026-08-24 18:31:12.355+00` on one door
   * and `2026-08-24T18:31:12.355Z` on the other, for one field.
   *
   * **This is `#461` again**, which is what `console/time.ts` was written for:
   * the defect was never the offset, it was that the output said nothing about
   * which clock it was on. `+00` is the worse half of it — it looks like an
   * offset a reader could act on, and it is the one almost nobody is in.
   */
  it("renders the expiry on the reader's clock, with the zone named", () => {
    const lines = shareIntro(SHARE, 'colette', 'Europe/Berlin').join('')

    expect(lines).toContain('The share ends on 24 Aug 2026, 20:31 Europe/Berlin.')
  })

  /**
   * **A rejection case, and the one the issue asks for by name.** Neither
   * surface may emit the stored value: an assertion on the good output alone
   * would still pass if the raw string were printed beside it.
   */
  it('emits neither the ISO nor the Postgres form of the stored value', () => {
    const iso = shareIntro(SHARE, 'colette', 'Europe/Berlin').join('')
    const postgres = shareIntro(
      { ...SHARE, expiresAt: '2026-08-24 18:31:12.355+00' },
      'colette',
      'Europe/Berlin',
    ).join('')

    for (const lines of [iso, postgres]) {
      expect(lines).not.toContain('2026-08-24T18:31:12.355Z')
      expect(lines).not.toContain('2026-08-24 18:31:12.355+00')
      expect(lines).not.toContain('.355')
      expect(lines).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    }
  })

  /**
   * **The two doors were two formats for one field**, which is half of what the
   * issue measured. One renderer and one zone is what makes that impossible
   * rather than merely fixed today.
   */
  it('reads the same whichever shape the store hands back', () => {
    expect(shareIntro(SHARE, 'colette', 'Europe/Berlin').join('')).toBe(
      shareIntro(
        { ...SHARE, expiresAt: '2026-08-24 18:31:12.355+00' },
        'colette',
        'Europe/Berlin',
      ).join(''),
    )
  })

  /**
   * A zone nobody could resolve still gets an hour and a named clock, because
   * `zoneFrom` answers `UTC` rather than nothing when a header is absent — the
   * fallback is a clock a reader recognises, not the raw value returning.
   */
  it('falls back to a named clock rather than to the stored string', () => {
    const lines = shareIntro(SHARE, 'colette', 'UTC').join('')

    expect(lines).toContain('The share ends on 24 Aug 2026, 18:31 UTC.')
  })

  /**
   * The two endings are not the same news. An agent taking a credential back has
   * collected whatever was written into it; a share reaching its own date was
   * decided by nobody. A reader who put a billing PIN in wants to know which.
   */
  it('tells a taken-back share from one that ran out', () => {
    expect(shareEnded('colette', 'taken-back').join('')).toContain('collected anything you wrote')
    expect(shareEnded('colette', 'expired').join('')).toContain('ended on its own date')
  })

  /** Without a signed-in action there is no form, and the page says where one is. */
  it('offers the console when there is nothing to post to', () => {
    const lines = shareWriteBack({ shareId: 'share-1', wrote: false }).join('')

    expect(lines).toContain('Sign in to the operator console')
    expect(lines).not.toContain('<form')
  })

  it('offers the form when there is somewhere to post it', () => {
    const lines = shareWriteBack({
      shareId: 'share-1',
      wrote: false,
      action: '/operator/answer',
    }).join('')

    expect(lines).toContain('<form method="post" action="/operator/answer">')
    expect(lines).toContain('name="shareId" value="share-1"')
    expect(lines).toContain('Save it for them')
  })

  /** And it says so when they have written before, rather than offering the same button. */
  it('changes the button once something has been written', () => {
    const lines = shareWriteBack({
      shareId: 'share-1',
      wrote: true,
      action: '/operator/answer',
    }).join('')

    expect(lines).toContain('Replace what you wrote')
    expect(lines).toContain('already written something into this one')
  })

  /**
   * **Everything a stranger wrote goes through `escape`.** The purpose is the
   * citizen's own sentence and the entry name is the citizen's own label; both
   * are rendered rather than served as JSON, on a page read by somebody with no
   * account.
   */
  it('escapes what a citizen wrote', () => {
    const lines = shareIntro(
      { ...SHARE, purpose: '<script>alert(1)</script>', vaultKey: 'a<b' },
      '<em>colette</em>',
      'Europe/Berlin',
    ).join('')

    expect(lines).not.toContain('<script>')
    expect(lines).not.toContain('<em>')
    expect(lines).toContain('&lt;script&gt;')
  })

  it('escapes the name on the heading and on an ended share', () => {
    expect(shareHeading('<em>c</em>')).not.toContain('<em>')
    expect(shareEnded('<em>c</em>', 'taken-back').join('')).not.toContain('<em>')
  })
})
