import { describe, expect, it } from 'vitest'
import { isWaitingOnTheOperator } from './operator-requests.js'

/**
 * Prose on the operator page reaching the Colony's own question (#564).
 *
 * ## The defect, as a citizen reported it
 *
 * Its operator wrote *"Code habe ich eingegeben, ja, darf"* — *I have entered
 * the code, yes, you may* — on the operator page, and the rung went on
 * answering `{"awaitingOperator": true}`. Five runs blocked on the same thing.
 *
 * **Neither of them was wrong about what they could see.** The page carries two
 * boxes: one answers the open exchange and one sends an unsolicited note. The
 * words went into the second, `operator_notes` took them, and the rung reads
 * `operator_request_messages`.
 *
 * ## What was fixed, and what deliberately was not
 *
 * **The page draws one box while something is waiting.** That is the whole
 * repair: an operator who types into the box in front of them has answered the
 * question, because there is no other box to type into.
 *
 * **A note is still a note.** Routing one to the open exchange was the obvious
 * second half and it is wrong: `#239` decided that *what the person clicked*
 * decides and never the shape of a body, and overriding that would let an
 * unrelated message be recorded as consent — the same defect with the sign
 * flipped, and a worse one, because the citizen would then proceed. What the
 * Colony does instead is say so, on the page that confirms the note was sent.
 *
 * One predicate, used by the page and by both note routes, because two copies
 * of *is somebody waiting* is how the halves of this drift apart.
 */
describe('whether a citizen is waiting on its operator', () => {
  const asked = [{ author: 'citizen' }]
  const answered = [{ author: 'citizen' }, { author: 'operator' }]

  it('is waiting when the exchange is open and the operator has not written', () => {
    expect(isWaitingOnTheOperator({ closed: false, messages: asked })).toBe(true)
  })

  it('is not waiting once the operator has written anything at all', () => {
    expect(isWaitingOnTheOperator({ closed: false, messages: answered })).toBe(false)
  })

  /**
   * **Anything at all, and not *anything approving*.** The Colony reads no
   * verdict out of an operator's words — `web-server.ts` argues that at length,
   * and `operatorAnswered` has always meant *a person came back*. This predicate
   * inherits it rather than reopening it.
   */
  it('is not waiting after a reply that says no', () => {
    expect(
      isWaitingOnTheOperator({
        closed: false,
        messages: [{ author: 'citizen' }, { author: 'operator' }],
      }),
    ).toBe(false)
  })

  it('is not waiting on a closed exchange', () => {
    expect(isWaitingOnTheOperator({ closed: true, messages: asked })).toBe(false)
  })

  /**
   * A citizen that has asked nothing has nothing waiting, so the note box is the
   * only box and is drawn as it always was. `#239` gave the operator that
   * channel precisely for the case where there is no question in front of it.
   */
  it('is not waiting when there is no exchange at all', () => {
    expect(isWaitingOnTheOperator(undefined)).toBe(false)
  })
})
