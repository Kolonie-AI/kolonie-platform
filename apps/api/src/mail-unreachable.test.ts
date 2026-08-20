import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentId, ConversationId } from '@kolonie-ai/core'
import { cloudflareMailer, operatorMailerFrom } from './email.js'
import { mailingOperatorNotifier } from './operator-notifier.js'
import { recordingLog } from './__fixtures__/console.js'

/**
 * What happens when the mail desk is not there at all (`#1087`).
 *
 * ## The defect, as it was found
 *
 * A watcher over the API's own logs filed this: 168 lines of `mcp.tool.threw`
 * between 2026-08-06 and 2026-08-16, every one of them the same shape —
 * `TypeError: fetch failed`, caused by `EAI_AGAIN`, on
 * `kolonie.operator.request.open`. Cloudflare's API name did not resolve, the
 * `fetch` threw, and nothing between the socket and the tool boundary caught it.
 *
 * ## Why a returned failure is not a smaller version of a thrown one
 *
 * Because the answer was already written and the throw skipped it. Every one of
 * the six surfaces that send branches on `delivered`, and each has a sentence
 * ready: the mailbox rung says the challenge is still open and asking again
 * retries the same one; the console writes a `warn` naming the surface;
 * `openOperatorRequest` says the request is open, that this is not the citizen's
 * problem, and hands back the `requestId` to withdraw it with.
 *
 * That last one is the expensive one. The row is written and the allowance
 * charged *before* the send, deliberately — `#794`'s ordering, so a failed mail
 * leaves an ask the citizen can read rather than losing it. A thrown error
 * turned that into its opposite: the citizen was told nothing except that its
 * call failed, so the reasonable act was to send it again, into a ceiling it had
 * already paid into, for a request that already existed.
 *
 * ## Against the real mailer
 *
 * `fetch` is stubbed and `cloudflareMailer` is not. A fake mailer that answered
 * `{ delivered: false }` would be asserting its own politeness — the whole
 * question is what *this* function does when the socket fails under it.
 */
describe('a mail desk that cannot be reached', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Shaped as Node shapes it: a `TypeError` saying only that a fetch failed,
   * with the interesting part on `cause`. **The host is written into the message
   * and again into `hostname`**, which is the reason the reason may not be built
   * from either — see `mailFailureReason`.
   */
  const networkFailure = (code: string) =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error(`getaddrinfo ${code} desk.example.invalid`), {
        code,
        hostname: 'desk.example.invalid',
        syscall: 'getaddrinfo',
      }),
    })

  const mailerThatCannotConnect = (thrown: unknown, log = recordingLog()) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw thrown
      }),
    )
    return {
      log,
      mailer: cloudflareMailer({
        accountId: 'account',
        token: 'token',
        sender: 'academy@example.invalid',
        log,
      }),
    }
  }

  const aMessage = { to: 'someone@example.invalid', subject: 's', text: 't' }

  /** The assertion the issue is about. Everything below it is detail. */
  it('answers a failure rather than throwing one', async () => {
    const { mailer } = mailerThatCannotConnect(networkFailure('EAI_AGAIN'))

    await expect(mailer.send(aMessage)).resolves.toMatchObject({ delivered: false })
  })

  /**
   * Read off the code and never off the message, the argument `reachability.ts`
   * makes for the same class of fault. A caller that could not tell a name that
   * did not resolve from a connection that was refused would be told the same
   * unhelpful thing about a DNS outage and a firewall.
   */
  it('says which kind of unreachable it was', async () => {
    const reasons: Record<string, string | undefined> = {}
    for (const code of ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOMETHINGNEW']) {
      const { mailer } = mailerThatCannotConnect(networkFailure(code))
      reasons[code] = (await mailer.send(aMessage)).reason
      vi.unstubAllGlobals()
    }

    expect(reasons['EAI_AGAIN']).toBe('the mail desk did not resolve')
    expect(reasons['ENOTFOUND']).toBe('the mail desk did not resolve')
    expect(reasons['ECONNREFUSED']).toBe('the mail desk refused the connection')
    expect(reasons['ETIMEDOUT']).toBe('the mail desk timed out')
    // Unrecognised is never guessed at. It is still a send that did not go out,
    // which is the whole of what the caller needs.
    expect(reasons['ESOMETHINGNEW']).toBe('the mail desk could not be reached')
  })

  /**
   * **The rule that decides how the reason is built** (`AGENTS.md §9`). At
   * `mintEmailChallenge` the reason is interpolated into a sentence a *citizen*
   * reads, so a reason quoting the error would publish the Colony's outbound
   * dependency to every agent that asked for a code during an outage — and the
   * same string is in a log line, and in a shared transcript after that.
   */
  it('names no host, in what it answers or in what it writes down', async () => {
    const { mailer, log } = mailerThatCannotConnect(networkFailure('EAI_AGAIN'))

    const sent = await mailer.send(aMessage)

    const written = JSON.stringify(log.lines())
    for (const leak of ['desk.example.invalid', 'getaddrinfo', 'fetch failed']) {
      expect(sent.reason).not.toContain(leak)
      expect(written).not.toContain(leak)
    }
  })

  /**
   * **A failure the citizen is told about is not a failure anybody can act on.**
   * One agent reading *the Colony could not deliver this* knows about its own
   * call; *the desk has not resolved for two hours* is a sentence only the logs
   * can say. `httpTelegramBot` keeps this line for the same reason.
   */
  it('writes one line for whoever operates the Colony', async () => {
    const { mailer, log } = mailerThatCannotConnect(networkFailure('EAI_AGAIN'))

    await mailer.send(aMessage)

    const line = log.lines().find((one) => one.fields['event'] === 'mail.send.failed')
    expect(line?.level).toBe('warn')
    expect(line?.fields['reason']).toBe('the mail desk did not resolve')
  })

  /**
   * The body arrives over the same socket the request went out on, so a
   * connection dropped after the headers throws here rather than at `fetch`. A
   * send this process cannot read the answer to is one it cannot claim
   * succeeded, which is already the verdict for `success !== true`.
   */
  it('does not throw when the answer cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('socket hang up')
        },
      })),
    )
    const mailer = cloudflareMailer({
      accountId: 'account',
      token: 'token',
      sender: 'academy@example.invalid',
    })

    await expect(mailer.send(aMessage)).resolves.toMatchObject({ delivered: false })
  })

  /**
   * The path the issue was filed from, end to end: transport, the operator
   * mailer bound to a sender, and the notifier the operator request calls.
   * **`delivered: false` here is what makes the notify path's prepared answer
   * run at all** — the branch was written, tested and unreachable.
   */
  it('reaches the operator notifier as an undelivered message', async () => {
    const { mailer } = mailerThatCannotConnect(networkFailure('EAI_AGAIN'))
    const notifier = mailingOperatorNotifier(operatorMailerFrom(mailer, 'console@example.invalid'))

    const notified = await notifier.notify({
      agentId: randomUUID() as AgentId,
      subject: { kind: 'conversation', conversationId: randomUUID() as ConversationId },
      agentName: 'canary',
      context: 'browser-capability',
      link: 'https://console.example.invalid/operator/page/a-token#question-1',
      address: 'op@example.invalid',
    })

    expect(notified).toMatchObject({
      delivered: false,
      transport: 'email',
      reason: 'the mail desk did not resolve',
    })
  })
})
