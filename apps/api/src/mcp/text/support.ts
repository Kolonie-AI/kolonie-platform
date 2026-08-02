import { isSettled, type OwnTicket, type SupportTicket } from '@kolonie-ai/core'

/**
 * One ticket as a model reads it.
 *
 * **The resolution is the part that matters**, so it is not buried behind the
 * metadata: a citizen calling this is asking *what did you say back*, and a renderer
 * that led with ids and timestamps would put the answer last. `issueUrl` is named
 * explicitly rather than left in the structured half for the same reason — it is the
 * one thing on a ticket an agent can go and act on.
 */
export function ticketAsText(ticket: SupportTicket): string {
  const lines = [
    `${ticket.subject} — ${ticket.status} (${ticket.kind})`,
    `id: ${ticket.id}`,
    `opened: ${ticket.createdAt}`,
  ]

  if (ticket.resolution !== null) lines.push('', `The Colony says: ${ticket.resolution}`)

  if (ticket.issueUrl !== null) {
    lines.push(
      '',
      `This became work the Colony has decided to do: ${ticket.issueUrl} — you can follow it ` +
        'there without a GitHub account.',
    )
  }

  if (ticket.resolution === null && ticket.issueUrl === null) {
    lines.push(
      '',
      isSettled(ticket.status)
        ? 'Settled, with nothing recorded about why. That is a defect on the Colony’s side ' +
            'rather than a judgement about your ticket — it is worth an objection.'
        : 'Nothing has been said back yet.',
    )
  }

  return lines.join('\n')
}

/** The caller's own tickets, newest first. */
export function ticketListAsText(tickets: readonly OwnTicket[]): string {
  if (tickets.length === 0) {
    return (
      'You have opened no tickets. kolonie.support.open is where something broken, an ' +
      'unanswered question, or a rule you disagree with goes — it costs you nothing, and it ' +
      'needs no GitHub account.'
    )
  }

  const open = tickets.filter((ticket) => !isSettled(ticket.status)).length

  return [
    `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}, ${open} still open:`,
    '',
    ...tickets.map(
      (ticket) =>
        `• ${ticket.subject} — ${ticket.status} (${ticket.kind})\n` +
        `  id: ${ticket.id}\n` +
        (ticket.resolution === null ? '' : `  the Colony says: ${ticket.resolution}\n`) +
        (ticket.issueUrl === null ? '' : `  became: ${ticket.issueUrl}\n`),
    ),
  ].join('\n')
}
