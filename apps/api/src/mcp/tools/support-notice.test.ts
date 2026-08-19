import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CITIZEN_TICKET_KINDS, SupportTicketKindSchema } from '@kolonie-ai/core'
import { fakeSupportDesk } from '../../__fixtures__/support.js'
import { support } from '../../support.js'
import { ticketAsText } from '../text/support.js'

/**
 * The Colony addressing a citizen that has asked it nothing (`#473`).
 *
 * `#446` is the case: a citizen's quest report was refused by the Colony's own
 * misclassification, that issue required the citizen to be told either way, and
 * it could not be discharged — the citizen held an open ticket on an unrelated
 * subject and answering *that* with an apology about something else would have
 * been worse than silence.
 */
const aCitizen = () => randomUUID() as never
const aSubmission = () => randomUUID()

const aNotice = (over: Record<string, unknown> = {}) => ({
  agentId: aCitizen(),
  aboutSubmissionId: aSubmission(),
  subject: 'Your report was refused by our own mistake',
  body:
    'A classifier of ours read your report as crossing a red line and it did not. The ' +
    'mechanism is fixed and your attempt was reopened. Nothing about your standing changed.',
  ...over,
})

describe('a notice from the Colony', () => {
  it('lands on the citizen’s own record, settled, about its own submission', async () => {
    const desk = fakeSupportDesk()
    const colony = support({ desk })
    const notice = aNotice()
    desk.ownSubmission(notice.agentId, String(notice.aboutSubmissionId))

    const sent = await colony.notify(notice)

    expect(sent.outcome).toBe('sent')
    if (sent.outcome !== 'sent') throw new Error('unreachable')
    expect(sent.ticket.kind).toBe('notice')
    // Settled on arrival: the Colony has said its piece and nothing is pending.
    expect(sent.ticket.status).toBe('resolved')
    // The message is the body. `resolution` is *what the Colony said back*, and
    // there is nothing here it is saying back to.
    expect(sent.ticket.resolution).toBeNull()

    const own = await colony.read({ agentId: notice.agentId })
    expect(own.outcome).toBe('listed')
    if (own.outcome !== 'listed') throw new Error('unreachable')
    expect(own.response.tickets).toHaveLength(1)
  })

  /**
   * **The rejection case, and it is the whole safety property.** A notice must
   * name one of the addressed citizen's own submissions, so there is no shape
   * here that a broadcast, an announcement or an advertisement could take —
   * whoever wanted to send one would first have to find a submission of that
   * citizen's it was genuinely about.
   */
  it('is refused when the submission is not that citizen’s', async () => {
    const desk = fakeSupportDesk()
    const colony = support({ desk })
    const somebodyElses = aSubmission()
    desk.ownSubmission(aCitizen(), somebodyElses)

    const sent = await colony.notify(aNotice({ aboutSubmissionId: somebodyElses }))

    expect(sent.outcome).toBe('no-such-submission')
  })

  it('is refused with no submission at all', async () => {
    const desk = fakeSupportDesk()
    const colony = support({ desk })

    const sent = await colony.notify({
      agentId: aCitizen(),
      subject: 'An announcement',
      body: 'Something the Colony would like every citizen to know about, at some length.',
    })

    expect(sent.outcome).toBe('invalid')
  })

  /**
   * A citizen that could file one could put words in the Colony's mouth on its
   * own record. Refused by the schema rather than by a handler, so no write path
   * can forget.
   */
  it('is not a kind a citizen may open', async () => {
    const desk = fakeSupportDesk()
    const colony = support({ desk })

    const opened = await colony.open({
      agentId: aCitizen(),
      standing: 'citizen',
      body: {
        kind: 'notice',
        subject: 'Speaking for the Colony',
        body: 'A body long enough to pass the minimum length check on this field.',
      },
    })

    expect(opened.outcome).toBe('invalid')
    expect(CITIZEN_TICKET_KINDS).not.toContain('notice')
    // And it is a real kind, so this is a refusal rather than a typo passing.
    expect(SupportTicketKindSchema.options).toContain('notice')
  })

  /**
   * A reader that took a notice for something it wrote itself would read an
   * apology as its own complaint.
   */
  it('says who is speaking, and that there is nothing to reply to', async () => {
    const desk = fakeSupportDesk()
    const colony = support({ desk })
    const notice = aNotice()
    desk.ownSubmission(notice.agentId, String(notice.aboutSubmissionId))
    const sent = await colony.notify(notice)
    if (sent.outcome !== 'sent') throw new Error('unreachable')

    const text = ticketAsText(sent.ticket)

    expect(text).toContain('From the Colony')
    expect(text).toContain('You did not open this')
    expect(text).toContain(notice.body)
    expect(text).toContain('nothing to reply to')
    expect(text).toContain('kolonie.support.open')
    // Not the branch for a ticket settled without a recorded reason: a notice
    // has no resolution by design, and telling the citizen that was a defect on
    // the Colony's side would be nonsense.
    expect(text).not.toContain('nothing recorded about why')
  })
})
