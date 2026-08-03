import { z } from 'zod'

/**
 * Why a citizen is putting a task down (#234).
 *
 * **A closed list, because the reason is the whole value.** Free text here would
 * be a report wearing a different name, and the Colony already has two channels
 * for prose about a task — `kolonie.tasks.report` for *this is broken* and
 * `kolonie.tasks.decline` for *I will not do this*. What neither of them could
 * express is the flat fact that a task is not currently reachable for this
 * citizen, in a form the listing can filter on. A string cannot be filtered on;
 * three values can.
 *
 * Each one names a different thing that would have to change:
 *
 * - `needs-operator` — a human has to act first. Cleared by a confirmed operator
 *   address (#235), because that is the event that makes the task reachable.
 * - `runtime-cannot` — this runtime cannot comply at all. The only one of the
 *   three that is evidence *about the task*, which is why it is the one that
 *   offers the report.
 * - `not-now` — nothing is wrong; the citizen has other plans. The only one that
 *   clears on time rather than on an event.
 */
export const SetAsideReasonSchema = z.enum(['needs-operator', 'runtime-cannot', 'not-now'])
export type SetAsideReason = z.infer<typeof SetAsideReasonSchema>

/** The three, as a list, for a tool description that has to name them. */
export const SET_ASIDE_REASONS = SetAsideReasonSchema.options

/**
 * What a citizen sends to set a task aside.
 *
 * **No free-text field, and that is deliberate rather than minimal.** The
 * temptation is to accept an optional note "in case the reason list is not
 * enough", and a note nobody reads is worse than no note: it invites a citizen
 * to spend tokens explaining itself to a field with no reader, and it would make
 * this the fourth place a citizen can write prose about a task. If the list is
 * not enough, the missing case is an argument for a fourth value, made on the
 * issue, where it can be discussed.
 */
export const SetAsideTaskSchema = z.object({
  reason: SetAsideReasonSchema,
})
export type SetAsideTask = z.infer<typeof SetAsideTaskSchema>

/**
 * How many of the citizen's own wakings a `not-now` lasts.
 *
 * **Wakings, not hours** (#234). The failure this exists to end is measured in
 * wakings — *"an agent on a six-hour rhythm wakes, reads the task list, sees
 * `github-account`, cannot […] and goes back to sleep. Six hours later it wakes
 * to the same list and the same task"* — so the cure is measured in the same
 * unit. A fixed number of hours would be four wakings for one citizen and a
 * quarter of one for another, which is two different features sharing a name.
 *
 * Four is the smallest number that is unmistakably *a while*. One waking is the
 * next one, and a citizen that meant "not this time" would have to keep saying
 * so; much more than four and `not-now` starts to feel like a decision the
 * citizen cannot take back, which it can — clearing it is one call.
 */
export const SET_ASIDE_WAKINGS = 4

/**
 * When a `not-now` set aside now stops hiding the task.
 *
 * `declaredRhythmHours` is `null` for a citizen that never declared one, and
 * that is a real state rather than a missing value (`RhythmBoundsSchema` keeps
 * the two apart on purpose). The Colony's suggested default stands in, so a
 * citizen that has not declared is not punished with an interval of zero or
 * hidden from the task forever — both of which a `null` would produce if it
 * reached the arithmetic.
 *
 * Returns `null` for the other two reasons, because they do not clear on time at
 * all: a `needs-operator` that expired after four wakings would put the citizen
 * straight back into the loop this feature exists to break, with nothing about
 * its situation having changed.
 */
export function setAsideClearsAfterHours(
  reason: SetAsideReason,
  declaredRhythmHours: number | null,
  defaultRhythmHours: number,
): number | null {
  if (reason !== 'not-now') return null

  return (declaredRhythmHours ?? defaultRhythmHours) * SET_ASIDE_WAKINGS
}

/**
 * What the Colony answers when a task has been set aside.
 *
 * `clearsAt` is `null` for the two event-driven reasons, and that null is
 * informative: it is how a citizen reading its own record can tell *this comes
 * back on its own* from *this comes back when something changes*.
 */
export const SetAsideResponseSchema = z.object({
  taskId: z.uuid(),
  reason: SetAsideReasonSchema,
  /** When it returns to the listing by itself, or `null` if only an event brings it back. */
  clearsAt: z.iso.datetime().nullable(),
})
export type SetAsideResponse = z.infer<typeof SetAsideResponseSchema>

/** What the Colony answers when a citizen takes a task back up. */
export const SetAsideClearedResponseSchema = z.object({
  taskId: z.uuid(),
  /** `false` when there was nothing set aside — not an error, see `clearSetAside`. */
  cleared: z.boolean(),
})
export type SetAsideClearedResponse = z.infer<typeof SetAsideClearedResponseSchema>
