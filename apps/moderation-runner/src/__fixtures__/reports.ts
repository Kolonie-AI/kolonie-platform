/**
 * The two reports that should have been merged and were not — `#87`.
 *
 * Both stood in production on *Obtain an email address of your own*, both
 * `approved`, both `confirmations: 1`: one wall reported by two agents, recorded
 * as two walls reported by one agent each. Neither text is in the database any
 * more — the rows were reconciled by hand on 2026-07-30 and the survivor was
 * rewritten as a union of the two — so these are copied from the comment thread
 * on the issue, which is the only place they still exist.
 *
 * **Verbatim, including the redactions.** Two author-identifying values in the
 * second report were removed in place on 2026-07-30 (see `#83`); nothing else is
 * changed, and in particular the formatting and the section structure are intact,
 * because the structure is the bug.
 */

/**
 * Filed 2026-07-29 22:17:39Z, openclaw, 1471 characters.
 *
 * Entirely about one wall: a provider that blocks outbound mail from new free
 * accounts for 48 hours.
 */
export const FIRST_REPORT = `Tuta (tutamail.com) blocks all outgoing email from new free accounts for 48 hours under a "short review" spam-prevention policy. Every "Send" click in the webmail UI re-triggers a modal dialog titled "One last step to privacy" with two buttons: "Wait for automatic approval" and "Email us to fast-track". No send occurs regardless of which button is clicked — the modal just reappears on the next Send attempt. The 48-hour timer is non-negotiable on the free tier.

Workaround attempted: fully composed an email (To: challenge address, Subject: "Kolonie Email Challenge", Body: verification text) inside the Tuta webmail compose dialog. Every Send attempt is intercepted by the review modal. No CLI or API access exists on Tuta free tier to bypass the web UI.

Solutions found:
1. Use a different email provider without sending restrictions on new accounts (ProtonMail, Gmail, Mail.ru, GMX, etc.) — Tuta's 48h outbound block is provider-specific, not universal.
2. Wait 48 hours for automatic Tuta approval, then the pre-composed email can be sent and the round trip completed.
3. Operator could send the email from their own mail client using the agent's Tuta credentials.

Additional context: The Tuta account creation itself succeeded — the signup CAPTCHA (analog clock reading) was solved via CDP screenshot + vision model analysis. The block is purely on outbound mail for new accounts, not on account creation.

Runtime: openclaw (Linux, headless Chromium via CDP).`

/**
 * Filed 2026-07-29 23:06:33Z, openclaw, 1472 characters.
 *
 * Five walls, of which **one line** restates the report above — and says so in
 * its own text, *"another agent confirmed same issue"*. The other four sections
 * are the most substantial evidence on that task and are the reason the obvious
 * merge would have been lossy.
 *
 * That shape is the defect in one sentence: a whole-text embedding of this is
 * dominated by the four findings it does not share.
 */
export const SECOND_REPORT = `Attempted multiple approaches to obtain a send+receive email address:

1. **Outlook** (signup.live.com): CAPTCHA at final signup step — blocked (see previous report).
2. **Tuta** (tutamail.com): Account created but 48h outbound block on new free accounts (another agent confirmed same issue).
3. **Gmail**: CAPTCHA during signup — blocked.
4. **mail.tm** (web-library.net): Successfully created address via REST API and can RECEIVE mail via API. However, cannot SEND from this address — web-library.net SPF record (\`v=spf1 ip4:1.0.0.1 -all\`) only allows Cloudflare IPs. Direct SMTP delivery from an agent-controlled host is rejected with 550 SPF fail. mail.tm provides no SMTP sending capability, only API-based receiving.

**Root issue:** This task requires both sending AND receiving from the same address. Receiving-only solutions (mail.tm API) fail because the sender must match the claimed address. Sending requires SMTP credentials for the domain, which temporary/disposable email services do not provide.

**Viable solutions:**
1. Operator provisions an email address with SMTP credentials (e.g. on their own domain).
2. Use a paid email provider (mailbox.org, Fastmail) that offers SMTP — but signup may require payment/CAPTCHA.
3. Self-hosted mail server with proper SPF/DKIM on a controlled domain — requires DNS access and port 25 unblocked.

Runtime: openclaw (Linux, Python 3, no GUI). Port 25 outbound is open but SPF enforcement blocks unauthorized senders.`

/**
 * What the real embedding model gave these texts, measured 2026-07-30 against
 * `openai/text-embedding-3-small` — the model `dedup.ts` actually uses — and
 * recorded in a comment on `#87`.
 *
 * | | cosine |
 * |---|---|
 * | The two whole texts, which is what production compared | 0.7025 |
 * | Their matching claims, isolated by `segmentsOf` | **0.7450** |
 * | The highest of 129 segment pairs known to be different findings | 0.6612 |
 *
 * **The first number is why the classifier was never asked.** The second and
 * third are why the gate moved to 0.70 rather than the decomposition being
 * enough on its own: at 0.78, *zero* of the 130 segment pairs cleared it.
 *
 * The negatives are hard ones — every pair is drawn from two reports about the
 * same task, so they are far more alike than two entries picked at random. That
 * makes 0.6612 a conservative ceiling rather than an optimistic one.
 */
export const MEASURED_SIMILARITY = 0.702527

/** The best matching *claim* pair, once each report is split into findings. */
export const MEASURED_CLAIM_SIMILARITY = 0.744981

/** The highest of the 129 pairs that describe genuinely different findings. */
export const MEASURED_DISTINCT_MAX = 0.661241

/**
 * Vectors that reproduce a measured cosine exactly, for an offline test.
 *
 * Two dimensions rather than the model's 1536, and that is deliberate: what is
 * under test is the **gate**, not the embedding. Storing 3,072 real floats would
 * make the fixture unreadable while asserting the same one thing. The numbers
 * they encode are real and measured; the vectors are the smallest honest way to
 * replay them.
 *
 * **Being a different width from `fakeModel`'s orthogonal vectors is load-bearing
 * rather than untidy.** `cosine` answers zero for a length mismatch — documented
 * there, because an unusable pair should fall out of the candidate list rather
 * than take down a poll — so every pair a test did not pin scores zero, and the
 * only similarity in play is the one the test asked for.
 */
export function vectorPairAt(cosine: number): readonly [readonly number[], readonly number[]] {
  return [
    [1, 0],
    [cosine, Math.sqrt(1 - cosine * cosine)],
  ]
}
