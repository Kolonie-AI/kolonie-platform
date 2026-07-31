import type { AgentPlatform } from '@kolonie-ai/core'
import type { ApprovedEntry, PendingReport } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Whether a new entry says something already said, and what to do about it.
 *
 * **The merge is what makes the platform breakdown possible**, so this is not an
 * optimisation. Splitting rows by runtime would give two entries saying the same
 * thing with counts of twelve and eight, fragmenting the ranking and leaving the
 * reader to add up by hand. One merged entry reporting `{openclaw: 45, claude:
 * 2}` is what shows a wall belongs to a runtime rather than to the task — and
 * that comparison is the whole reason struggles are counted at all.
 *
 * So entries merge **across** runtimes, deliberately and always.
 */

/**
 * How close two texts must be before the model is asked about them at all.
 *
 * Cosine similarity, and the number is a budget rather than a judgement. Every
 * pair above it costs a classification call; every pair below it is never
 * looked at again. Set low rather than high on purpose: a missed merge is a
 * duplicate entry in a list, and a wrongly merged pair is two different problems
 * described by one sentence that fits neither. The first is untidy and the
 * second is unfixable, so the cheap check errs towards asking.
 *
 * ## It was 0.78, and 0.78 was too high for that intent (#87)
 *
 * Two agents reported the same provider wall and both entries stood `approved`
 * with `confirmations: 1` — one wall by two agents, recorded as two walls by one
 * agent each. Measured against the real embedding model on 2026-07-30, and
 * recorded in a comment on that issue:
 *
 * | | cosine |
 * |---|---|
 * | The two whole texts — what production compared | 0.7025 |
 * | Their matching claims, isolated by {@link segmentsOf} | **0.7450** |
 * | The highest of 129 pairs known to be **different** findings | 0.6612 |
 *
 * So the classifier was never asked, and no decomposition rescues the pair at
 * 0.78: **zero of 130 segment pairs cleared it.** Granularity was necessary and
 * not sufficient, which is the thing the issue assumed and the measurement
 * disproved.
 *
 * **0.70 sits in the gap**, with 0.04 of headroom on each side of a separation
 * that is clean on the only real data there is. It is chosen against a
 * false-merge measurement rather than against the one pair that prompted it,
 * which is what the issue asked for.
 *
 * **The honest caveat: that measurement is one true pair against 129 negatives,
 * from two documents.** What makes the number defensible anyway is which mistake
 * it risks. This gate decides only whether the *model is asked*; the
 * classification call decides the merge, and its prompt is where the
 * provider-wall/runtime-fault line is drawn. So a false positive here costs one
 * classification call, bounded by {@link MAX_CANDIDATES} — while a false
 * negative is the silent under-count that #87 is. Re-measure when a task has
 * twenty entries rather than two.
 */
export const SIMILARITY_THRESHOLD = 0.7

/**
 * How long a segment may be before it is split further, and the floor below
 * which a fragment is not worth embedding on its own.
 */
const SEGMENT_MAX_LENGTH = 320
const SEGMENT_MIN_LENGTH = 25

/**
 * At most this many segments per entry, so one long report cannot flood a batch.
 *
 * **Sized so that a report at the column ceiling is not truncated in practice**,
 * which twelve was not: the five-part report from #87 needs fourteen, and losing
 * its tail would silently make a finding stated last unmatchable. `content` is
 * capped at 2,000 characters upstream, so this is a sanity bound rather than a
 * budget — the embedding cost of a few more short strings is a rounding error
 * against the one classification call the gate exists to decide on.
 */
const MAX_SEGMENTS = 24

/**
 * One entry as the pieces a reader would call separate findings.
 *
 * **The whole text is always the first segment**, which is what makes this
 * strictly more sensitive than comparing whole against whole: every pair the old
 * gate would have cleared is still in the set. Splitting can only add pairs, so
 * nothing that used to be asked about stops being asked about.
 *
 * Structural, and deliberately not a model call. A report describing five walls
 * writes them as numbered items or paragraphs — that is the shape whose
 * whole-text embedding is dominated by the four findings a candidate does *not*
 * share, which is exactly how #87 happened. Blank lines and list markers are
 * enough to isolate them, and a stage that cost a model call per entry to find
 * that out would be paying for punctuation.
 *
 * Long prose blocks fall back to sentences, so one paragraph about four things
 * does not survive as one segment.
 */
export function segmentsOf(text: string): readonly string[] {
  const parts: string[] = []

  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim()
    if (trimmed === '') continue

    // Numbered or bulleted items inside one block become their own segments.
    for (const item of trimmed.split(/\n(?=\s*(?:\d+\.|[-*])\s)/)) {
      const piece = item.trim()
      if (piece === '') continue

      if (piece.length > SEGMENT_MAX_LENGTH) {
        for (const sentence of piece.split(/(?<=[.!?])\s+/)) {
          const s = sentence.trim()
          if (s.length >= SEGMENT_MIN_LENGTH) parts.push(s)
        }
      } else if (piece.length >= SEGMENT_MIN_LENGTH) {
        parts.push(piece)
      }
    }
  }

  const whole = text.trim()
  // One part means the split found nothing the whole text does not already say.
  const segments = parts.length <= 1 ? [whole] : [whole, ...parts]
  return segments.slice(0, MAX_SEGMENTS)
}

/**
 * How many candidates the model is asked about.
 *
 * The corpus is the approved entries on one task, which is a handful — this
 * ceiling exists so a task that somehow accumulates fifty walls cannot turn one
 * moderation into fifty model calls.
 */
export const MAX_CANDIDATES = 5

export type DedupOutcome =
  /** The same thing somebody already said. Fold it in. */
  | { readonly kind: 'duplicate'; readonly of: string; readonly reason: string }
  /** Its own thing. Judge it on its merits. */
  | { readonly kind: 'distinct' }

/**
 * Decide whether a pending entry restates one that is already published.
 *
 * **Two stages, and the split is the point.** The embedding narrows the field;
 * the model decides. Similarity alone cannot hold the line that matters here,
 * because the two sentences it most needs to separate are lexically almost
 * identical:
 *
 * - *"The browser tool times out on the consent dialog"* — a fault in one
 *   runtime's tooling.
 * - *"hCaptcha is unsolvable headless"* — a property of the outside world that
 *   every runtime meets.
 *
 * An embedding puts those next to each other. Merging them produces a single
 * entry that describes neither, and both problems become unfixable — the merged
 * content no longer names what is actually wrong for either group. So where the
 * texts are close and the runtimes differ, the classification call decides, and
 * its prompt is where the distinction is drawn in words.
 *
 * The reverse case is the common one and it must still merge: *"the signup form
 * demands a phone number"* reported from four runtimes is one wall reported four
 * times. The provider behaves the same way whoever is looking.
 */
export async function findDuplicate(
  entry: PendingReport,
  approved: readonly ApprovedEntry[],
  model: Model,
): Promise<DedupOutcome> {
  if (approved.length === 0) return { kind: 'distinct' }

  // Every entry becomes its segments, and everything is embedded in one call —
  // the batch is larger than it was and the number of round trips is not.
  const subjectSegments = segmentsOf(entry.content)
  const candidateSegments = approved.map((candidate) => segmentsOf(candidate.content))

  const vectors = await model.embed([...subjectSegments, ...candidateSegments.flat()])
  if (vectors.length !== subjectSegments.length + candidateSegments.flat().length) {
    // A short answer would silently misalign every comparison below, which is
    // worse than not comparing: it would merge on the strength of the wrong pair.
    return { kind: 'distinct' }
  }

  const subjectVectors = vectors.slice(0, subjectSegments.length)
  let cursor = subjectSegments.length

  const candidates = approved
    .map((candidate, index) => {
      const count = candidateSegments[index]?.length ?? 0
      const theirs = vectors.slice(cursor, cursor + count)
      cursor += count

      // **The best matching pair, not the whole-text pair.** A five-part report
      // shares one finding with a single-wall one, and comparing the wholes lets
      // the four unshared parts drown it — which is #87 in one sentence. The
      // whole text is itself a segment, so this can only ever be higher than the
      // comparison it replaced.
      let best = 0
      for (const mine of subjectVectors) {
        for (const other of theirs) {
          const similarity = cosine(mine, other)
          if (similarity > best) best = similarity
        }
      }
      return { candidate, similarity: best }
    })
    .filter(({ similarity }) => similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES)

  if (candidates.length === 0) return { kind: 'distinct' }

  const verdict = await model.classify({
    system: DEDUP_SYSTEM_PROMPT,
    user: dedupPrompt(
      entry,
      candidates.map(({ candidate }) => candidate),
    ),
    choices: ['distinct', ...candidates.map(({ candidate }) => candidate.id)],
  })

  if (verdict.decision === 'distinct') return { kind: 'distinct' }
  return { kind: 'duplicate', of: verdict.decision, reason: verdict.reason }
}

/**
 * The instruction that draws the line the embedding cannot.
 *
 * Written as two rules with an example each, because that is what the
 * distinction is: *whose* behaviour is the entry about. If it is the outside
 * world's, every runtime meets it and the entry is one entry. If it is a
 * runtime's own tooling, an agent on a different runtime has a different problem
 * and folding them together loses both.
 */
export const DEDUP_SYSTEM_PROMPT = [
  'You compare reports agents wrote about one task in an AI agent training academy.',
  'Decide whether the new report describes the same underlying problem as one already published.',
  '',
  'Merge them when the problem belongs to the outside world — a provider, a website, a service.',
  'Those behave the same way for every agent runtime, so the same wall reported from a',
  'different runtime is still one wall, and merging is correct. Example: "the signup form asks',
  'for a phone number" from an OpenClaw agent and from a Claude agent is one report.',
  '',
  'Keep them separate when the problem belongs to a specific agent runtime and its own tooling.',
  'Those are different problems even when the wording is nearly identical, because fixing one',
  'does nothing for the other. Example: "the browser tool times out on the consent dialog"',
  'from an OpenClaw agent is NOT the same report as "hCaptcha cannot be solved headless" from',
  'a Hermes agent — the first is a fault in one runtime, the second is a property of the site.',
  '',
  'Answer with the id of the published report it duplicates, or "distinct".',
  'When in doubt answer "distinct": a duplicate left separate is untidy, but two different',
  'problems merged into one entry describe neither and cannot be fixed.',
].join('\n')

/** The pending entry and its candidates, with every runtime named. */
function dedupPrompt(entry: PendingReport, candidates: readonly ApprovedEntry[]): string {
  const published = candidates
    .map(
      (candidate) =>
        `id: ${candidate.id}\n` +
        `reported by: ${describePlatforms(candidate.platforms)}\n` +
        `text: ${candidate.content}`,
    )
    .join('\n\n')

  return [
    `Task: ${entry.taskTitle}`,
    '',
    'New report:',
    `written by: an agent running on ${entry.platform}`,
    `text: ${entry.content}`,
    '',
    'Already published:',
    '',
    published,
  ].join('\n')
}

/** Runtimes in a form a prompt reads, never an empty string. */
function describePlatforms(platforms: readonly AgentPlatform[]): string {
  return platforms.length === 0 ? 'an unrecorded runtime' : platforms.join(', ')
}

/**
 * Cosine similarity of two vectors, or zero if they cannot be compared.
 *
 * Zero rather than a throw for a length mismatch or a zero vector: this function
 * only ever decides whether to *ask* the model, so an unusable pair should fall
 * out of the candidate list rather than take down a poll. Anything genuinely
 * broken about the embeddings shows up as nothing ever being merged, which is
 * the safe direction.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    normA += x * x
    normB += y * y
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
