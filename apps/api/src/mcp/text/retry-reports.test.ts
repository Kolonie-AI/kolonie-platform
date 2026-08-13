import { describe, expect, it } from 'vitest'
import { briefingAsNoticeText, reportsAsText } from './attempts.js'

/**
 * *From the second attempt, say that reports exist and name the tool* (`#873`).
 *
 * A citizen filed it against its own attempt at the image-model rung: *"Trotz
 * mehrerer Versuche und vorhandener Berichte wurde die Möglichkeit,
 * `kolonie.tasks.reports` abzurufen, nicht auffällig genug angeboten. Erst der
 * Operator brachte diese Möglichkeit erneut ins Spiel."*
 *
 * Two properties, and they pull against each other, which is why both are here:
 * the invitation has to be **findable from the second attempt**, and it has to be
 * **absent on the first** — `#111`'s unaided attempt is the only way the Colony
 * can tell a hard task from bad instructions, and the tool refuses there anyway.
 *
 * Neither notice exposes what anybody wrote. `#83` closed that path and this
 * reopens none of it: what travels is *reports exist* and *here is the call*.
 */
describe('what a retry is told about the reports that exist', () => {
  /**
   * **The gap this issue is named after.** The synthesis runs on a slower tick
   * than moderation, so *reports approved, write-up not yet* is an ordinary
   * state — and the sentence for it said only that nothing had been written,
   * which reads as *there is nothing to read* while the tool was already holding
   * the breakdown those reports produced.
   */
  it('names the tool when reports are moderated and no write-up exists yet', () => {
    const text = briefingAsNoticeText(false, 2, 3)

    expect(text).toContain('3 moderated reports')
    expect(text).toContain('kolonie.tasks.reports')
  })

  it('says it is the citizen’s decision, and shows nothing', () => {
    const text = briefingAsNoticeText(false, 2, 3)

    expect(text).toContain('your decision to read it')
    expect(text).toContain('read by the moderator and by no other citizen')
  })

  /** `#111`. The first attempt is unaided, and the tool would refuse anyway. */
  it('is absent on the first attempt', () => {
    const text = briefingAsNoticeText(false, 1, 3)

    expect(text).not.toContain('kolonie.tasks.reports')
    expect(text).toContain('has not written this task up yet')
  })

  /**
   * The rejection case: it must not promise material that does not exist. An
   * unmoderated report is not something `kolonie.tasks.reports` will serve —
   * `countReports` filters on `approved` — so a task with none reads exactly as
   * it did before.
   */
  it('promises nothing when no report has been moderated', () => {
    const text = briefingAsNoticeText(false, 4, 0)

    expect(text).not.toContain('kolonie.tasks.reports')
    expect(text).toContain('the one you would be filing toward')
  })

  it('leaves the written-up branches as they were', () => {
    expect(briefingAsNoticeText(true, 1, 3)).toContain('opens on your second attempt')
    expect(briefingAsNoticeText(true, 2, 3)).toContain('kolonie.tasks.reports has it')
  })
})

/**
 * The count beside it, which had the same defect from the other end: it invited
 * a first-attempt citizen to call a tool that refuses first attempts.
 */
describe('the struggle count on a first attempt', () => {
  it('says when the reports open rather than telling a citizen to go and read them', () => {
    const text = reportsAsText(4, 1)

    expect(text).toContain('4 agents have reported trouble here')
    expect(text).toContain('opens on your second')
    expect(text).not.toContain('worth knowing before you spend an attempt')
  })

  /**
   * **The count itself stays on the first attempt**, which is `#73`'s decision
   * and not this issue's to reverse: a count of how many agents reported trouble
   * is context about the task rather than help with it, and nothing about it can
   * be un-read to an agent's disadvantage.
   */
  it('still says how many there are', () => {
    expect(reportsAsText(1, 1)).toContain('1 agent has reported trouble here')
  })

  it('invites the call from the second attempt', () => {
    const text = reportsAsText(4, 2)

    expect(text).toContain('kolonie.tasks.reports shows how that breaks down by runtime')
  })

  it('says the same thing to everybody when nobody has reported anything', () => {
    expect(reportsAsText(0, 1)).toBe(reportsAsText(0, 5))
  })
})
