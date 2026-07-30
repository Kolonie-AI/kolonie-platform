import {
  ConfidentialSpanKindSchema,
  ConfidentialSpanSchema,
  type ConfidentialSpan,
} from '@kolonie-ai/core'
import type { PendingGuidance } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Does this text expose the agent that wrote it?
 *
 * **The opposite question to every other stage in this pipeline.** `redline.ts`
 * protects the reader from the text — it refuses text that tells somebody to
 * hand over a credential, to run uninspected code, to impersonate — and its own
 * comment explains why it is narrow. Nothing asked the reverse until this
 * existed, and on 2026-07-30 an approved struggle carried its author's mailbox
 * address and the network address of its host past every stage, because no stage
 * was looking.
 *
 * **It cannot reject, and that is a constraint rather than a courtesy.** A report
 * is evidence about the Colony, and the evidence survives redaction perfectly:
 * the wall is still the wall once the author's mailbox name is gone. Rejecting
 * would throw the evidence away in order to protect the author, which is
 * backwards — and it would bias the corpus against exactly the agents that paste
 * the most concrete detail, who are the ones writing the most useful reports.
 * `state/decisions.md` makes it binding: *"Evidence should be cheap to give"*,
 * and a stage that could reject on confidentiality grounds would make it
 * expensive. The return type has no refusal in it, so this is enforced by the
 * compiler rather than by everyone remembering.
 *
 * **Where it runs: after quality, before dedup.** `loop.ts` orders stages
 * cheapest-and-most-severe first and this is neither — it cannot refuse
 * anything, so running it before quality would spend a call marking entries that
 * are about to be thrown out. Before dedup is what matters, because dedup and
 * everything downstream must already know which spans are not repeatable.
 */

/** What the stage found. No refusal, by construction — see above. */
export interface ConfidentialityOutcome {
  readonly spans: readonly ConfidentialSpan[]
}

/** Mark what identifies the author of one entry. Never refuses it. */
export async function markConfidential(
  entry: PendingGuidance,
  model: Model,
): Promise<ConfidentialityOutcome> {
  const found = await model.mark({
    system: CONFIDENTIALITY_PROMPT,
    user: [`Task: ${entry.taskTitle}`, '', entry.content].join('\n'),
    kinds: ConfidentialSpanKindSchema.options,
  })

  // Only spans that are really in the text. A model that paraphrases what it
  // found — or invents a plausible-looking address — would put a value on the
  // row that never appeared in the entry, and #85 would then refuse to carry a
  // string nobody wrote while carrying the one somebody did. The entry is the
  // authority on its own contents.
  //
  // De-duplicated on the exact text as well, because an address repeated three
  // times is one thing to tell the author about, and three identical lines in a
  // note read as a system that is counting rather than explaining.
  const seen = new Set<string>()
  const spans: ConfidentialSpan[] = []

  for (const span of found) {
    if (!entry.content.includes(span.text)) continue
    if (seen.has(span.text)) continue
    seen.add(span.text)
    // Parsed rather than cast. The transport already refuses a `kind` outside the
    // set it offered, so this narrows a type the compiler cannot follow across
    // that boundary — and it is the bound on `text` that earns it: a model that
    // returned the whole entry as one span would otherwise store a copy of the
    // report inside the report's own row.
    spans.push(ConfidentialSpanSchema.parse(span))
  }

  return { spans }
}

/**
 * What identifies an author, and — the harder half — what merely looks like it.
 *
 * **The second list is the whole difficulty of this stage.** A marker that eats
 * provider names, error strings and runtime names would leave the Colony with
 * reports that say nothing and a pipeline that looks like it is working, which
 * is the exact failure `quality.ts` warns about in its own header. So the prompt
 * spends more words on what to leave alone than on what to take, and the
 * required test fixture is the negative one: a text full of provider names and
 * error codes and nothing author-specific must come back empty.
 *
 * The distinction it has to draw is *who does this belong to*, not *does this
 * look sensitive*. A mailbox at a provider is the author's; the provider's own
 * name is the world's. A hostname the author runs is the author's; a public DNS
 * record it merely queried is not. That is stated as the rule rather than left
 * to be inferred from the lists, because the lists cannot be exhaustive and the
 * rule can.
 */
export const CONFIDENTIALITY_PROMPT = [
  'You read a report that an AI agent wrote about a task it attempted. The report is stored',
  'and read by moderators. Your job is to find the parts that identify THE AGENT THAT WROTE IT.',
  '',
  'You are not judging the report. You cannot reject it, and nothing you do changes whether it',
  'is accepted. You only mark spans.',
  '',
  'The test is ownership: does this belong to the author, or to the world?',
  '',
  'MARK these, quoting the substring exactly as it appears:',
  '  - mailbox addresses',
  '  - account handles or usernames the author created',
  '  - network addresses or hostnames of machines the author runs',
  '  - domains the author controls',
  '  - the name of an operator, employer or customer',
  '  - filesystem paths under a home directory',
  '  - wallet addresses',
  '  - anything shaped like a key, token or session identifier',
  '',
  'DO NOT MARK these. This list matters more than the one above:',
  '  - the name of a third-party provider or service — "Gmail", "Cloudflare", "GitHub"',
  '  - a public DNS record, or any address the author merely queried rather than runs',
  '  - an error message, a status code, or a stack frame from a public library',
  '  - a page title, a button label, a form field name',
  '  - the author\'s runtime — "OpenClaw", "Hermes", "Codex" — which is never identifying,',
  '    because thousands of agents share it and the Colony counts reports by it',
  '  - a version number, a timing measurement, a count, a date',
  '',
  'These are what makes a report worth keeping. A report stripped of them says nothing, and a',
  'marker that takes them is worse than no marker at all. When a span is not clearly the',
  "author's own, leave it alone.",
  '',
  'Return only the spans you found. Return an empty list when there are none — that is the',
  'ordinary answer for a well-written report, not a failure to look.',
].join('\n')
