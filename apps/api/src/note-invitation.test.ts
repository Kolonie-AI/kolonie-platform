import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, wakeupIsQuiet } from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { fakeSkillNotes, type FakeSkillNotes } from './__fixtures__/skill-notes.js'
import { wakeupAsText } from './mcp/text/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

let source: FakeWakeup
let notes: FakeSkillNotes

beforeEach(() => {
  source = fakeWakeup()
  notes = fakeSkillNotes()
})

const waking = async () =>
  (await wakeup(agentId, {}, source, noContributions, undefined, notes)).response

/**
 * The Colony asking for a note at the one moment the answer is still fresh
 * (`#377`).
 *
 * `kolonie.skills.note` was well-specified and **nothing had ever asked a
 * citizen to write one**. Searched across `apps/` and `packages/` on 2026-08-05:
 * the tool appeared in its own registration, in the tool list and in
 * `soliciting-texts.ts`, and in no verdict, no wake-up and no task text. A
 * citizen learned it existed by reading the full tool list and inferring that it
 * should use it.
 *
 * That is the precondition for `#376`. Laying a note in front of a citizen is
 * worth nothing if no note was ever written, and the citizens best placed to
 * write one — those who have just solved something — were exactly the ones never
 * asked.
 */
describe('the invitation to write a note about a skill just granted', () => {
  it('is carried by the wake-up that reports the grant', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const response = await waking()

    expect(response.noteInvitations.map((invitation) => invitation.skill)).toEqual(['browser'])
  })

  it('names the exact call, the way an open entry does', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const [invitation] = (await waking()).noteInvitations

    expect(invitation?.call).toContain('kolonie.skills.note')
    expect(invitation?.call).toContain('skill: browser')
  })

  /**
   * The worked example is the difference between a note and a paraphrase. Asked
   * what it knows about `browser`, a model will write about what a browser is;
   * what no other citizen could have written is the directory, the flag and the
   * failure.
   */
  it('shows what a useful note looks like rather than describing one', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const [invitation] = (await waking()).noteInvitations

    expect(invitation?.example).toContain('survives a restart')
    expect(invitation?.example).toContain('operating detail')
  })

  /**
   * Both facts the tool description carries, so a citizen does not have to open
   * that description to know whether a credential belongs in a note. It does
   * not: the vault does.
   */
  it('says it is private, and that the Colony can read it', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const [invitation] = (await waking()).noteInvitations

    expect(invitation?.example).toContain('no other citizen ever reads it')
    expect(invitation?.example).toContain('The Colony can read it')
    expect(invitation?.example).toContain('kolonie.vault.set')
  })

  /** **The rejection case.** A note already written is not asked for again. */
  it('is absent for a skill that already carries a note', async () => {
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'How I actually start it.')
    source.answersChanges({ skillsGranted: ['browser'] as never })

    expect((await waking()).noteInvitations).toEqual([])
  })

  it('invites only the granted skill that has no note, when one of two does', async () => {
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'How I actually start it.')
    source.answersChanges({ skillsGranted: ['browser', 'mailbox'] as never })

    expect((await waking()).noteInvitations.map((invitation) => invitation.skill)).toEqual([
      'mailbox',
    ])
  })

  it('is absent when nothing was granted in the window', async () => {
    expect((await waking()).noteInvitations).toEqual([])
  })

  /**
   * **Absent rather than invited wrongly.** Without the store there is no way to
   * tell a skill that already carries a note from one that does not, and asking
   * for a note the citizen has already written is the repetition this must not
   * produce.
   */
  it('is absent when the surface has no note store at all', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const response = (await wakeup(agentId, {}, source, noContributions)).response

    expect(response.noteInvitations).toEqual([])
  })

  /**
   * The digest *"measures from a timestamp and writes no marker"*, which is a
   * requirement rather than a property it happens to have — an agent that
   * crashes after reading and before acting has to see the same digest next
   * time. Recording *this citizen has been asked* would be exactly the
   * read-cursor that forbids, so what makes the invitation once is the window:
   * a grant stops being news, and the citizen is never asked again for it.
   */
  it('is not consumed by reading it', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const first = await waking()
    const second = await waking()

    expect(second.noteInvitations).toEqual(first.noteInvitations)
    expect(second.noteInvitations).toHaveLength(1)
  })

  /**
   * A citizen that read the invitation and wrote nothing is not asked again,
   * because by its next waking the grant is behind the window. Nothing was
   * recorded about its choice, and declining left no trace — which is the honest
   * version of *nothing here is scored*.
   */
  it('does not return at the next waking, once the grant is no longer news', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })
    expect((await waking()).noteInvitations).toHaveLength(1)

    source.answersChanges({ skillsGranted: [] })

    expect((await waking()).noteInvitations).toEqual([])
  })

  /**
   * **Nothing is scored, ranked, gated or rewarded**, asserted rather than left
   * to review. Writing the note and declining it produce the same standing, the
   * same reputation and the same skills — the only difference between the two
   * digests is whether the invitation is in it.
   */
  it('changes no reward, no skill and no standing either way', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never, reputationDelta: 3 })

    const declined = await waking()

    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'Written this time.')
    const written = await waking()

    expect(written.standing).toEqual(declined.standing)
    expect(written.reputationDelta).toBe(declined.reputationDelta)
    expect(written.skillsGranted).toEqual(declined.skillsGranted)
    expect(written.open).toEqual(declined.open)
  })

  /**
   * It rides on `skillsGranted`, which already makes a wake-up loud. Counting it
   * again would let a suppressed invitation change nothing while an offered one
   * changed the same fact twice.
   */
  it('does not decide on its own whether a wake-up is quiet', async () => {
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'Already written.')
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const suppressed = await waking()

    expect(suppressed.noteInvitations).toEqual([])
    // Loud because a skill was granted, which is true whether or not the
    // invitation came with it.
    expect(wakeupIsQuiet(suppressed)).toBe(false)
  })

  it('reaches the citizen in the rendered text, under the grant', async () => {
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const text = wakeupAsText(await waking())

    expect(text).toContain('skills granted: browser')
    expect(text).toContain('kolonie.skills.note')
    expect(text).toContain('Write down how you actually did browser')
  })

  it('says nothing in the text when there is nothing to invite', async () => {
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'Already written.')
    source.answersChanges({ skillsGranted: ['browser'] as never })

    const text = wakeupAsText(await waking())

    expect(text).toContain('skills granted: browser')
    expect(text).not.toContain('kolonie.skills.note')
  })
})
