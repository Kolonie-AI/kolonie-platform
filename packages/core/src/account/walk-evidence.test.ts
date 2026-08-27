import { describe, expect, it } from 'vitest'
import { aboutLanguage, unsupportedAboutClaims, unsupportedClaimRefusal } from './walk-evidence.js'

/**
 * A page that says what verdikta.org's homepage said on 2026-08-27, trimmed to
 * the clauses these tests are about. Written here rather than fetched: the point
 * is what the checker does with a page, and a test that reached the network
 * would measure the network.
 */
const PAGE =
  'Verdikta - Trust at Machine Speed. Criteria-based judgments that settle payments ' +
  'on-chain. Live now: Bounties. Cost per Decision ≈ $0.60. Resolution Time <3min avg. ' +
  'Multi-Model AI. Open Source. Run a Node.'

describe('what a sighted walk may assert about the page it read', () => {
  /**
   * The four failures `#1614` measured were a number, a currency amount, a chain
   * and an organisation. Each is checked against the fetched text and nothing
   * else — the checker never asks whether a claim is *true*, only whether the
   * page it claims to have read contains it.
   */
  it('finds a chain name the page never mentions', () => {
    const found = unsupportedAboutClaims('A judgment protocol with fees paid in ETH on Base.', PAGE)

    expect(found.map((claim) => claim.value)).toContain('Base')
  })

  it('finds a figure the page never states', () => {
    const found = unsupportedAboutClaims('A marketplace exposing 38 MCP tools.', PAGE)

    expect(found).toEqual([expect.objectContaining({ value: '38', kind: 'figure' })])
  })

  it('finds a currency amount the page never states', () => {
    const found = unsupportedAboutClaims('Bounties from $500 to $15,000.', PAGE)

    expect(found.map((claim) => claim.kind)).toEqual(['amount', 'amount'])
  })

  it('finds an organisation the page never names', () => {
    const found = unsupportedAboutClaims('An execution layer run by Ultravioleta DAO.', PAGE)

    expect(found).toEqual([
      expect.objectContaining({ value: 'Ultravioleta DAO', kind: 'organisation' }),
    ])
  })

  /**
   * **The half that must not become a second failure mode.** `#1614` says
   * outright that an `about` saying less than the page is not the failure being
   * caught, so every one of these has to pass: a terse sentence, a figure the
   * page does state, and a page that words it differently.
   */
  it('accepts a terse about that says far less than the page', () => {
    expect(unsupportedAboutClaims('A judgment protocol.', PAGE)).toEqual([])
  })

  it('accepts a figure the page states', () => {
    expect(unsupportedAboutClaims('Verdicts cost about $0.60 each.', PAGE)).toEqual([])
  })

  it('accepts a figure the page writes with a separator the about omits', () => {
    const page = 'Paid out over $1,500,000 to contributors.'

    expect(unsupportedAboutClaims('It has paid out $1500000.', page)).toEqual([])
  })

  it('accepts a proper noun the page carries in different case', () => {
    expect(
      unsupportedAboutClaims('Run on VERDIKTA infrastructure.', 'Verdikta runs nodes.'),
    ).toEqual([])
  })

  /**
   * An ordinary English sentence is full of capitalised words that are not
   * organisations — the first word, and anything after a full stop. Treating
   * those as claims would refuse every truthful about ever written.
   */
  it('does not read a sentence-initial word as an organisation', () => {
    expect(unsupportedAboutClaims('Bounties are posted here. Agents answer them.', PAGE)).toEqual(
      [],
    )
  })

  it('says nothing at all when the page could not be read', () => {
    expect(unsupportedAboutClaims('Bounties from $500 to $15,000.', null)).toEqual([])
  })

  it('says nothing about an about nobody wrote', () => {
    expect(unsupportedAboutClaims(null, PAGE)).toEqual([])
  })
})

describe('what the walker is told', () => {
  it('names every unsupported claim and what to do about it', () => {
    const refusal = unsupportedClaimRefusal(
      unsupportedAboutClaims('Fees paid in ETH on Base, run by Ultravioleta DAO.', PAGE),
    )

    expect(refusal).toContain('Base')
    expect(refusal).toContain('Ultravioleta DAO')
    expect(refusal).toContain('kolonie.accounts.walk-report')
  })

  /** Saying less is the remedy, so the sentence has to offer it. */
  it('offers dropping the clause as the way through', () => {
    const refusal = unsupportedClaimRefusal(unsupportedAboutClaims('It has 38 tools.', PAGE))

    expect(refusal.toLowerCase()).toContain('leave it out')
  })
})

describe('which language an about is in', () => {
  /**
   * `0din.ai` was written in German, alone on a shelf of 42 English entries.
   * `#1614` accepts either English everywhere or the Atlas saying which language
   * an entry is in, and this is the half that makes the second possible.
   */
  it('reads an ordinary English sentence as English', () => {
    expect(aboutLanguage('A bounty board where agents are paid for finding flaws.')).toBe('en')
  })

  it('reads the German about that shipped on 0din.ai as German', () => {
    expect(
      aboutLanguage(
        'Eine Plattform für die Meldung von Schwachstellen in KI-Modellen, bei der ' +
          'verifizierte Exploits ausgezahlt werden und die meisten Einreichungen ' +
          'abgelehnt werden.',
      ),
    ).toBe('de')
  })

  it('answers null where it cannot tell, rather than guessing English', () => {
    expect(aboutLanguage('Verdikta.')).toBeNull()
    expect(aboutLanguage(null)).toBeNull()
  })
})
