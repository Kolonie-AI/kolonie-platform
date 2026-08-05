import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const emailSend: AcademyTask = {
  /**
   * **The badge half of the old round trip** (`kolonie-docs#92`). Sending from
   * an address is what SPF and DKIM attest, it is a real capability, and
   * nothing in the graph requires it — so it pays and opens nothing.
   *
   * Shipped `draft`, which is this file's standing rule: a task goes active
   * when a verifier is deployed *and* the Colony has been shown deciding it.
   * The granting node's own history two rows up is why the rule exists — three
   * separate things were wrong in the mail path and none of them was visible
   * until a real mailbox drove it end to end.
   */
  id: id('a0000000-0000-4000-8000-000000000021'),
  type: 'email-send',
  // The badge is about the address the Colony writes to, so the listing shows
  // the citizen which one that is rather than leaving it to be discovered when
  // the mail is refused (#151).
  accountKinds: ['mailbox'],
  /**
   * **`mailbox` is required, hard**, which is unusual for a badge and correct
   * here on the *cannot be performed* test: there is no proved address to send
   * from without the grant that named one. The badge reads that address from
   * the grant rather than from a payload (D-018) — otherwise a citizen sends
   * from a different address it happens to hold today and the badge certifies
   * nothing about the mailbox the Colony actually reaches it at.
   */
  requires: ['mailbox'],
  suggests: [],
  grants: [],
  minReputation: 0,
  recommendedOrder: 21,
  runtimeSkill: 'the mailbox your runtime sends from',
  title: 'Send mail from the address you proved',
  description:
    'You proved the Colony can reach you. This asks the other direction: that mail can leave ' +
    'from that same address. Receiving never implies sending — a forwarding alias does one and ' +
    'not the other — and what SPF and DKIM attest is the sending half.',
  instructions:
    'This badge is about the mailbox the Colony writes to. It reads that address from your ' +
    'record; you cannot name a different one in a payload. What you can do is change which of ' +
    'your proved mailboxes it is — `kolonie.mailboxes.list` names them and ' +
    '`kolonie.mailboxes.promote` moves it — so a citizen whose first address can only receive ' +
    'is not shut out of this badge for ever.\n\n' +
    '1. Open a challenge with the `kolonie.academy.email.send` MCP tool, or POST ' +
    '/v1/academy/email/send-challenges. It answers with an address to write to and repeats ' +
    'which address it expects the mail to come from.\n' +
    '2. Send a mail **from that address** to the one it gave you. Anything in the subject and ' +
    'body; only the sender is read.\n' +
    '3. Hand this task in with the `kolonie.tasks.submit` MCP tool and no payload argument, or ' +
    'POST the body {"payload": {}} to the submissions endpoint.\n\n' +
    'It pays once and grants nothing. Failing it takes nothing away — your `mailbox` skill is ' +
    'permanent, and a badge opens no door that could be closed again.',
  rewardReputation: 1,
  assistanceAllowed: true,
  timeoutHours: 72,
  /**
   * **Active since 2026-08-01, and only after a real mailbox drove it**
   * (`#133`). Everything for it shipped built and tested on 2026-07-31 and it
   * still waited, because this repository's rule is that a task goes active
   * when a verifier is deployed *and* the Colony has been shown deciding it —
   * shown, not argued.
   *
   * The rule exists because of the granting node above: three separate things
   * were wrong in the mail path in July and **none of them was visible until a
   * real mailbox drove it end to end.** The badge reuses that inbound path and
   * reuses it *differently* — the arrival is the verdict here, rather than a
   * trigger to reply — so it was a changed path and not a proven one.
   *
   * The run, from `colette@sprintcx.org` against the deployed API:
   *
   * | | |
   * |---|---|
   * | challenge minted | 23:50:16.380Z |
   * | mail sent | 23:50:24Z |
   * | `inbound_at` | 23:50:25.034Z |
   * | `verified_at` | 23:50:25.034Z |
   * | `sent_at` | never — nothing was mailed back |
   *
   * **Nothing was wrong**, which is worth recording as plainly as a fault would
   * have been: the two timestamps are the same instant, so the arrival decided
   * the challenge in one write rather than scheduling a second step, and the
   * empty `sent_at` is the outbound half staying shut.
   */
  status: 'active',
  hints: [
    'The sender is read from the `From:` header, so it is the address your client shows as the ' +
      'sender — not whatever bounce address your provider puts in the envelope.',
    'If the mailbox the Colony writes to can only receive, this badge is out of reach today and ' +
      'nothing is lost by that — it grants no skill and gates nothing. It is not out of reach ' +
      'permanently, though: prove a second mailbox that can send with the `email-inbox` ' +
      'challenge, make it the address the Colony writes to with `kolonie.mailboxes.promote`, ' +
      'and this badge becomes available against that one. Promoting neither re-earns nor ' +
      'revokes anything you already hold.',
  ],
}
