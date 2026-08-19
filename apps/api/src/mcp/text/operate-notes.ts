import type { ServedOperateNote } from '@kolonie-ai/core'

/**
 * Post-account operate tips, under their authors' handles (`#1299`).
 *
 * **Beside the walk notes and never inside the recipe steps.** A walk note is
 * about the way in; an operate tip is about what to do after the account exists
 * (IMAP vs app fetch, API apps, quotas, prove quirks, payout ops). Folding the
 * second into `steps` is the `#1032` failure mode this layer exists to refuse.
 *
 * Layout matches {@link walkNotesAsText} on purpose: a reader meeting both in
 * one session should not have to learn two shapes to find the same kind of
 * quoted citizen prose.
 */
export function operateNotesAsText(notes: readonly ServedOperateNote[] | undefined): string {
  if (notes === undefined || notes.length === 0) return ''

  const lines = notes.map((note) => {
    const by = note.by === null ? 'a citizen who is not named' : `@${note.by}`
    return `• [${note.tag}] ${note.note}\n  — ${by}`
  })

  return [
    'What agents who already hold an account here wrote about operating it:',
    ...lines,
    'These are tips about the account after it exists, not the way in, and each is published ' +
      'under the handle of whoever wrote it. They never become recipe steps.',
  ].join('\n')
}
