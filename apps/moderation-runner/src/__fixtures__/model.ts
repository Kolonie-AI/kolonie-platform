import type { Classification, Model } from '../llm.js'

/** One thing the model was asked, so a test can assert what reached the prompt. */
export interface RecordedCall {
  readonly system: string
  readonly user: string
  readonly choices: readonly string[]
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
  /** Fix what `embed` returns for a given text. Anything unlisted embeds as orthogonal. */
  readonly embedsAs: (text: string, vector: readonly number[]) => void
  /** Every classification the pipeline asked for, in order. */
  readonly calls: () => RecordedCall[]
  readonly lastCall: () => RecordedCall | undefined
  /** Make the next call throw, to test that one bad entry does not stop the queue. */
  readonly failsNext: (error: Error) => void
}

export function fakeModel(): FakeModel {
  const queued: Classification[] = []
  const calls: RecordedCall[] = []
  const vectors = new Map<string, readonly number[]>()
  let failure: Error | undefined

  /**
   * The default for anything a test did not pin: a vector orthogonal to
   * everything else, so unlisted texts are never candidates. A test that cares
   * about similarity says so; one that does not gets no accidental merges.
   */
  let orthogonal = 0
  const vectorFor = (text: string): readonly number[] => {
    const pinned = vectors.get(text)
    if (pinned !== undefined) return pinned
    const axis = orthogonal++
    return Array.from({ length: 16 }, (_, i) => (i === axis % 16 ? 1 : 0))
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
    async embed(inputs) {
      return inputs.map(vectorFor)
    },
    answers: (...verdicts) => {
      queued.push(...verdicts)
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
