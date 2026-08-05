import { describe, expect, it } from 'vitest'
import { CAPABILITY_TERMS, capabilityMismatches } from './capability-terms.js'

const aQuest = (overrides: Partial<Parameters<typeof capabilityMismatches>[0]> = {}) => ({
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  requires: [],
  ...overrides,
})

describe('a quest that asks for a capability and requires nothing', () => {
  it('names the term that fired and the skill it points at', () => {
    const flags = capabilityMismatches(
      aQuest({
        description: 'Open the page in a browser and complete the sign-up.',
        instructions: 'Report what the form asked for.',
        title: 'Registering by hand',
      }),
    )

    expect(flags).toEqual([{ term: 'browser', skill: 'browser' }])
  })

  it('reads the title, the description and the instructions alike', () => {
    expect(
      capabilityMismatches(
        aQuest({ title: 'What a wallet costs', description: 'Nothing.', instructions: 'Report.' }),
      ),
    ).toEqual([{ term: 'wallet', skill: 'wallet' }])
  })

  /**
   * The rejection case the issue asks for: a sponsor that has taken the
   * decision is not second-guessed about it.
   */
  it('is silent once the quest requires anything at all', () => {
    const asked = aQuest({
      description: 'Open the page in a browser and check the mailbox it sends to.',
    })

    expect(capabilityMismatches({ ...asked, requires: ['browser'] })).toEqual([])
    expect(capabilityMismatches({ ...asked, requires: ['profile'] })).toEqual([])
  })

  it('says nothing about a quest that describes no capability', () => {
    expect(
      capabilityMismatches(
        aQuest({
          title: 'What was hard',
          description: 'Tell us what you found difficult about arriving here.',
          instructions: 'Answer in your own words.',
        }),
      ),
    ).toEqual([])
  })

  /** A flag that fires on a substring is the flag a steward stops reading. */
  it('matches a term as a word rather than inside another', () => {
    expect(
      capabilityMismatches(
        aQuest({
          title: 'Pinbox and dnsmasq',
          description: 'Neither of these is a capability.',
          instructions: 'Report.',
        }),
      ),
    ).toEqual([])
  })

  it('reports every term that fired, so the reason is never one of several', () => {
    const flags = capabilityMismatches(
      aQuest({
        title: 'A domain and a wallet',
        description: 'Point the DNS at the address and pay in USDC.',
        instructions: 'Report what happened.',
      }),
    )

    expect(flags.map((flag) => flag.term)).toEqual(['wallet', 'usdc', 'domain', 'dns'])
  })

  /** One place, and each term says what it points at — the whole design. */
  it('keeps every term pointed at a skill', () => {
    for (const { term, skill } of CAPABILITY_TERMS) {
      expect(term.length).toBeGreaterThan(2)
      expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })
})
