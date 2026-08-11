import { describe, expect, it, vi } from 'vitest'
import type { ShareCloseReason } from '@kolonie-ai/core'
import { createShareRelay, type RelaySocket } from './browser-share.js'

/**
 * The relay's two promises, and both of them are tested here rather than argued
 * for: **a frame reaches the other socket unchanged**, and **a frame reaches
 * nothing else** — no log, no counter, no copy the Colony keeps.
 *
 * Nothing in this file opens a socket. `RelaySocket` is two methods on purpose,
 * so the pairing can be driven end to end with objects that record what they were
 * told, which is also the only way to assert the negative: a recording socket can
 * be searched, and a real one cannot.
 */

const SHARE = 'share-1'

/** A frame the size and shape of a real screencast one, so a leak would be visible. */
const FRAME = JSON.stringify({
  type: 'frame',
  sessionId: 7,
  data: 'iVBORw0KGgoAAAANSUhEUg'.repeat(40),
})

interface Recorder extends RelaySocket {
  readonly sent: string[]
  readonly closed: () => number
}

function socket(): Recorder {
  const sent: string[] = []
  let closes = 0
  return {
    sent,
    send: (message: string) => void sent.push(message),
    close: () => void (closes += 1),
    closed: () => closes,
  }
}

/** What a socket was told, ignoring the presence and goodbye housekeeping. */
function traffic(recorder: Recorder): string[] {
  return recorder.sent.filter(
    (message) => !message.includes('"peer"') && !message.includes('"closed"'),
  )
}

describe('the browser share relay', () => {
  it('forwards a frame to the other side as the exact string it arrived as', () => {
    const relay = createShareRelay()
    const agent = socket()
    const operator = socket()

    const agentSide = relay.attach(SHARE, 'agent', agent)
    relay.attach(SHARE, 'operator', operator)

    agentSide.receive(FRAME)

    expect(traffic(operator)).toEqual([FRAME])
    expect(traffic(agent)).toEqual([])
  })

  it('carries what the operator sends back the other way', () => {
    const relay = createShareRelay()
    const agent = socket()
    const operator = socket()

    relay.attach(SHARE, 'agent', agent)
    const operatorSide = relay.attach(SHARE, 'operator', operator)

    const click = JSON.stringify({
      type: 'input',
      method: 'Input.dispatchMouseEvent',
      x: 12,
      y: 40,
    })
    operatorSide.receive(click)

    expect(traffic(agent)).toEqual([click])
  })

  /**
   * The property the whole channel rests on, asserted the only way it can be:
   * drive a session through the relay with a logger that records everything, then
   * search what was written for the frame. The relay takes an `onClosed` handler
   * and nothing else, so this also covers the one callback the Colony does get.
   */
  it('writes no frame anywhere the Colony keeps', () => {
    const written: unknown[] = []
    const relay = createShareRelay((shareId, reason) => void written.push({ shareId, reason }))
    const agent = socket()
    const operator = socket()

    const agentSide = relay.attach(SHARE, 'agent', agent)
    const operatorSide = relay.attach(SHARE, 'operator', operator)

    agentSide.receive(FRAME)
    operatorSide.receive(JSON.stringify({ type: 'input', text: 'a password nobody should keep' }))
    operatorSide.leave()

    const everything = JSON.stringify(written)
    expect(everything).not.toContain('iVBORw0KGgo')
    expect(everything).not.toContain('a password nobody should keep')
    expect(written).toEqual([{ shareId: SHARE, reason: 'completed' }])
  })

  it('tells a joining socket whether the other end is there yet, and tells the other end it arrived', () => {
    const relay = createShareRelay()
    const agent = socket()
    const operator = socket()

    relay.attach(SHARE, 'agent', agent)
    expect(agent.sent).toEqual([JSON.stringify({ type: 'peer', present: false })])

    relay.attach(SHARE, 'operator', operator)
    expect(operator.sent).toEqual([JSON.stringify({ type: 'peer', present: true })])
    expect(agent.sent.at(-1)).toBe(JSON.stringify({ type: 'peer', present: true }))
  })

  /**
   * The agent's process going away is `lost` and the operator closing the window
   * is `completed`, and the asymmetry is the point: the agent reads the reason
   * back, and *my sharer died* and *the person finished* are different facts
   * about what to do next.
   */
  it('calls a dropped agent lost and a dropped operator completed', () => {
    const reasons: ShareCloseReason[] = []
    const relay = createShareRelay((_shareId, reason) => void reasons.push(reason))

    const first = relay.attach('a', 'agent', socket())
    relay.attach('a', 'operator', socket())
    first.leave()

    relay.attach('b', 'agent', socket())
    const operator = relay.attach('b', 'operator', socket())
    operator.leave()

    expect(reasons).toEqual(['lost', 'completed'])
  })

  it('closes both sockets and says why, once', () => {
    const closed = vi.fn()
    const relay = createShareRelay(closed)
    const agent = socket()
    const operator = socket()

    const agentSide = relay.attach(SHARE, 'agent', agent)
    const operatorSide = relay.attach(SHARE, 'operator', operator)

    agentSide.leave()

    const goodbye = JSON.stringify({ type: 'closed', reason: 'lost' })
    expect(agent.sent.at(-1)).toBe(goodbye)
    expect(operator.sent.at(-1)).toBe(goodbye)
    expect(agent.closed()).toBe(1)
    expect(operator.closed()).toBe(1)

    // The other end's socket event arrives a moment later, as it always does.
    operatorSide.leave()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  /** First reason wins, whichever of the racing ends got here first. */
  it('keeps the first reason when both ends end the share at once', () => {
    const reasons: ShareCloseReason[] = []
    const relay = createShareRelay((_shareId, reason) => void reasons.push(reason))

    const agentSide = relay.attach(SHARE, 'agent', socket())
    const operatorSide = relay.attach(SHARE, 'operator', socket())

    agentSide.receive(JSON.stringify({ type: 'closed', reason: 'cancelled' }))
    operatorSide.receive(JSON.stringify({ type: 'closed', reason: 'completed' }))

    expect(reasons).toEqual(['cancelled'])
  })

  it('ends the share on a close message rather than forwarding it as traffic', () => {
    const relay = createShareRelay()
    const agent = socket()
    const operator = socket()

    const agentSide = relay.attach(SHARE, 'agent', agent)
    relay.attach(SHARE, 'operator', operator)

    agentSide.receive(JSON.stringify({ type: 'closed', reason: 'cancelled' }))

    expect(traffic(operator)).toEqual([])
    expect(relay.present(SHARE, 'operator')).toBe(false)
  })

  /**
   * A frame that happens to contain the word `closed` — a page with a *closed*
   * button on it, say — is a frame and not a close. The discriminator is read,
   * not the bytes searched.
   */
  it('does not mistake a frame mentioning a close for one', () => {
    const relay = createShareRelay()
    const operator = socket()

    const agentSide = relay.attach(SHARE, 'agent', socket())
    relay.attach(SHARE, 'operator', operator)

    const looksLikeOne = JSON.stringify({ type: 'frame', data: 'the shop is "closed" today' })
    agentSide.receive(looksLikeOne)

    expect(traffic(operator)).toEqual([looksLikeOne])
    expect(relay.present(SHARE, 'agent')).toBe(true)
  })

  it('lets a reconnecting sharer take over, and stops talking to the socket it replaced', () => {
    const relay = createShareRelay()
    const operator = socket()
    const first = socket()
    const second = socket()

    const firstSide = relay.attach(SHARE, 'agent', first)
    relay.attach(SHARE, 'operator', operator)
    relay.attach(SHARE, 'agent', second)

    expect(first.closed()).toBe(1)

    // The replaced socket's own close event must not end the share the new one is on.
    firstSide.leave()
    expect(relay.present(SHARE, 'operator')).toBe(true)

    firstSide.receive(FRAME)
    expect(traffic(operator)).toEqual([])
  })

  it('ends a share from outside when its window runs out', () => {
    const closed = vi.fn()
    const relay = createShareRelay(closed)
    const operator = socket()

    relay.attach(SHARE, 'agent', socket())
    relay.attach(SHARE, 'operator', operator)

    relay.close(SHARE, 'expired')

    expect(closed).toHaveBeenCalledWith(SHARE, 'expired')
    expect(operator.sent.at(-1)).toBe(JSON.stringify({ type: 'closed', reason: 'expired' }))
    expect(relay.size()).toBe(0)
  })

  it('keeps two shares apart', () => {
    const relay = createShareRelay()
    const mine = socket()
    const theirs = socket()

    const agentSide = relay.attach('mine', 'agent', socket())
    relay.attach('mine', 'operator', mine)
    relay.attach('theirs', 'operator', theirs)

    agentSide.receive(FRAME)

    expect(traffic(mine)).toEqual([FRAME])
    expect(traffic(theirs)).toEqual([])
    expect(relay.size()).toBe(2)
  })

  it('is quiet about a share nobody is on', () => {
    const closed = vi.fn()
    const relay = createShareRelay(closed)

    relay.close('never-existed', 'cancelled')

    expect(closed).not.toHaveBeenCalled()
    expect(relay.present('never-existed', 'agent')).toBe(false)
  })
})
