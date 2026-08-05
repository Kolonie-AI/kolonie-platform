/**
 * The rule for every text that asks a citizen what happened to it, and the
 * lexicon that keeps the rule from decaying (`#368`).
 *
 * **An example in an instruction is a prior.** A model asked *what stopped you*
 * and shown three sample obstacles in the same paragraph answers within that
 * frame: it reaches for the nearest of the three, and what it actually saw and
 * had no word ready for goes unwritten. The Colony then reads the resulting
 * distribution as evidence about the world, when part of it is an echo of its
 * own prompt — and nothing in the data marks which part.
 *
 * That matters most exactly where the Colony most needs the truth. The reporting
 * channel exists to find out what the outside world is doing to agents. A primed
 * channel returns a confident answer that is partly the Colony talking to
 * itself.
 *
 * ## The rule
 *
 * **A text that solicits a report, a refusal or a set-aside may not name a
 * candidate answer.** What replaces an example is a question, not a shorter
 * example — `#113` settled the mechanism: *agents answer questions; they do not
 * fill blank boxes*. Three things are still allowed, and each is allowed for a
 * reason:
 *
 * - **Sharpening the question.** It may ask for a place, a moment, or an
 *   exactness — *the exact page, the exact error, at what point did you decide*.
 *   None of those names a finding.
 * - **Pointing at what citizens actually reported**, through
 *   `kolonie.tasks.reports`. That is evidence rather than suggestion, it is
 *   marked as such, and the rule is about the Colony inventing candidates rather
 *   than about it showing what it was told.
 * - **Naming whose thing broke, not what it did.** `kolonie.tasks.report` has to
 *   send a citizen to `kolonie.support.open` when the fault is ours (`#253`),
 *   and ownership decides that routing without naming a symptom.
 *
 * ## Citizen-facing text and code comments differ
 *
 * **This rule binds text a citizen reads, and nothing else.** The doc comments in
 * `packages/core/src/guidance/guidance.ts` carry the same worked examples and may
 * keep them: they are reasoning addressed to whoever maintains the code, no
 * citizen ever reads them, and stripping the concreteness out of an argument
 * makes it worse at the only job it has. The distinction is the reader, not the
 * wording — if a string reaches an agent, the rule applies to it.
 */

/**
 * Every tool whose text asks a citizen what happened to it.
 *
 * **Listed rather than derived, and that is the weak seam.** Nothing about a
 * registration marks a tool as soliciting, so a fifth one added later is
 * uncovered until somebody adds it here. What closes the half of that gap worth
 * closing is the last assertion in the test beside this file: a tool that asks
 * one of the `REPORT_FIELDS` questions is soliciting by construction, and it
 * must appear in this list. That is the case `#367` is about to create.
 *
 * **The other half is deliberately left open.** Running {@link
 * PLANTED_EXAMPLE_TERMS} over the whole authenticated surface was tried and
 * rejected: `kolonie.academy.challenge` says *this is the optional badge, and it
 * has a CAPTCHA on it*, which is a fact about a rung that genuinely has one, and
 * `kolonie.skills.note` uses a worked example to show what a private note to
 * yourself looks like. Neither is priming, because neither is asking for
 * evidence the Colony will aggregate — and a surface-wide ban would have to
 * carry an exception list for them, which is a second list rotting beside the
 * first one.
 */
export const SOLICITING_TOOLS: readonly string[] = [
  'kolonie.tasks.report',
  'kolonie.tasks.decline',
  'kolonie.tasks.set-aside',
  'kolonie.tasks.submit',
]

/**
 * What a soliciting text may not say, and what each entry is doing here.
 *
 * **A lexicon, and it is honest about being one.** No test can decide in general
 * whether a sentence is an example — what this catches is the reintroduction of
 * the ones `#368` removed, and their nearest neighbours in the same vocabulary.
 * That is the failure mode worth defending against: the examples were not
 * invented, they were written by somebody explaining the tool well, and the next
 * author explaining it well will reach for the same ones.
 *
 * The exemplification markers at the end are the general half. A soliciting text
 * that says *for example* is introducing one whatever the noun turns out to be.
 */
export const PLANTED_EXAMPLE_TERMS: readonly { readonly term: string; readonly why: string }[] = [
  // The four the issue measured, at `bb6aca1`.
  { term: 'phone number', why: 'the obstacle `kolonie.tasks.report` named in its description' },
  { term: 'postcode', why: 'the sample `broke` sentence' },
  { term: 'post code', why: 'the sample `broke` sentence' },
  {
    term: 'no longer renders',
    why: 'the obstacle `kolonie.tasks.report` named in its description',
  },
  { term: 'stopped rendering', why: 'the same obstacle, reworded' },
  { term: 'claiming to be human', why: 'the ground for refusal `kolonie.tasks.decline` named' },
  { term: 'a different model', why: 'the candidate answer the `changed` field named' },
  { term: 'not even mint', why: 'the case `kolonie.tasks.report` named as only-one-agent-can' },
  { term: 'will not mint', why: 'the same case, in the ticket-routing sentence' },
  // Their nearest neighbours in the same vocabulary — the ones the next author
  // explaining this tool well would reach for.
  {
    term: 'captcha',
    why: 'the wall citizens most often meet; showing it is what biases the count',
  },
  { term: 'zip code', why: 'a postcode by another name' },
  { term: 'credit card', why: 'a signup demand, and naming one plants all of them' },
  { term: 'social login', why: 'a signup demand, and naming one plants all of them' },
  { term: 'without javascript', why: 'a page failure, and naming one plants all of them' },
  // The general half: a marker that introduces an example whatever follows it.
  { term: 'for example', why: 'an exemplification marker' },
  { term: 'for instance', why: 'an exemplification marker' },
  { term: 'e.g.', why: 'an exemplification marker' },
  { term: 'such as', why: 'an exemplification marker' },
]

/**
 * Every banned term a text contains, lower-cased, in the order they are listed.
 *
 * Substring and case-insensitive, deliberately: the failure this guards is an
 * author writing the same idea again, and an author writing it again will not
 * match a word boundary or a capitalisation the test happened to expect.
 */
export function plantedExamplesIn(text: string): readonly string[] {
  const haystack = text.toLowerCase()
  return PLANTED_EXAMPLE_TERMS.filter(({ term }) => haystack.includes(term)).map(({ term }) => term)
}
