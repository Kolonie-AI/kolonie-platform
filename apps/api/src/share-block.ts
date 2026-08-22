import { escape } from './console/escape.js'
import { asDay } from './console/time.js'

/**
 * The one shared-credential block, written once (`#1635`).
 *
 * ## What was measured
 *
 * The same shared vault entry, read by the maintainer on both doors on
 * 2026-08-22:
 *
 * | where | heading |
 * |---|---|
 * | the inbox thread | *"colette **shared** a credential with you"* |
 * | the operator page | *"colette **has shared** a credential with you"* |
 *
 * One word apart, two code paths, one object — and a third phrasing on the
 * operator page's own summary line. Everything else about the block was
 * duplicated too: the purpose line, the entry name, the expiry sentence, the
 * ended-state wording and the whole write-back form.
 *
 * **They will drift, and the drift is invisible.** Each door looks right on its
 * own and nobody reads them side by side; this was found by pasting both into
 * one message.
 *
 * ## What is genuinely different, and stays different
 *
 * **One door shows the value and the other does not.** The operator page prints
 * it, because that page *is* the deliberate act of reading it; the inbox thread
 * links to it, because `#1574` and `#931` refuse to put a credential through a
 * listing nobody asked for one in. That is a real difference between two views
 * of one object and it is not duplication.
 *
 * So what is lifted here is everything the two agree about, and each door still
 * decides the one thing it differs on. A single renderer taking a
 * `showsValue: boolean` would have hidden that decision inside a flag.
 *
 * ## Every function returns lines rather than a string
 *
 * Both call sites assemble arrays and both already did; joining here and
 * splitting there would be a round trip for nothing.
 */

/** What both doors call it. `#1635`: one wording, and this is it. */
export function shareHeading(agentName: string): string {
  return `<h2>${escape(agentName)} shared a credential with you</h2>`
}

/**
 * Who is asking, for what, and until when.
 *
 * **The expiry is a day, formatted** (`#1634`). It used to be printed straight
 * through, which put two different machine formats of one field in front of a
 * person on the two doors — `2026-08-24 18:31:12.355+00` in the inbox thread and
 * `2026-08-24T18:31:12.355Z` on the operator page. Milliseconds, a timezone
 * offset written two ways, and no clock a reader recognises, on the field that
 * decides when their access ends.
 *
 * **A day rather than a moment**, which is `#399`'s argument for every other date
 * on these pages and applies here for the same reason: nobody plans around
 * `18:31:12`. `absolute()` is better and needs a zone, which comes from a
 * signed-in request — and the operator page is a mailed link opened by somebody
 * with no session, so it has none. A silently-assumed zone would be confidently
 * wrong by up to a day where this is honestly coarse.
 */
export function shareIntro(
  share: {
    readonly purpose: string
    readonly vaultKey: string
    readonly description?: string | null
    readonly expiresAt: string
  },
  agentName: string,
): readonly string[] {
  return [
    `<p class="operator-ask"><strong>${escape(agentName)} says:</strong> ` +
      `${escape(share.purpose)}</p>`,
    `<p>Entry <code>${escape(share.vaultKey)}</code>` +
      (share.description === null || share.description === undefined
        ? ''
        : ` — ${escape(share.description)}`) +
      `. The share ends on ${escape(asDay(share.expiresAt))}.</p>`,
  ]
}

/**
 * What a share that is over says.
 *
 * Two endings and they are not the same news: an agent taking a credential back
 * has collected whatever the operator wrote into it, and a share reaching its
 * own date has not been decided by anybody. A reader who wrote a billing PIN
 * into one wants to know which of those happened.
 */
export function shareEnded(agentName: string, ended: 'taken-back' | string): readonly string[] {
  return ended === 'taken-back'
    ? [
        `<p class="note">${escape(agentName)} has taken this back. It was here and it is ` +
          'gone — nothing is wrong, and it collected anything you wrote into it.</p>',
      ]
    : [
        '<p class="note">This share has ended on its own date. It was here and it is gone; ' +
          'your agent can share it again if it still needs you.</p>',
      ]
}

/**
 * The form an operator writes back through, or the note saying where it is.
 *
 * **`wrote` is normalised by the caller** rather than read off the share,
 * because the two doors carry the same fact under two names — `wrote` on the
 * operator page and `operatorWrote` in the console. Renaming either would be a
 * change to a stored shape for a cosmetic reason; taking a boolean costs
 * nothing and is what let this be lifted at all.
 */
export function shareWriteBack(input: {
  readonly shareId: string
  readonly wrote: boolean
  readonly action?: string | undefined
  readonly error?: string | undefined
}): readonly string[] {
  if (input.action === undefined) {
    return [
      '<p class="note">Sign in to the operator console to write something back into this ' +
        'entry or to hand it back early.</p>',
    ]
  }

  return [
    ...(input.error === undefined ? [] : [`<p class="error">${escape(input.error)}</p>`]),
    `<form method="post" action="${escape(input.action)}">`,
    `<input type="hidden" name="shareId" value="${escape(input.shareId)}">`,
    '<label>Write something back into this entry — a billing PIN, a recovery code, a note. ' +
      'Your agent collects it when it takes the entry back.',
    '<input type="password" name="addition" maxlength="4096" autocomplete="off">',
    '</label>',
    `<button type="submit" name="act" value="write">${
      input.wrote ? 'Replace what you wrote' : 'Save it for them'
    }</button>`,
    '<button type="submit" name="act" value="hand-back">Hand it back now</button>',
    '</form>',
    ...(input.wrote
      ? ['<p class="note">You have already written something into this one.</p>']
      : []),
  ]
}
