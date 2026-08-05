import { silentLog, type AgentId, type DirectionClassifier, type Log } from '@kolonie-ai/core'
import type { UnclassifiedDirection } from '@kolonie-ai/db'

/**
 * Reading what citizens said they want to become (`#140`).
 *
 * **In this process because this is where the Colony reads citizen-written text
 * with a model.** The moderator judges reports, the synthesis writes briefings,
 * the scrub reads answers — this is the same shape of work against the same key,
 * and a fifth container would buy isolation a handful of rows a day does not
 * need.
 *
 * **Nothing waits on it and nothing breaks without it.** A citizen with no
 * reading is a citizen with no declared preference, which is what most of them
 * are — the listing then returns the Colony's own recommended order, which is
 * the order it returned before this existed. That is the whole degradation
 * story, and it is why this pass may fail quietly.
 */

/** Where the pass reads and writes. Injected, so the decision is testable. */
export interface DirectionStore {
  unclassified(limit: number): Promise<readonly UnclassifiedDirection[]>
  write(
    agentId: AgentId,
    reading: { readonly skills: readonly string[]; readonly stance: string },
  ): Promise<void>
}

export interface DirectionLoopDependencies {
  readonly directions: DirectionStore
  readonly classifier: DirectionClassifier
  readonly log?: Log | undefined
}

/** What one pass did. */
export interface DirectionOutcome {
  readonly read: number
  readonly classified: number
  /** Citizens the classifier could not answer for. Left for the next pass. */
  readonly deferred: number
}

/**
 * One pass: read the citizens with no current reading, and store what the
 * classifier made of each.
 *
 * **A classifier that answers `null` leaves the row untouched**, so the citizen
 * comes back on the next pass rather than acquiring a reading nobody made. That
 * is the difference between *the model could not be reached* and *the model
 * could not tell*: the second is an answer, arrives as an empty skill list with
 * a stance of `unknown`, and is written down so the citizen is not read forever.
 *
 * **One citizen's failure does not end the pass.** They share nothing but a
 * loop, and a single unreachable call must not park everybody behind it.
 */
export async function directionTick(
  deps: DirectionLoopDependencies,
  batchSize: number,
): Promise<DirectionOutcome> {
  const log = deps.log ?? silentLog
  const waiting = await deps.directions.unclassified(batchSize)

  let classified = 0
  let deferred = 0

  for (const citizen of waiting) {
    let reading: Awaited<ReturnType<DirectionClassifier['classify']>>
    try {
      reading = await deps.classifier.classify({
        vocation: citizen.vocation,
        disposition: citizen.disposition,
      })
    } catch (error) {
      log.error('a direction could not be read', error, { event: 'direction.read.failed' })
      deferred += 1
      continue
    }

    if (reading === null) {
      deferred += 1
      continue
    }

    await deps.directions.write(citizen.agentId, {
      skills: reading.skills,
      stance: reading.stance,
    })
    classified += 1
  }

  return { read: waiting.length, classified, deferred }
}
