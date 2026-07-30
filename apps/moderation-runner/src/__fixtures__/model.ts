import type { Classification, ComposedClaim, MarkedSpan, Model } from '../llm.js'

/**
 * One thing the model was asked, so a test can assert what reached the prompt.
 *
 * `choices` and `kinds` are both optional because the two call shapes carry
 * different closed sets — a classification offers answers, a marking offers
 * labels — and a recorded call keeps whichever it was given rather than
 * flattening them into one field that means two things.
 */
export interface RecordedCall {
  readonly system: string
  readonly user: string
  readonly choices?: readonly string[]
  readonly kinds?: readonly string[]
  readonly sections?: readonly string[]
  readonly sourceIds?: readonly string[]
}

/**
 * A model that answers what a test told it to, and records what it was asked.
 *
 * The prompts are the substance of this app — the line between *"the provider
 * changed"* and *"my runtime's tool is broken"* lives in a paragraph of English,
 * not in a branch — so the assertions worth writing are about what reached the
 * model and what was done with its answer. Those are the two halves this fake
 * exposes.
 *
 * Answers are queued and consumed in order, because the pipeline makes up to
 * three calls per entry and a test that wants to reject at the second one has to
 * be able to say so.
 */
export interface FakeModel extends Model {
  /** Queue the next classification answers, consumed in order. */
  readonly answers: (...verdicts: Classification[]) => void
  /**
   * What the next marking call finds. Defaults to nothing.
   *
   * **Not queued the way verdicts are**, and the asymmetry is deliberate: the
   * confidentiality stage runs exactly once per entry and cannot branch, so a
   * queue would only let a test express an ordering that the pipeline cannot
   * produce. Most tests never call this, which is the point — a stage that finds
   * nothing must not change any existing verdict, and every pre-existing test in
   * this file asserts that by continuing to pass.
   */
  readonly marks: (...spans: MarkedSpan[]) => void
  /**
   * What the next synthesis writes. Defaults to nothing.
   *
   * Unqueued for the reason {@link marks} is: one synthesis per task, no
   * branching, so a queue would express an ordering the loop cannot produce.
   */
  readonly composes: (...claims: ComposedClaim[]) => void
  /** Fix what `embed` returns for a given text. Anything unlisted embeds as orthogonal. */
  readonly embedsAs: (text: string, vector: readonly number[]) => void
  /** Every call the pipeline made, in order — classifications and markings alike. */
  readonly calls: () => RecordedCall[]
  readonly lastCall: () => RecordedCall | undefined
  /** Make the next call throw, to test that one bad entry does not stop the queue. */
  readonly failsNext: (error: Error) => void
}

export function fakeModel(): FakeModel {
  const queued: Classification[] = []
  const calls: RecordedCall[] = []
  const vectors = new Map<string, readonly number[]>()
  let marked: MarkedSpan[] = []
  let composed: ComposedClaim[] = []
  let failure: Error | undefined

  /**
   * The default for anything a test did not pin: a vector orthogonal to
   * everything else, so unlisted texts are never candidates. A test that cares
   * about similarity says so; one that does not gets no accidental merges.
   *
   * **The dimension has to exceed the number of texts one call embeds**, and
   * that stopped being obvious when dedup began comparing segments rather than
   * whole entries. At sixteen dimensions the seventeenth unpinned text reused
   * the first one's axis — two identical unit vectors, cosine 1.0, and a merge
   * a test never asked for. It cost an afternoon once; the ceiling is now far
   * above anything a fixture will reach.
   */
  const ORTHOGONAL_DIMENSIONS = 256
  let orthogonal = 0
  const vectorFor = (text: string): readonly number[] => {
    const pinned = vectors.get(text)
    if (pinned !== undefined) return pinned
    const axis = orthogonal++
    if (axis >= ORTHOGONAL_DIMENSIONS) {
      throw new Error(
        `fakeModel ran out of orthogonal axes at ${axis}; raise ORTHOGONAL_DIMENSIONS`,
      )
    }
    return Array.from({ length: ORTHOGONAL_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0))
  }

  return {
    /**
     * A name a test can assert on, and deliberately not the real default.
     *
     * `moderations.model` records what judged, so a test that expected
     * `MODERATION_MODEL` here would pass whether the runner read the configured
     * model or hard-coded the constant — which is the exact confusion the column
     * exists to prevent.
     */
    name: 'fake/test-model',

    async classify(input) {
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      calls.push(input)
      const next = queued.shift()
      if (next === undefined) {
        throw new Error(
          `the pipeline asked for a verdict the test did not queue. Choices: ${input.choices.join(', ')}`,
        )
      }
      return next
    },
    async mark(input) {
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      calls.push(input)
      return marked
    },
    async compose(input) {
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      calls.push(input)
      return composed
    },
    async embed(inputs) {
      return inputs.map(vectorFor)
    },
    answers: (...verdicts) => {
      queued.push(...verdicts)
    },
    marks: (...spans) => {
      marked = spans
    },
    composes: (...claims) => {
      composed = claims
    },
    embedsAs: (text, vector) => {
      vectors.set(text, vector)
    },
    calls: () => [...calls],
    lastCall: () => calls.at(-1),
    failsNext: (error) => {
      failure = error
    },
  }
}
