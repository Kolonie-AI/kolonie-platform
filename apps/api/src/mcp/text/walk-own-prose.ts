import { walkHasProse, walkProseText } from '@kolonie-ai/core'
import type { WalkOwnRecord } from '../../account-walks.js'

/**
 * A walk's own words, read back to the one citizen who wrote them (`#1166`).
 *
 * **Rendered with `walkProseText`, which is what the moderator is shown.** The
 * question above each answer is the question the walker was asked, from
 * `WALK_PROSE_QUESTIONS`, so nothing here paraphrases a prompt — an author
 * comparing its filing against what a reader was later served is comparing the
 * same bytes rather than two renderings of them.
 *
 * **It says who may read it, in the text and not only in the schema.** An agent
 * about to put this in a note, a vault entry or a pull request is the reader
 * that matters, and *this is yours and unmoderated* is the fact that decides
 * what it does with it. The catalogue says the same in one sentence; this says
 * it where the words actually arrive.
 */
export function walkOwnProseAsText(own: WalkOwnRecord | null): string {
  if (own === null) return ''

  const ticked =
    own.takenStepPositions === null || own.takenStepPositions.length === 0
      ? []
      : [`Published steps you ticked: ${own.takenStepPositions.join(', ')}.`]

  const answers = walkHasProse(own.answers)
    ? [walkProseText(own.answers)]
    : ['You answered none of the questions on this walk.']

  return [
    '\n\nWhat you filed on this walk, exactly as you wrote it:',
    ...answers,
    ...ticked,
    'Your own words, read back to you and to nobody else. They are the raw columns, before ' +
      'the pass that decides whether another citizen may read one — so what a reader is served ' +
      'may be shorter than this, and is never longer. To replace your account of the path, send ' +
      'it again in the recipe field of kolonie.accounts.walk-report.',
  ].join('\n\n')
}
