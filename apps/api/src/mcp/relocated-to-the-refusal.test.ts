import { randomUUID } from 'node:crypto'
import { REPORT_TOTAL_MAX_LENGTH, SubmissionIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { aTicketRequest } from '../__fixtures__/support.js'

/**
 * What a shortened field description handed to a refusal, asserted at the
 * refusal (`#383`).
 *
 * **This is the regression the issue is most exposed to, and it is silent.** A
 * field description that promised *the refusal will name the limit and the
 * length you sent* can be deleted on the strength of that promise, and nothing
 * fails if the refusal never said it — the schema is simply smaller and a
 * citizen is simply worse off. The acceptance criterion is explicit that moving
 * text to a place that does not yet say it is how this becomes a regression, so
 * each relocation of that shape is asserted here rather than believed.
 *
 * Only the relocations *into a refusal* are here. Text that moved into a task's
 * instructions, into a tool's own answer or into a decision record is asserted
 * where it landed, or is a document a reviewer opens — neither is a runtime
 * promise that can rot without a symptom.
 */
describe('what a field description gave up, the refusal carries', () => {
  /**
   * `totalLimit` on `kolonie.tasks.report` promised that a refusal names the
   * length it measured, so a citizen could cut exactly the overshoot. That
   * sentence is gone from all four fields; this is the refusal it went to.
   *
   * It also asserts the fields the message names, which is the defect `#383`
   * found while checking the promise was true: the message said *did, broke and
   * changed* while the check had summed four fields since `#364`, so a citizen
   * over the limit on `discarded` was told the cap covered three fields not
   * including the one it had just filled in.
   */
  it('names the total it measured, the overshoot, and every field it counted', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    // Four fields, each inside its own per-field ceiling, over the total.
    const answer = 'a'.repeat(REPORT_TOTAL_MAX_LENGTH / 4)
    const refused = await client.callTool({
      name: 'kolonie.tasks.report',
      arguments: {
        taskId: randomUUID(),
        did: answer,
        broke: answer,
        changed: answer,
        discarded: `${answer}xxxxxxxxxx`,
      },
    })
    await close()

    expect(refused.isError).toBe(true)
    const message = JSON.stringify(refused.content)

    // The limit, the measurement, and how much to cut — the three the schema
    // stopped promising.
    expect(message).toContain(String(REPORT_TOTAL_MAX_LENGTH))
    expect(message).toContain(String(REPORT_TOTAL_MAX_LENGTH + 10))
    expect(message).toMatch(/cut at least 10\b/)

    // Every field the total is measured over, including the fourth.
    for (const field of ['did', 'broke', 'changed', 'discarded']) {
      expect(message, field).toContain(field)
    }
  })

  /**
   * `aboutSubmissionId` on `kolonie.support.open` promised three things and now
   * says none of them: that a submission which is not yours is refused, that the
   * ticket is not opened when it is, and that a ticket without the field is read
   * exactly the same. All three are in the refusal.
   */
  it('says the ticket was not opened, and that omitting the field costs nothing', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `relocation-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const refused = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({
        aboutSubmissionId: SubmissionIdSchema.parse(randomUUID()),
      }),
    })
    await close()

    expect(refused.isError).toBe(true)
    const message = JSON.stringify(refused.content)

    expect(message).toMatch(/ticket was not opened/i)
    expect(message).toMatch(/omit aboutSubmissionId/i)
    expect(message).toMatch(/nothing is held against a ticket without it/i)
  })
})
