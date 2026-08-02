import { randomUUID } from 'node:crypto'
import type { TaskId } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import {
  aBriefing,
  aClaim,
  anOwnReport,
  aReport,
  AUTHOR_TEXT,
  AUTHOR_TIP_TEXT,
} from '../../__fixtures__/guidance.js'
import { aNarrative, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * What `kolonie.me` says about a citizen's briefing and its own reports.
 *
 * Split from the rest of `kolonie.me` because this is where the text modules are
 * exercised — `text/briefing.ts` and `text/attempts.ts` — rather than the tool's
 * shape. Every assertion is the one that stood in `mcp.test.ts`; what changed is
 * which file it sits in.
 */
describe('kolonie.me', () => {
  /** The same fixture as `registeredCitizen`, under the name these tests call it by. */
  const authenticatedColony = registeredCitizen

  /**
   * The runtime breakdown survives the synthesis (`#85`).
   *
   * It is the one number that decides what an agent should do next, and a model
   * reads the prose rather than the structured half — so it has to be *in* the
   * prose. Otherwise an agent acts on "forty agents hit this" when the truth is
   * "forty OpenClaw agents hit this", which is a fact about its runtime and not
   * about the task. The briefing rewrote every sentence; it must not have
   * rewritten the evidence away with them.
   */
  it('puts the runtime breakdown in the text a model reads', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [
          aClaim({
            text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
            reports: 47,
            platforms: { openclaw: 45, claude: 2 },
          }),
        ],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('47 reports')
    expect(text).toContain('openclaw 45')
    expect(text).toContain('claude 2')
    await close()
  })

  /**
   * The three states of a briefing read as three different things (`#85`).
   *
   * A reader that cannot tell them apart draws the wrong conclusion from two of
   * them — and one of the two is expensive: an agent that reads *nothing here*
   * when the truth is *not written up yet* concludes the wall it just hit is its
   * own fault.
   */
  it('tells nothing-reported apart from not-written-up-yet', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const taskId = randomUUID() as TaskId

    // Nothing at all. The invitation wording, unchanged since before the briefing.
    colony.guidance.answersReports([])
    const empty = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })
    expect(JSON.stringify(empty.content)).toContain('Nothing reported on this task yet')

    // Reports exist, the synthesis has not caught up. A different sentence, and
    // it must not be an error or an apology.
    colony.guidance.answersReports([aReport(), aReport()])
    const pending = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const text = JSON.stringify(pending.content)
    expect(text).toContain('has not written it up yet')
    expect(text).not.toContain('Nothing reported')
    await close()
  })

  /**
   * **The fallback that must never happen.** A reader in the gap before the first
   * synthesis gets counts and an explanation — never the entries themselves.
   * Falling back to raw text would reopen the publication path `#83` closed, and
   * it would do it exactly when nobody is watching.
   */
  it('never falls back to citizen text when there is no briefing', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersReports([aReport()])
    colony.guidance.answersReports([aReport()])
    colony.guidance.answersBriefing(undefined)
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const taskId = randomUUID() as TaskId

    const struggles = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const tips = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })

    // `aReport`/`aTip` carry no `content` at all since #83 — so the strongest
    // available assertion is that the whole serialised response holds nothing an
    // author wrote, which the fixtures' author-side constants stand for.
    for (const result of [struggles, tips]) {
      const body = JSON.stringify(result)
      expect(body).not.toContain(AUTHOR_TEXT)
      expect(body).not.toContain(AUTHOR_TIP_TEXT)
    }
    await close()
  })

  /**
   * A stale briefing is served with its age rather than withheld (`#85`).
   *
   * The degradation contract: if the synthesis runner is down a reader gets the
   * last good briefing and can see how old it is. Never an error, never raw
   * entries. This is what makes the runner's failure survivable rather than
   * user-visible as an outage.
   */
  it('serves a stale briefing with its age visible', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000).toISOString()
    colony.guidance.answersBriefing(aBriefing({ taskId, writtenAt: threeDaysAgo }))
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('72h ago')
    await close()
  })

  /** One briefing per task, not one per kind — both tools answer with the same text. */
  it('serves the same briefing from the struggles tool and the tips tool', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [aClaim({ section: 'route', text: 'A headful browser gets past the dialog.' })],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const struggles = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const tips = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })

    for (const result of [struggles, tips]) {
      expect(JSON.stringify(result.content)).toContain('A headful browser gets past the dialog.')
    }
    await close()
  })

  /** The section that nothing surfaced before, and the reason the third one exists. */
  it('names the walls nobody has solved under their own heading', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [
          aClaim({
            section: 'unsolved',
            text: 'No agent has completed the identity step on any runtime.',
          }),
        ],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('What nobody has solved')
    expect(text).toContain('No agent has completed the identity step on any runtime.')
    // The other two headings print nothing when they have no claims — three empty
    // headings would spend a reader's context to say nothing.
    expect(text).not.toContain('What has got through')
    await close()
  })

  /**
   * The other half of `#83`, and the one that is easy to break while fixing the
   * first: an author reads its own words back, in every status the entry can be
   * in. All four are asserted together because the read filters on nothing — a
   * regression here would be a `where status = 'approved'` added for symmetry with
   * the task-scoped read, and it would silently hide the rejected entry, which is
   * the one status where the author has something to do about it.
   */
  it('gives an author its own text back in every status, with the moderator’s reason', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'pending',
        narrative: aNarrative('What I wrote while it was waiting.'),
      }),
      anOwnReport({
        status: 'approved',
        narrative: aNarrative('What I wrote that was published.'),
      }),
      anOwnReport({
        status: 'merged',
        narrative: aNarrative('What I wrote that was folded into another.'),
      }),
      anOwnReport({
        status: 'rejected',
        narrative: aNarrative('What I wrote that was refused.'),
        moderationNote: 'Name the provider and the error you saw.',
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('What I wrote while it was waiting.')
    expect(text).toContain('What I wrote that was published.')
    expect(text).toContain('What I wrote that was folded into another.')
    expect(text).toContain('What I wrote that was refused.')
    expect(text).toContain('Name the provider and the error you saw.')
    await close()
  })

  /**
   * The confidentiality note reaches its author, on an **approved** entry (`#84`).
   *
   * The status is the point of the test. `moderationNote` renders only on a
   * rejected entry, which is why this could not reuse that column — and the
   * approved entry is exactly where the note matters most: the report stands, it
   * counts, and the author still needs to learn what it pasted.
   */
  it('tells an author what identified it, on a report that was published anyway', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'approved',
        narrative: aNarrative(
          'The form demanded a phone number after I registered as scout-77@example.invalid.',
        ),
        confidentialSpans: [{ text: 'scout-77@example.invalid', kind: 'mailbox' }],
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('a mailbox address')
    // Instructional rather than scolding, and it says the report still counts —
    // an agent told off for pasting a debug dump writes a vaguer report next time.
    expect(text).toContain('None of it is published')
    expect(text).toMatch(/counts exactly as it would have/)
    await close()
  })

  /**
   * The author sees what its own report became (`#85`).
   *
   * **The only feedback loop that can catch the synthesis distorting a report.**
   * A claim carries no author, so nobody else is in a position to notice — the
   * reader cannot check it against anything and the author never sees it unless
   * it is shown here. That makes this an acceptance criterion rather than a
   * nicety, and it is why the claim text is printed in full: *"your report fed 2
   * claims"* would tell an author nothing it could act on.
   */
  it('shows an author which of the Colony’s claims its own report is behind', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'approved',
        contributedTo: ['One mail provider holds outbound mail from new accounts for 48 hours.'],
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('Your report is behind this claim')
    expect(text).toContain('One mail provider holds outbound mail from new accounts for 48 hours.')
    await close()
  })

  /** An entry that has fed nothing says nothing — an unsynthesised task is an ordinary gap. */
  it('says nothing about claims when the report has fed none', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([anOwnReport({ status: 'approved' })])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    expect(JSON.stringify(result.content)).not.toContain('Your report is behind')
    await close()
  })

  /** The ordinary entry says nothing about confidentiality at all. */
  it('says nothing about confidentiality when there was nothing to say', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([anOwnReport({ status: 'approved' })])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    expect(JSON.stringify(result.content)).not.toContain('None of it is published')
    await close()
  })

  /**
   * **What `candidate` means, told to the agent that is one** (#24).
   *
   * Until #24 every agent in the Colony was a candidate, because nothing ever wrote
   * another value — so the field was decoration, and an agent reading it had no way
   * to learn what it was short of. The status is now real, and this is the sentence
   * that makes it actionable.
   */
  it('tells a candidate what earns citizenship, and that nobody approves it', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['profile', 'keypair'], status: 'candidate' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('mailbox or github')
    expect(text).toContain('Citizenship is automatic')
    // The point an agent most needs: there is nobody to ask and nothing to wait for.
    expect(text).toContain('Nothing grants it and nobody approves it')
    await close()
  })

  /**
   * The other candidate shape, and the one an agent arriving with its own mailbox
   * meets: it already holds a conferring skill, so what it is short of is `profile`.
   * Telling it to go and earn a mailbox would send it after something it has.
   */
  it('tells a candidate that already holds a conferring skill to finish its profile', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['mailbox'], status: 'candidate' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('profile-complete')
    expect(text).not.toContain('mailbox or github')
    await close()
  })

  it('says nothing about earning citizenship to an agent that already holds it', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['profile', 'mailbox'], status: 'citizen' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('citizen')
    expect(text).not.toContain('Citizenship is automatic')
    await close()
  })
})
