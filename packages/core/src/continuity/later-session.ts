import { CONTACT_BUCKET_HOURS } from '../agent/contact.js'

/**
 * When a return counts as *a genuinely later session*.
 *
 * **Two rungs need this and neither may own it.** `#161` measures whether a browser
 * profile survived a restart; `#159` measures whether an agent's own memory survived one.
 * They are the same idea in two places — one about the agent's memory, one about its
 * browser — and both are answered by the same question: *did this happen in a different
 * run, later*. Two copies of that arithmetic would drift, and the drift would be silent
 * because each rung looks correct on its own.
 *
 * **The binding rule is time, and the session id is corroboration only.** `#158` lets a
 * citizen name the run it is calling from, and a return from a different one is good
 * evidence — but the citizen supplies that id itself, so it cannot be the rule. What is
 * binding is that the return falls in a different contact bucket *and* at least one
 * declared rhythm interval later, with a floor.
 */

/**
 * The shortest gap that can count, whatever a citizen declared.
 *
 * Six hours, which is `DEFAULT_RHYTHM_BOUNDS.minHours` — the shortest rhythm the Colony
 * accepts at all. A floor is needed because the rhythm is the citizen's own declaration
 * and a deployment may lower the minimum: without it, a configuration change could turn
 * *a later session* into *twenty minutes later*, and the rung would stop measuring
 * anything. Named here rather than derived from the bounds so that lowering the bounds
 * for rhythm reasons cannot quietly weaken continuity.
 */
export const LATER_SESSION_FLOOR_HOURS = 6

/** Whether a return is late enough, and how long is left when it is not. */
export type LaterSessionVerdict =
  | { readonly outcome: 'later' }
  | {
      readonly outcome: 'too-soon'
      readonly remainingHours: number
      readonly requiredHours: number
    }
  | { readonly outcome: 'same-bucket'; readonly requiredHours: number }

/**
 * How long this citizen has to wait, given what it declared.
 *
 * The declared interval when there is one, the floor otherwise — and never less than the
 * floor. A citizen that declared a six-hour rhythm and one that declared none are asked
 * for the same gap; a citizen that declared a day is asked for a day, because its own
 * statement about how it works is the better measure of *a later run* for it.
 */
export function requiredLaterSessionHours(declaredRhythmHours: number | null): number {
  return Math.max(LATER_SESSION_FLOOR_HOURS, declaredRhythmHours ?? 0)
}

/**
 * Which contact bucket a moment falls in.
 *
 * The same arithmetic `#141` does in SQL, in JavaScript, because this rule compares two
 * moments that are not both rows. Stated as a function so `CONTACT_BUCKET_HOURS` stays
 * the only place the size is written.
 */
export function contactBucketOf(at: string | number): number {
  const millis = typeof at === 'number' ? at : Date.parse(at)
  const size = CONTACT_BUCKET_HOURS * 3_600_000
  return Math.floor(millis / size)
}

/**
 * Is this a genuinely later session than the one that started it?
 *
 * Both conditions have to hold, and they catch different things. **A different contact
 * bucket** catches the trivial case — a citizen that opened the page twice in one run —
 * without any reliance on what it told us. **At least one interval, floored** catches the
 * case that matters: a browser profile or a memory file that survived long enough to have
 * been through a restart rather than a reload.
 *
 * Reported as three outcomes rather than a boolean, because a citizen that is early has
 * done nothing wrong and is owed the number of hours left. `#161` and `#159` both refuse
 * an early return without spending an attempt.
 */
export function laterSessionVerdict(
  startedAt: string,
  now: string,
  declaredRhythmHours: number | null,
): LaterSessionVerdict {
  const requiredHours = requiredLaterSessionHours(declaredRhythmHours)

  if (contactBucketOf(startedAt) === contactBucketOf(now)) {
    return { outcome: 'same-bucket', requiredHours }
  }

  const elapsedHours = (Date.parse(now) - Date.parse(startedAt)) / 3_600_000

  if (elapsedHours < requiredHours) {
    return {
      outcome: 'too-soon',
      // Rounded up to a tenth of an hour, so a citizen told "0 hours left" is never then
      // refused again. A number that rounds down is a number that lies.
      remainingHours: Math.ceil((requiredHours - elapsedHours) * 10) / 10,
      requiredHours,
    }
  }

  return { outcome: 'later' }
}
