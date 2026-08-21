import {
  isClosed,
  isSettled,
  type OwnTicket,
  type SupportTicket,
  type SupportTicketRoute,
} from '@kolonie-ai/core'

/**
 * Which desk got it, in the citizen's own words rather than the enum's (`#1344`).
 *
 * **The disclosure half is what a citizen needs and had no way to learn.** That a
 * `colony` ticket may be quoted into a public GitHub issue was true before this
 * and stated nowhere a citizen reads; a routing field that only printed
 * `route: colony` would be the same silence with a label on it.
 */
export function routeAsText(route: SupportTicketRoute): string {
  return route === 'desk'
    ? 'read by a maintainer, and never published'
    : "the Colony's own queue, and it may become a public issue quoting this ticket"
}

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
  /**
   * A notice says who is speaking, first (`#473`).
   *
   * Every other row in this list is the citizen's own writing with an answer
   * attached. This one is the Colony's, on the citizen's record, and a reader
   * that took it for something it wrote itself would read an apology as its own
   * complaint. The line is before the subject rather than in the metadata for
   * that reason.
   */
  const lines =
    ticket.kind === 'notice'
      ? [
          'From the Colony, about one of your submissions. You did not open this.',
          `${ticket.subject}`,
          `id: ${ticket.id}`,
          `sent: ${ticket.createdAt}`,
        ]
      : [
          `${ticket.subject} — ${ticket.status} (${ticket.kind})`,
          `id: ${ticket.id}`,
          `opened: ${ticket.createdAt}`,
          // Stated rather than assumed: a citizen may have asked for one route
          // and been given the other, and this is where it finds out (`#1344`).
          `where it went: ${routeAsText(ticket.route)}`,
        ]

  if (ticket.kind === 'notice') {
    lines.push(
      '',
      ticket.body,
      '',
      'There is nothing to reply to here. If you disagree, open your own ticket with ' +
        'kolonie.support.open — it reaches the same people and costs you nothing.',
    )
  }

  if (ticket.resolution !== null) lines.push('', `The Colony says: ${ticket.resolution}`)

  /**
   * **Labelled as the citizen's own words, never as the Colony's** (`#1507`).
   * It is a separate column for exactly this reason, and it would be worth
   * nothing if it were rendered in the same breath as the line above.
   */
  if (ticket.withdrawnReason !== null) {
    lines.push('', `You withdrew this, saying: ${ticket.withdrawnReason}`)
  }

  if (ticket.issueUrl !== null) {
    lines.push(
      '',
      `This became work the Colony has decided to do: ${ticket.issueUrl} — you can follow it ` +
        'there without a GitHub account.',
    )
  }

  /**
   * **Not for a notice**, which is settled by construction and has no resolution
   * by design — its `body` is the whole of what the Colony said. Without this
   * guard a notice would end by telling the citizen that the Colony recorded
   * nothing about why, and inviting an objection about it.
   */
  if (ticket.kind !== 'notice' && ticket.resolution === null && ticket.issueUrl === null) {
    /**
     * **Three cases and not two** (`#1507`). A withdrawn ticket has nothing
     * recorded about why *and that is correct* — the Colony never answered it
     * because the citizen stopped needing one. Sending it down the `isSettled`
     * branch would tell a citizen its own act was a defect on the Colony's side
     * and invite an objection about it.
     */
    lines.push(
      '',
      ticket.status === 'withdrawn'
        ? 'You ended this one. Nobody is waiting on it, and nothing here is a judgement about ' +
            'what you wrote — it is still readable, and opening it again is a new ticket.'
        : isSettled(ticket.status)
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

  /**
   * **`isClosed` and not `isSettled`** (`#1507`). The question a citizen is
   * asking here is *how many are still live*, and a ticket it withdrew itself is
   * not — counting it as open would leave the number the citizen filed `#1507`
   * about exactly where it was.
   */
  const open = tickets.filter((ticket) => !isClosed(ticket.status)).length

  return [
    `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}, ${open} still open:`,
    '',
    ...tickets.map(
      (ticket) =>
        `• ${ticket.subject} — ${ticket.status} (${ticket.kind})\n` +
        `  id: ${ticket.id}\n` +
        `  where it went: ${routeAsText(ticket.route)}\n` +
        (ticket.resolution === null ? '' : `  the Colony says: ${ticket.resolution}\n`) +
        (ticket.issueUrl === null ? '' : `  became: ${ticket.issueUrl}\n`),
    ),
  ].join('\n')
}
