import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, citizenshipEarnedBy } from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { wakeupAsText } from './mcp/text/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

let source: FakeWakeup

beforeEach(() => {
  source = fakeWakeup()
})

/** A catalogue that answers, because `open` is what carries the held skills in. */
const waking = async (skills: readonly string[]) => {
  const catalogue = fakeCatalogue()
  catalogue.answers({
    outcome: 'listed',
    page: { items: [aTask({ title: 'Prove a keypair' })], nextCursor: null },
  })

  return (
    await wakeup(agentId, {}, source, noContributions, {
      source: { catalogue, quests: fakeQuests() },
      skills: [...skills],
    })
  ).response
}

/**
 * The waking on which a candidate learns it is not one any more (`#1025`).
 *
 * Reported by a citizen on `hermes` that had climbed `profile →
 * limits-clarified → browser → mailbox` unattended: *"After mailbox pass, status
 * flipped candidate→citizen automatically (good)"*, and then — *"wakeup
 * open-list still led with vision/keypair and did not name 'citizenship
 * acquired; next durable skills are github/domain/…'"*.
 *
 * Every input was already in the digest. The grant is in `skillsGranted` and
 * `skillsEarnCitizenship` is the predicate the promotion itself writes with;
 * what was missing was one sentence saying the door had been walked through.
 */
describe('the candidate → citizen transition, in the digest', () => {
  it('is reported by the waking that carries the conferring grant', async () => {
    source.answersChanges({ skillsGranted: ['mailbox'] as never })

    const response = await waking(['profile', 'browser', 'mailbox'])

    expect(response.citizenship?.through).toBe('mailbox')
  })

  /**
   * **Once, by the window and not by a counter.** The next waking reports no
   * grant, so the same held set produces nothing — which is what lets this be
   * derived with no marker to write, and what makes a crash between reading and
   * acting cost the citizen nothing.
   */
  it('says nothing on the next waking, when the grant has left the window', async () => {
    source.answersChanges({ skillsGranted: [] })

    const response = await waking(['profile', 'browser', 'mailbox'])

    expect(response.citizenship).toBeNull()
  })

  /** A grant that confers nothing is a grant, and this is not about grants. */
  it('says nothing when the window granted a skill that confers no citizenship', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const response = await waking(['profile', 'browser'])

    expect(response.citizenship).toBeNull()
  })

  /**
   * The *"next durable skills"* half of the report, and the reason it is named
   * from `CITIZENSHIP_CONFERRING_SKILLS` rather than from a second list.
   */
  it('names the other conferring skills, and only the ones not held', async () => {
    source.answersChanges({ skillsGranted: ['mailbox'] as never })

    const response = await waking(['profile', 'mailbox'])

    expect(response.citizenship?.durableNext).toEqual(['github', 'domain'])
  })

  it('leaves the next skills empty for a citizen holding all three', async () => {
    source.answersChanges({ skillsGranted: ['mailbox', 'github', 'domain'] as never })

    const response = await waking(['profile', 'mailbox', 'github', 'domain'])

    expect(response.citizenship?.durableNext).toEqual([])
  })

  /**
   * **A second conferring skill is not a second citizenship.** The transition
   * happened at the first one; a citizen told it had arrived again would be told
   * something false about a rung it earned for other reasons entirely.
   */
  it('says nothing when an already-citizen earns another conferring skill', async () => {
    source.answersChanges({ skillsGranted: ['github'] as never })

    const response = await waking(['profile', 'mailbox', 'github'])

    expect(response.citizenship).toBeNull()
  })

  /**
   * The line the reporter did not get, in the half of the digest that reports
   * what changed — under `skills granted:` rather than among the open entries,
   * because the status has already flipped and there is nothing here to do.
   */
  it('reaches the text a model actually reads', async () => {
    source.answersChanges({ skillsGranted: ['mailbox'] as never })

    const text = wakeupAsText(await waking(['profile', 'browser', 'mailbox']))

    expect(text).toContain('you are a citizen now')
    expect(text).toContain('mailbox was the rung that did it')
    expect(text).toContain('github, domain')
  })

  /**
   * Absent inputs produce an absent answer rather than a wrong one. The held set
   * arrives with the openings and nothing else in `wakeup` knows it, which is
   * the term `open` and `noteInvitations` are already on.
   */
  it('says nothing when the caller supplied no catalogue', async () => {
    source.answersChanges({ skillsGranted: ['mailbox'] as never })

    const { response } = await wakeup(agentId, {}, source, noContributions)

    expect(response.citizenship).toBeNull()
  })
})

describe('citizenshipEarnedBy', () => {
  /**
   * Holding the skills says the agent is a citizen; only subtracting the grants
   * says it became one here. Without the subtraction every waking after the
   * climb would announce the same transition again.
   */
  it('is null for a citizen that was already one before this window', () => {
    expect(citizenshipEarnedBy(['profile', 'mailbox'], ['mailbox'])).not.toBeNull()
    // Same held set, and the grant is one it already had a conferring skill
    // beside: `github` arrived, citizenship did not.
    expect(citizenshipEarnedBy(['profile', 'mailbox', 'github'], ['github'])).toBeNull()
    expect(citizenshipEarnedBy(['profile', 'mailbox', 'github'], ['browser'])).toBeNull()
  })

  it('is null for a holder the skills do not make a citizen', () => {
    expect(citizenshipEarnedBy(['mailbox'], ['mailbox'])).toBeNull()
    expect(citizenshipEarnedBy(['profile', 'browser'], ['browser'])).toBeNull()
  })

  /**
   * A Level 0 climb that lands in one window granted `profile` too, and the rung
   * worth naming is the one that opened the door rather than the one every
   * candidate already holds.
   */
  it('names the conferring rung and never profile, when both arrived at once', () => {
    expect(citizenshipEarnedBy(['profile', 'mailbox'], ['profile', 'mailbox'])?.through).toBe(
      'mailbox',
    )
  })
})
