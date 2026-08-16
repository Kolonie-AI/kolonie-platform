import { randomUUID } from 'node:crypto'
import {
  ListOperatorRequestsResponseSchema,
  OPERATOR_ANSWER_BODIES,
  OperatorRequestResponseSchema,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { aTicketRequest } from '../../__fixtures__/support.js'
import { TICKET_LIMIT } from '../../support.js'
import { exchangeAnchor } from '../../autonomy-page.js'
import { OPERATOR_LABEL } from '../text/operator-requests.js'
import { createLog } from '@kolonie-ai/core'
import {
  telegramOrMailingOperatorNotifier,
  type OperatorNotifier,
} from '../../operator-notifier.js'
import { fakeTelegramDesk } from '../../__fixtures__/operator-telegram.js'

/**
 * The operator channel (#236), from the citizen's side.
 *
 * The invariants asserted here are the ones a reviewer cannot see by reading the
 * diff: that the ceiling really is shared with the support desk, that a credential
 * really is refused in both directions, and that an operator's words really do
 * arrive labelled as the operator's.
 */
describe('kolonie.operator.request', () => {
  const aBlockedCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `asker-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    const taskId = colony.operatorRequestStore.giveTask('github-account')
    const pageToken = colony.operatorRequestStore.givePage(agent.id)

    return { colony, agent, apiKey: credentials.apiKey, taskId, pageToken }
  }

  const openA = async (
    colony: FakeColony,
    apiKey: string,
    taskId: string,
    body = 'I cannot create a GitHub account on my own. Could you make one and put the token in my vault?',
  ) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.operator.request.open',
      arguments: { taskId, body },
    })
    return { client, close, result }
  }

  it('appears only once a credential is presented', async () => {
    const { colony } = await aBlockedCitizen()
    const { client, close } = await connectedClient(colony)

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    for (const name of [
      'kolonie.operator.request.open',
      'kolonie.operator.request.read',
      'kolonie.operator.request.reply',
      'kolonie.operator.request.close',
    ]) {
      expect(names).not.toContain(name)
    }
    await close()
  })

  it('opens a request, and the notification carries the page the operator already has', async () => {
    const { colony, apiKey, taskId, pageToken } = await aBlockedCitizen()
    const { close, result } = await openA(colony, apiKey, taskId)

    expect(result.isError).toBeFalsy()
    const { request } = OperatorRequestResponseSchema.parse(result.structuredContent)
    expect(request.taskId).toBe(taskId)
    expect(request.answered).toBe(false)
    expect(request.messages).toHaveLength(1)

    const mailer = colony.operatorRequests.mailer as unknown as {
      sent: () => readonly { to: string; text: string }[]
    }
    const [mail] = mailer.sent()

    expect(mailer.sent()).toHaveLength(1)
    expect(mail?.to).toBe('operator@example.org')
    /**
     * `#236`: *"a test asserts no per-request link is minted."* The link in the
     * mail is the token the operator already held — so a leak is one leak, and an
     * operator who has bookmarked the page finds it still works.
     */
    expect(mail?.text).toContain(pageToken)
    expect(mail?.text).toContain(`#${exchangeAnchor(request.id)}`)
    // And nothing about the citizen's own addresses travels with it.
    expect(mail?.text).not.toContain('@example.org\n')
    await close()
  })

  it('refuses past the simultaneous-open ceiling, and names what is open', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    let firstId = ''
    for (let n = 0; n < 8; n += 1) {
      const opened = await openA(colony, apiKey, taskId, `Question number ${n} needs an answer.`)
      const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
      if (n === 0) firstId = request.id
      await opened.close()
    }

    const second = await openA(colony, apiKey, taskId)
    expect(second.result.isError).toBe(true)
    expect(JSON.stringify(second.result.content)).toContain(firstId)
    expect(JSON.stringify(second.result.content)).toContain('github-account')
    await second.close()
  })

  /**
   * The transport swap (`#794`), from the citizen's side — where the only thing
   * that must change is nothing.
   */
  describe('when the operator is on Telegram', () => {
    const overTelegram = async () => {
      const arranged = await aBlockedCitizen()
      const desk = fakeTelegramDesk()
      desk.store.bind(arranged.agent.id, 4242)

      // The notifier the wiring would have built, swapped in whole rather than
      // branched on: the point of the port is that this path does not know which
      // transport it got.
      ;(arranged.colony.operatorRequests as { notifier: OperatorNotifier }).notifier =
        telegramOrMailingOperatorNotifier({
          telegram: desk,
          mailer: arranged.colony.operatorRequests.mailer,
          log: { ...createLog({ service: 'test' }), warn: () => {}, info: () => {} },
        })

      return { ...arranged, desk }
    }

    it('reaches the operator there instead of by mail', async () => {
      const { colony, apiKey, taskId, desk } = await overTelegram()

      const { close, result } = await openA(colony, apiKey, taskId)
      await close()

      expect(result.isError).toBeFalsy()
      expect(desk.bot.sent).toHaveLength(1)
      expect(colony.operatorRequests.mailer.sent()).toHaveLength(0)
    })

    /**
     * **`#794`: the charge is taken once per ask regardless of transport.** A
     * channel that skipped the limiter would be the hole in it — and the citizen
     * would have found it, because a cheaper way to reach a person is a thing
     * agents notice.
     */
    it('spends the same allowance a mailed ask does', async () => {
      const { colony, apiKey, taskId } = await overTelegram()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      for (let n = 0; n < TICKET_LIMIT; n += 1) {
        const opened = await client.callTool({
          name: 'kolonie.support.open',
          arguments: aTicketRequest({ subject: `something is wrong, number ${n}` }),
        })
        expect(opened.isError).toBeFalsy()
      }

      const request = await client.callTool({
        name: 'kolonie.operator.request.open',
        arguments: { taskId, body: 'Could you make me a GitHub account, please?' },
      })
      await close()

      expect(request.isError).toBe(true)
    })
  })

  /**
   * `#236`: *"a test asserts a citizen at the support ceiling cannot open a
   * request."* This is the whole reason `support()` is built once in `server.ts`.
   */
  it('cannot open one when the support ceiling is already spent', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    for (let n = 0; n < TICKET_LIMIT; n += 1) {
      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: `something is wrong, number ${n}` }),
      })
      expect(opened.isError).toBeFalsy()
    }

    const request = await client.callTool({
      name: 'kolonie.operator.request.open',
      arguments: { taskId, body: 'I still need a human for this one.' },
    })

    expect(request.isError).toBe(true)
    expect(JSON.stringify(request.content)).toContain('rate_limited')
    await close()
  })

  /**
   * The refusal `#236` asks to be *enforced rather than requested*. The message has
   * to name the vault, or the citizen is left with the same problem and no route.
   */
  it('refuses a message carrying a credential, and points at the vault', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const { close, result } = await openA(
      colony,
      apiKey,
      taskId,
      'Please make the account with password: hunter2secret and tell me when it is done.',
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('kolonie.vault.set')

    // And nothing was opened, so the refusal cost the citizen nothing.
    const mailer = colony.operatorRequests.mailer as unknown as { sent: () => readonly unknown[] }
    expect(mailer.sent()).toHaveLength(0)
    await close()
  })

  it('reads the operator’s answer back labelled as the operator’s', async () => {
    const { colony, apiKey, taskId, pageToken } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    await colony.operatorRequestStore.answer({
      token: pageToken,
      requestId: request.id,
      body: 'Done — the handle is @asker-ai.',
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const read = await client.callTool({
      name: 'kolonie.operator.request.read',
      arguments: { requestId: request.id },
    })

    const text = JSON.stringify(read.content)
    /**
     * The attribution, and the sentence that says what it is worth. A citizen that
     * could not tell its operator's words from the Colony's would have no standing
     * to refuse an instruction that crossed a red line.
     */
    expect(text).toContain(OPERATOR_LABEL)
    expect(text).toContain('advice from a named person')
    expect(text).toContain('red lines still win')

    const parsed = OperatorRequestResponseSchema.parse(read.structuredContent)
    expect(parsed.request.answered).toBe(true)
    expect(parsed.request.messages[1]?.author).toBe('operator')
    await close()
  })

  /**
   * **Permission is not completion** (`#1093`). The reported defect was a citizen
   * that asked for a machine account, was told *Allow*, and could not tell whether
   * the account existed — while the exchange counted as answered, so it stopped
   * waiting. What the operator pressed is on the message now, and the citizen reads
   * it back in words rather than inferring it.
   */
  it('says which answer it is when the operator pressed a control, and nothing when it typed', async () => {
    const { colony, apiKey, taskId, pageToken } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    await colony.operatorRequestStore.answer({
      token: pageToken,
      requestId: request.id,
      body: OPERATOR_ANSWER_BODIES.permission,
      kind: 'permission',
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const read = await client.callTool({
      name: 'kolonie.operator.request.read',
      arguments: { requestId: request.id },
    })

    const text = JSON.stringify(read.content)
    expect(text).toContain('gave you permission')
    expect(text).toContain('still waiting')
    expect(text).not.toContain('has done what you asked')

    const parsed = OperatorRequestResponseSchema.parse(read.structuredContent)
    expect(parsed.request.declared).toBe('permission')
    expect(parsed.request.messages[1]?.kind).toBe('permission')
    await close()
  })

  it('replies on the same exchange, and sends no second mail', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const replied = await client.callTool({
      name: 'kolonie.operator.request.reply',
      arguments: { requestId: request.id, body: 'That handle was taken, so I used the other one.' },
    })

    expect(replied.isError).toBeFalsy()
    const parsed = OperatorRequestResponseSchema.parse(replied.structuredContent)
    expect(parsed.request.messages).toHaveLength(2)

    // One mail per request and nothing after it — `#236`, and the general rule that
    // the Colony never initiates.
    const mailer = colony.operatorRequests.mailer as unknown as { sent: () => readonly unknown[] }
    expect(mailer.sent()).toHaveLength(1)
    await close()
  })

  /**
   * **Answering an operator's question must not cost what asking one costs
   * (`#359`).**
   *
   * `kolonie.operator.notes` is one-way, so a question that arrives there has no
   * reply path of its own. A citizen measured the consequence on 2026-08-05: the
   * only route left was `request.open`, which spent its one open-request slot and
   * its single notification mail to deliver something that was not a request at
   * all. Three things are asserted here because the workaround was cheap in
   * exactly the three ways this must stay cheap.
   */
  it('replies into a closed exchange without reopening it, spending no slot and no mail', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({
      name: 'kolonie.operator.request.close',
      arguments: { requestId: request.id },
    })

    const replied = await client.callTool({
      name: 'kolonie.operator.request.reply',
      arguments: { requestId: request.id, body: 'Yes — I read your note, and here is the answer.' },
    })

    expect(replied.isError).toBeFalsy()
    const parsed = OperatorRequestResponseSchema.parse(replied.structuredContent)
    expect(parsed.request.messages).toHaveLength(2)
    // It does not reopen: the exchange stays finished.
    expect(parsed.request.closedAt).not.toBeNull()
    // And still no mail — one per request, nothing after it.
    const mailer = colony.operatorRequests.mailer as unknown as { sent: () => readonly unknown[] }
    expect(mailer.sent()).toHaveLength(1)
    await close()

    // The slot is free, which is the cost the workaround was paying: a citizen
    // that answered a question could not then report a real block.
    const next = await openA(colony, apiKey, taskId, 'Now about the X account instead.')
    expect(next.result.isError).toBeFalsy()
    await next.close()
  })

  it('closes it, which is how the next one becomes possible', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const closed = await client.callTool({
      name: 'kolonie.operator.request.close',
      arguments: { requestId: request.id },
    })
    expect(closed.isError).toBeFalsy()
    // Unanswered and closed — which is what `#236` calls a withdrawal.
    expect(OperatorRequestResponseSchema.parse(closed.structuredContent).request.answered).toBe(
      false,
    )
    await close()

    const next = await openA(colony, apiKey, taskId, 'Now about the X account instead.')
    expect(next.result.isError).toBeFalsy()
    await next.close()
  })

  it('cannot read or close another citizen’s exchange', async () => {
    const { colony, apiKey, taskId } = await aBlockedCitizen()
    const opened = await openA(colony, apiKey, taskId)
    const { request } = OperatorRequestResponseSchema.parse(opened.result.structuredContent)
    await opened.close()

    const stranger = await colony.registry.register(
      { name: `stranger-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (stranger.outcome !== 'registered') throw new Error('fixture failed to register')

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${stranger.response.credentials.apiKey}`,
    )

    for (const name of ['kolonie.operator.request.read', 'kolonie.operator.request.close']) {
      const result = await client.callTool({ name, arguments: { requestId: request.id } })
      expect(result.isError, name).toBe(true)
    }

    // And their own list is empty rather than carrying somebody else's exchange.
    const list = await client.callTool({ name: 'kolonie.operator.request.read', arguments: {} })
    expect(ListOperatorRequestsResponseSchema.parse(list.structuredContent).requests).toHaveLength(
      0,
    )
    await close()
  })

  it('refuses to open one when the citizen has no page out', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `pageless-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const taskId = colony.operatorRequestStore.giveTask('github-account')
    const { close, result } = await openA(colony, registered.response.credentials.apiKey, taskId)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('kolonie.operator.page')
    await close()
  })

  it('says nothing has ever been asked, rather than answering with an empty list', async () => {
    const { colony, apiKey } = await aBlockedCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const read = await client.callTool({ name: 'kolonie.operator.request.read', arguments: {} })

    // The wording matters: an agent reading *it costs you nothing* is more likely
    // to use a channel it has not used before.
    expect(JSON.stringify(read.content)).toContain('costs you nothing')
    await close()
  })
})
