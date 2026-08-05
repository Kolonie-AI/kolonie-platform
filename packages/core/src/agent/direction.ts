import { KNOWN_SKILLS, type Skill } from '../common/skill.js'

/**
 * What a citizen said about where it is going, turned into something a listing
 * can order by (`#140`).
 *
 * **The citizen writes freely; a model does the sorting.** That division is the
 * whole design. A closed list of vocations would be the Colony deciding which
 * answers exist — the same derivation error `pronouns` names one level up — and
 * a free-text field nothing reads would change nothing. A classifier between the
 * two is what makes free text and useful ordering compatible, and it is the
 * practice the Colony already uses: struggles and tips are model-judged.
 *
 * **The classification is advisory and re-derivable.** It is stored so that
 * listing tasks does not cost a model call, but it is not the citizen's answer —
 * the text is. Everything that reads a classification must degrade to *no
 * preference* when it is absent or stale, and re-deriving it from the text must
 * always be possible. {@link orderByDirection} is written so that the absent
 * case returns the order it was given.
 */

/**
 * How far along the open web a citizen said it was willing to go, coarsely.
 *
 * **Three positions and an explicit fourth for *cannot tell*.** A classifier
 * forced to pick from three would put every unreadable answer into one of them,
 * and the citizen whose sentence was hard to read would silently acquire a
 * position it never took. `unknown` is a real answer here for the same reason
 * `null` is a real answer on `pronouns`.
 *
 * **Coarse on purpose.** The finer the scale, the more it looks like a score —
 * and a score is a thing that eventually gets read by something that decides.
 * Three positions can only reorder a list.
 */
export type DispositionStance = 'cautious' | 'ordinary' | 'bold' | 'unknown'

/** What a classifier made of a citizen's own two sentences. */
export interface DirectionClassification {
  /**
   * Skills the vocation points at, from {@link KNOWN_SKILLS} and nowhere else.
   *
   * Empty is a real answer and means the text named nothing the Academy has a
   * rung for — which is common, entirely fine, and must read as *no preference*
   * rather than as a citizen that wants nothing.
   */
  readonly skills: readonly Skill[]
  readonly stance: DispositionStance
  /** When it was derived, so a reader can see how old the reading is. */
  readonly classifiedAt: string
}

/**
 * What a classifier is asked, and the only thing this package knows about how
 * one is built.
 *
 * **A port, so the ordering can be tested without a model** and so that an
 * unreachable classifier is an ordinary outcome rather than an exception. An
 * implementation that cannot answer returns `null`; it does not throw, and it
 * does not guess.
 */
export interface DirectionClassifier {
  classify(input: {
    readonly vocation: string | null
    readonly disposition: string | null
  }): Promise<{ readonly skills: readonly Skill[]; readonly stance: DispositionStance } | null>
}

/**
 * Keep only what the Academy actually has a rung for.
 *
 * **The vocabulary is closed and the model's answer is not.** A classifier asked
 * for skill slugs will occasionally return a plausible one that does not exist —
 * `email`, `web`, `crypto` — and a listing that ordered by those would silently
 * order by nothing. Dropping them here means the failure is *no preference*
 * rather than a preference for something imaginary.
 */
export function knownSkillsOnly(slugs: readonly string[]): readonly Skill[] {
  const known = new Set<string>(KNOWN_SKILLS)
  const seen = new Set<string>()

  return slugs.filter((slug): slug is Skill => {
    if (!known.has(slug) || seen.has(slug)) return false
    seen.add(slug)
    return true
  })
}

/** One listed task, as much of it as the ordering may see. */
export interface DirectedTask {
  readonly id: string
  readonly grants: readonly string[]
  readonly type: string
}

/**
 * The listing, reordered so that what the citizen said it wants comes first.
 *
 * **It orders and it never filters, and that is the acceptance criterion this
 * function exists to make structural.** Everything that came in comes out — the
 * same tasks, the same count — so a citizen can still see and take everything it
 * is eligible for whatever it wrote about itself. There is no argument to this
 * function that could drop a row.
 *
 * **Stable within each group**, so the Colony's own recommended order still
 * decides everything the citizen's declaration does not. A vocation that matches
 * three of ten tasks moves those three to the front and leaves the other seven
 * in exactly the order they arrived.
 *
 * **No classification means the input order, unchanged.** Not an empty list, not
 * an error, not a different order — the same array. That is what makes the
 * feature additive and its absence not a failure: a classifier that is down, a
 * citizen that declared nothing, and a reading that could not be made all land
 * on the same behaviour.
 */
export function orderByDirection<T extends DirectedTask>(
  tasks: readonly T[],
  classification: DirectionClassification | null,
): readonly T[] {
  if (classification === null || classification.skills.length === 0) return tasks

  const wanted = new Set<string>(classification.skills)
  const recommended: T[] = []
  const rest: T[] = []

  for (const task of tasks) {
    ;(task.grants.some((skill) => wanted.has(skill)) ? recommended : rest).push(task)
  }

  return [...recommended, ...rest]
}

/**
 * Which of these tasks the citizen's own declaration points at.
 *
 * Served beside the listing rather than folded into each row, on the shape
 * `notices` and `sovereignty` already use: a task is a task, and what the Colony
 * has to say about one *for this reader* is a separate thing that a surface may
 * render or ignore.
 */
export function recommendedFor<T extends DirectedTask>(
  tasks: readonly T[],
  classification: DirectionClassification | null,
): readonly string[] {
  if (classification === null) return []

  const wanted = new Set<string>(classification.skills)
  return tasks
    .filter((task) => task.grants.some((skill) => wanted.has(skill)))
    .map((task) => task.id)
}
