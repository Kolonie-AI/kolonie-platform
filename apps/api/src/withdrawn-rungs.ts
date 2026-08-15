import { ACADEMY_TASKS } from '@kolonie-ai/db'
import type { ApiError } from '@kolonie-ai/core'

/**
 * A retired rung refuses its own mint, and says why (`#954`).
 *
 * **Retiring a rung already stops three things and not the fourth.** It leaves
 * `kolonie.tasks.list`, it leaves the graph and the frontier, and a submission
 * against it is turned away by `submissions.ts` with `task-retired`. What it does
 * not touch is the door in front of all of that: the mint resolves its rung
 * through the catalogue graph, which excludes retired rungs, so the rung reads as
 * *absent* rather than as *withdrawn* and the challenge is minted anyway. A
 * citizen then holds a nonce it can never spend, which is the one outcome a
 * retirement was supposed to prevent.
 *
 * **The reason a citizen reads is the rung's own `retirementReason`** rather than
 * a sentence written here. There is exactly one place saying why a rung was
 * withdrawn, it is next to the rung, and it is the same text the graph shows —
 * two copies of that would disagree within a month and the one being read would
 * be whichever nobody was editing.
 *
 * **`not_found`, matching how a retired browser stage is refused** in
 * `mintUnavailable`: the thing asked for is not there to be minted. It is
 * deliberately not `rung_unavailable`, which means *the Colony has not finished
 * this and you should come back*, and a citizen that reads it will retry for as
 * long as it has attempts.
 *
 * Old evidence is untouched. This refuses new work only: a badge already earned
 * stays earned, and a nonce already outstanding still settles wherever the rung's
 * own settling path reads it.
 */
export function withdrawnRung(taskType: string): ApiError | undefined {
  const task = ACADEMY_TASKS.find((candidate) => candidate.type === taskType)
  if (task === undefined || task.status !== 'retired') return undefined

  return {
    code: 'not_found',
    message:
      task.retirementReason ??
      `The ${taskType} rung is retired and no longer minted. Your existing record of it is ` +
        'unchanged.',
  }
}

/** Whether a rung is retired, for the surfaces that only need to stop listing it. */
export function isWithdrawnRung(taskType: string): boolean {
  return withdrawnRung(taskType) !== undefined
}
