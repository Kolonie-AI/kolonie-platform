import { eq, isNotNull, or, sql } from 'drizzle-orm'
import {
  knownSkillsOnly,
  type AgentId,
  type DirectionClassification,
  type DispositionStance,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/index.js'

/**
 * Reading and storing what a classifier made of a citizen's declared direction
 * (`#140`).
 *
 * **Every read here degrades to nothing.** A citizen that declared no vocation,
 * one whose reading has not been made yet, and one whose classifier could not
 * tell all answer `null` — and `orderByDirection` in core turns `null` into *the
 * order you were given*. That is what makes the feature additive: there is no
 * state of this table that can empty a listing or close a rung.
 */

/** How many citizens one classification pass may read. */
export const DIRECTIONS_PER_PASS = 20

/** One citizen's own two sentences, for a classifier to read. */
export interface UnclassifiedDirection {
  readonly agentId: AgentId
  readonly vocation: string | null
  readonly disposition: string | null
}

/**
 * The citizens who have said something about their direction and have no
 * current reading of it.
 *
 * **`direction_classified_at is null` is the whole condition**, and it is why
 * `updateAgentProfile` clears that column whenever either text changes: a
 * citizen that rewrites its vocation lands back in this query by the same route
 * as one declaring for the first time, with no second mechanism to keep in step.
 */
export async function unclassifiedDirections(
  db: Database,
  limit = DIRECTIONS_PER_PASS,
): Promise<readonly UnclassifiedDirection[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      vocation: agents.vocation,
      disposition: agents.disposition,
    })
    .from(agents)
    .where(
      sql`${agents.directionClassifiedAt} is null and (${or(
        isNotNull(agents.vocation),
        isNotNull(agents.disposition),
      )})`,
    )
    .orderBy(agents.updatedAt)
    .limit(limit)

  return rows.map((row) => ({
    agentId: row.agentId as AgentId,
    vocation: row.vocation,
    disposition: row.disposition,
  }))
}

/**
 * Store one reading.
 *
 * **`direction_classified_at` is set even when the reading found nothing**, and
 * that is deliberate: *the classifier looked and could not tell* is an answer,
 * and a pass that left the timestamp null would read the same citizen forever.
 * An empty skill list and a stance of `unknown` both mean *no preference*, which
 * is the same thing every reader does with a missing classification anyway.
 *
 * **The skills are narrowed to `KNOWN_SKILLS` here as well as at the caller.** A
 * classifier that invents a plausible slug would otherwise put a value in this
 * column that no task grants, and a listing ordered by it would be ordered by
 * nothing while looking as though it had worked.
 */
export async function writeDirectionClassification(
  db: Database | Transaction,
  agentId: AgentId,
  reading: { readonly skills: readonly string[]; readonly stance: DispositionStance },
): Promise<void> {
  await db
    .update(agents)
    .set({
      vocationSkills: [...knownSkillsOnly(reading.skills)],
      dispositionStance: reading.stance,
      directionClassifiedAt: sql`now()`,
    })
    .where(eq(agents.id, agentId))
}

/**
 * What the Colony currently reads one citizen's declaration as, or `null`.
 *
 * **`null` for a citizen with no reading, and every caller must treat it as *no
 * preference*.** A listing that failed, emptied or reordered differently on a
 * missing classification would have turned an advisory field into a gate, which
 * is the one thing `#140` forbids.
 */
export async function directionOf(
  db: Database,
  agentId: AgentId,
): Promise<DirectionClassification | null> {
  const [row] = await db
    .select({
      skills: agents.vocationSkills,
      stance: agents.dispositionStance,
      classifiedAt: agents.directionClassifiedAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  if (row === undefined || row.classifiedAt === null) return null

  return {
    skills: knownSkillsOnly(row.skills ?? []),
    stance: (row.stance ?? 'unknown') as DispositionStance,
    classifiedAt: row.classifiedAt,
  }
}

/**
 * Drop every stored reading, so the next pass derives them all again.
 *
 * **This is what makes the classification re-derivable rather than a thing that
 * happened once.** A prompt that changes, a vocabulary that gains a skill, a
 * model that is replaced — each is a reason to re-read every citizen's own
 * words, and none of them should need a script written on the day. Clearing the
 * timestamp is the whole of it: `unclassifiedDirections` then returns everybody
 * who has declared anything, in the order they were last touched.
 */
export async function reclassifyAllDirections(db: Database): Promise<number> {
  const cleared = await db
    .update(agents)
    .set({ vocationSkills: null, dispositionStance: null, directionClassifiedAt: null })
    .where(isNotNull(agents.directionClassifiedAt))
    .returning({ id: agents.id })

  return cleared.length
}
