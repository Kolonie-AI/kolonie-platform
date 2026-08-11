import { describe, expect, it } from 'vitest'
import { createSharerSession, type CdpCall } from './sharer.js'
import { CDP_RELAY_METHODS } from './share.js'

interface Recorder {
  readonly calls: { method: string; params: Record<string, unknown> }[]
  readonly sent: string[]
  readonly refused: string[]
}

function session(targetId = 'TAB-1') {
  const recorder: Recorder = { calls: [], sent: [], refused: [] }
  const callCdp: CdpCall = (method, params) => {
    recorder.calls.push({ method, params })
  }
  const sharer = createSharerSession({
    targetId,
    callCdp,
    sendToColony: (message) => recorder.sent.push(message),
    onRefused: (method) => recorder.refused.push(method),
  })
  return { sharer, recorder }
}

function operatorSays(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'input', method, params })
}

describe('the allowlist, which is the security boundary', () => {
  /**
   * The one the issue names. It is written as its own test rather than as a case
   * in a table because it is the property the whole decision rests on: an
   * operator holding a shared tab must not be able to send the browser anywhere.
   */
  it('does nothing at all when the operator socket asks for Page.navigate', () => {
    const { sharer, recorder } = session()

    const outcome = sharer.onColonyMessage(operatorSays('Page.navigate', { url: 'about:blank' }))

    expect(outcome).toEqual({ outcome: 'refused', method: 'Page.navigate' })
    expect(recorder.calls).toEqual([])
    expect(recorder.refused).toEqual(['Page.navigate'])
  })

  it.each([
    ['Runtime.evaluate', { expression: '1' }],
    ['Network.getAllCookies', {}],
    ['Target.createTarget', { url: 'about:blank' }],
    ['Target.attachToTarget', { targetId: 'OTHER' }],
    ['Browser.close', {}],
    ['Page.captureScreenshot', {}],
    ['Page.reload', {}],
    ['Storage.getCookies', {}],
    ['Fetch.enable', {}],
    ['Input.dispatchDragEvent', {}],
  ])('refuses %s', (method, params) => {
    const { sharer, recorder } = session()

    expect(sharer.onColonyMessage(operatorSays(method, params))).toEqual({
      outcome: 'refused',
      method,
    })
    expect(recorder.calls).toEqual([])
  })

  it.each(CDP_RELAY_METHODS)('relays %s, which is the whole job', (method) => {
    const { sharer, recorder } = session()

    expect(sharer.onColonyMessage(operatorSays(method, { x: 4 }))).toEqual({
      outcome: 'relayed',
      method,
    })
    expect(recorder.calls).toEqual([{ method, params: { x: 4 } }])
  })

  /**
   * A refused method must not reach the runner's log with what came with it: a
   * refused `Input.insertText` carries whatever the operator typed.
   */
  it('tells the runner which method was refused and never its parameters', () => {
    const { sharer, recorder } = session()

    sharer.onColonyMessage(operatorSays('Runtime.evaluate', { expression: 'a-password' }))

    expect(recorder.refused).toEqual(['Runtime.evaluate'])
    expect(recorder.sent.join('')).not.toContain('a-password')
  })

  it.each([
    ['not JSON at all', 'clearly-not-json'],
    ['JSON that is not an object', '"input"'],
    ['a message with no type', '{"method":"Input.dispatchKeyEvent"}'],
    ['an input with no method', '{"type":"input","params":{}}'],
    ['a type this protocol does not have', '{"type":"navigate","url":"about:blank"}'],
  ])('drops %s without calling CDP', (_name, raw) => {
    const { sharer, recorder } = session()

    expect(sharer.onColonyMessage(raw)).toEqual({ outcome: 'unreadable' })
    expect(recorder.calls).toEqual([])
  })
})

describe('the target the share is bound to', () => {
  it('forwards a frame from the target the offer named', () => {
    const { sharer, recorder } = session()

    sharer.onScreencastFrame({ data: 'JPEG', sessionId: 7, targetId: 'TAB-1' })

    expect(recorder.sent).toEqual([JSON.stringify({ type: 'frame', data: 'JPEG', ack: 7 })])
  })

  /**
   * It should be impossible for the runner to feed this in, and that is the
   * reason to check rather than the reason not to: being wrong here means
   * streaming a different tab of the agent's browser to somebody.
   */
  it('drops a frame from any other target', () => {
    const { sharer, recorder } = session()

    sharer.onScreencastFrame({ data: 'SOMEONE-ELSES-TAB', sessionId: 7, targetId: 'TAB-2' })

    expect(recorder.sent).toEqual([])
  })
})

describe('backpressure', () => {
  it('acks only when the runner says the socket took the frame', () => {
    const { sharer, recorder } = session()

    sharer.onScreencastFrame({ data: 'JPEG', sessionId: 7, targetId: 'TAB-1' })
    expect(recorder.calls).toEqual([])

    sharer.acknowledge(7)
    expect(recorder.calls).toEqual([
      { method: 'Page.screencastFrameAck', params: { sessionId: 7 } },
    ])
  })
})

describe('stopping', () => {
  it('stops the screencast and tells the Colony why', () => {
    const { sharer, recorder } = session()

    sharer.stop('completed')

    expect(recorder.calls).toEqual([{ method: 'Page.stopScreencast', params: {} }])
    expect(recorder.sent).toEqual([JSON.stringify({ type: 'closed', reason: 'completed' })])
  })

  /** The token does not survive a close, and neither does the session it belonged to. */
  it('relays nothing and streams nothing after it has stopped', () => {
    const { sharer, recorder } = session()
    sharer.stop('expired')
    recorder.calls.length = 0
    recorder.sent.length = 0

    sharer.onColonyMessage(operatorSays('Input.dispatchMouseEvent', { x: 1 }))
    sharer.onScreencastFrame({ data: 'JPEG', sessionId: 8, targetId: 'TAB-1' })
    sharer.acknowledge(8)

    expect(recorder.calls).toEqual([])
    expect(recorder.sent).toEqual([])
  })

  it('stops the screencast when the far end closes first', () => {
    const { sharer, recorder } = session()

    const outcome = sharer.onColonyMessage(JSON.stringify({ type: 'closed', reason: 'completed' }))

    expect(outcome).toEqual({ outcome: 'closed', reason: 'completed' })
    expect(recorder.calls).toEqual([{ method: 'Page.stopScreencast', params: {} }])
  })

  it('stops once, so a close racing a close does not send two', () => {
    const { sharer, recorder } = session()

    sharer.stop('completed')
    sharer.stop('lost')

    expect(recorder.sent).toEqual([JSON.stringify({ type: 'closed', reason: 'completed' })])
  })
})
