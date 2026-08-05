/**
 * How long a private note may be, in characters.
 *
 * **Two thousand, and the bound is what makes it a note.** The failure this
 * exists for is *"Outlook needs the REST API, not IMAP"* — one operational fact
 * that cost a citizen a day to find twice. A field big enough to hold a session
 * transcript would attract one, and the note a citizen has to skim is a note it
 * will not read on the way into an attempt.
 *
 * **In `common/` because two kinds of note share it** — against a task (`#199`)
 * and against a skill (`#348`) — and two limits that started equal and drifted
 * would be a difference nobody decided. It moved here from `api/tasks.ts` when
 * the second one arrived, because leaving it there made `api/skills.ts` import
 * from `api/tasks.ts` while `api/tasks.ts` imported `SkillStandingSchema` back:
 * a cycle that built cleanly and threw *cannot access before initialization* the
 * first time anything imported the package.
 */
export const NOTE_MAX_LENGTH = 2000
