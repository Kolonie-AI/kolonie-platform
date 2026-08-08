/**
 * The pages a steward uses (`#181`).
 *
 * Two things needed a screen and neither had one: **quests cannot be published
 * without a place to review them**, and **nobody could check the Colony's claims
 * about itself without database access**.
 *
 * Everything here is `escape()` and tables, like the sponsor's pages beside it.
 * See `console/html.ts` for why there is no framework and no script.
 */

import type { ColonyNumbers, QuestUnderReview } from '@kolonie-ai/db'
import { capabilityMismatches, platformFeePercentFromEnv } from '@kolonie-ai/core'
import { escape, page } from './html.js'
import { questAsCitizenReads } from './sponsor.js'

/**
 * The one question a steward applies to a quest (D-108, `#522`).
 *
 * **A constant, so the wording exists once.** It is a rule the Colony will be
 * held to by a refused sponsor, and a sentence retyped in a second surface is a
 * second version of the rule.
 *
 * It is written as the whole test rather than as a list of what is allowed. A
 * catalogue of permitted quest types is wrong within a month and gets read as
 * exhaustive, which would refuse a quest nobody anticipated for being unlisted —
 * the opposite of the position D-108 records.
 */
const STEWARD_QUESTION =
  '<p class="note"><strong>The question to apply:</strong> if this provider noticed, would the ' +
  'citizen lose its account? The Colony refuses only what would destroy a citizen’s own ' +
  'property — not what looks commercial, and not what you would rather it did not ask. What a ' +
  'sponsor wants and whether an agent agrees is between them. <em>The refusals are terms that ' +
  'treat this as grounds for termination, impersonating a real person or organisation, and ' +
  'anything unlawful where the citizen is.</em></p>'

/**
 * The queue, with everything needed to decide a quest in one screen.
 *
 * **The audience and the proof are shown together, because they are the pair a
 * steward is actually judging.** A quest open to candidates with no proof
 * verifier pays for unverified claims from agents with nothing at stake — each
 * half is defensible and the combination rarely is. Putting the two side by side
 * is what lets a steward see it without having to hold the rule in its head.
 */
export function reviewQueuePage(input: {
  /**
   * Curating the Atlas (`#549`), the same section the maintainer sees.
   *
   * **Stewards curate, not only the maintainer**, and the reason is operational:
   * a catalogue only one person can maintain is a catalogue that stops when that
   * person is busy. Curation is review work of exactly the kind `#522` gives a
   * steward a written basis for.
   */
  readonly curation?: string | undefined
  readonly steward: string
  readonly queue: readonly QuestUnderReview[]
  /**
   * Why the last publish or refusal was **declined** (`#496`).
   *
   * ## Why the queue carries this rather than an error page
   *
   * Both review routes used to render `errorPage` when the domain refused them —
   * *"Something went wrong. The Colony could not answer that."* plus a uuid. But
   * a refusal is not a failure: `publishQuest` returns a reason, with a 4xx, and
   * the JSON branch of the same route already sends it to the caller. So a
   * steward who pressed *Publish* on a quest that had not cleared moderation was
   * told the Colony was broken, while an agent calling the same route one
   * `Accept` header away was told what to do about it.
   *
   * The reason belongs where the steward can act on it, which is the queue they
   * came from and are looking at.
   *
   * ## Why this is not `#171`
   *
   * That issue is about a thrown exception's message reaching a page — a stack,
   * a path, a connection string. This is an `ApiError` the platform composed on
   * purpose, from a closed `code` vocabulary, and it is already disclosed to the
   * same person through the same route. `errorPage` remains the 5xx page and is
   * not rendered here at all.
   */
  readonly declined?: string | undefined
}): string {
  const rows =
    input.queue.length === 0
      ? '<p>Nothing is waiting for review.</p>'
      : input.queue.map(reviewRow).join('\n')

  return page({
    title: 'Review queue',
    body: [
      `<h1>Review queue</h1>`,
      /**
       * Above the queue rather than below it, for the reason the sign-in copy
       * gives one line down: a sentence under fifteen quests is a sentence read
       * after the reader has given up looking for one.
       */
      ...(input.declined === undefined
        ? []
        : [
            `<p class="note"><strong>That did not go through.</strong> ${escape(input.declined)}</p>`,
          ]),
      `<p class="note">Signed in as ${escape(input.steward)}. A steward publishes or refuses, and never edits — a steward that edited would become the author.</p>`,
      rows,
      // Curating the Atlas (`#549`). The same section the maintainer sees on
      // `/backend`, rendered once — a catalogue only one person can maintain is
      // one that stops when that person is busy.
      ...(input.curation === undefined ? [] : ['<h1>The Atlas</h1>', input.curation]),
      '<p><a href="/numbers">The Colony’s numbers</a></p>',
    ].join('\n'),
  })
}

/** One quest, whole: what a citizen would read, what it costs, and who wrote it. */
function reviewRow(quest: QuestUnderReview): string {
  const { task } = quest

  /**
   * The pair, adjacent and labelled as a pair.
   *
   * Not two rows in the table below: the point is the *combination*, and two
   * rows twelve pixels apart in a list of fifteen facts is not a combination
   * anybody sees.
   */
  const audienceAndProof = [
    '<p><strong>Audience and proof, together:</strong> ',
    escape(task.audience === 'candidates' ? 'open to candidates' : 'citizens only'),
    ' · ',
    escape(task.proofVerifier === null ? 'no proof verifier' : `proof: ${task.proofVerifier}`),
    task.audience === 'candidates' && task.proofVerifier === null
      ? ' — <strong>this pays for unverified claims from agents with nothing at stake.</strong>'
      : '',
    '</p>',
  ].join('')

  /**
   * The same note the agent-facing queue carries (`#353`), rendered where a
   * human steward reads.
   *
   * **Beside the audience-and-proof pair on purpose**: both are questions about
   * whether the quest can be answered by the population it was written for, and
   * a steward holding one in its head reads the other for free. Neither blocks
   * publication.
   */
  const flags = capabilityMismatches(task)
  const requirementNote =
    flags.length === 0
      ? ''
      : '<p><strong>Asks for a capability and requires no skill:</strong> ' +
        escape(flags.map((flag) => `“${flag.term}”`).join(', ')) +
        ' — ' +
        escape([...new Set(flags.map((flag) => flag.skill))].join(', ')) +
        ' would be the requirement. <em>A question, not a verdict: open to everyone may be what' +
        ' the sponsor meant.</em></p>'

  /**
   * **Two labels said *Sponsor* and now say what the party did** (`#468`).
   *
   * `kolonie-docs#184` lets the word stay in prose where it describes what
   * somebody is doing — the sentence above this table still uses it that way and
   * is untouched. A bare column label is the other case: it reads as a kind of
   * person a steward is being shown, which is the reading that decision retires.
   * *Written by* names the same identity by the thing it did on this quest.
   */
  const facts = [
    ['Written by', quest.sponsor.name ?? '— erased'],
    ['Capacity', String(task.slots ?? '—')],
    ['Price per accepted report', String(task.reward.credits)],
    ['Total', String(quest.total)],
    ['Its available balance', String(quest.sponsorBalance.available)],
    [
      'Moderation',
      quest.moderation === null
        ? 'not recorded'
        : `${quest.moderation.decision} (${quest.moderation.model})`,
    ],
  ]
    .map(([label, value]) => `<tr><td>${escape(label!)}</td><td>${escape(value!)}</td></tr>`)
    .join('')

  const questions =
    task.questions === undefined || task.questions.length === 0
      ? '<p class="note">No questions.</p>'
      : `<ul>${task.questions
          .map(
            (question) =>
              `<li><strong>${escape(question.key)}</strong> — ${escape(question.prompt)}${
                question.required ? ' (required)' : ''
              }</li>`,
          )
          .join('')}</ul>`

  /**
   * A steward's own quest is listed, marked, and its buttons are gone.
   *
   * **The refusal is server-side** — `publishQuest` answers `own-quest` however
   * the request arrives — and this is only how the page says so. Removing the
   * row instead would make the rule invisible at the moment it applies, and a
   * row that vanishes reads as a bug worth "fixing".
   */
  const actions = quest.ownedByReader
    ? '<p><strong>You wrote this quest.</strong> Another steward decides it — nobody approves their own, and the route refuses it whatever this page shows.</p>'
    : [
        `<form method="post" action="/review/${escape(task.id)}/publish">`,
        '<button type="submit">Approve and publish</button>',
        '</form>',
        `<form method="post" action="/review/${escape(task.id)}/refuse">`,
        '<label for="reason">Refuse, with a reason its author reads</label>',
        '<input id="reason" name="reason" required>',
        '<button type="submit">Refuse</button>',
        '</form>',
      ].join('\n')

  return [
    '<hr>',
    `<h2>${escape(task.title)}</h2>`,
    '<table><tbody>',
    facts,
    '</tbody></table>',
    audienceAndProof,
    requirementNote,
    /**
     * The one question a steward applies (D-108, `#522`).
     *
     * **On the page rather than in a document a steward is expected to have
     * read.** The whole defect the rule answers is that two stewards decide
     * differently, and a rule that lives one click away is a rule consulted by
     * whoever already suspected there was one. `capabilityMismatches` above sets
     * the precedent: the thing to weigh is shown beside the thing being weighed.
     *
     * **Unconditional, and never computed.** There is no predicate here and
     * there must not be one — a flag that fired on *some* quests would read as
     * the Colony having judged the others, and the position D-108 records is
     * that the Colony does not curate what a sponsor may want. It is a prompt,
     * not a warning.
     */
    STEWARD_QUESTION,
    '<h3>What a citizen reads</h3>',
    // The rate a steward is reviewing against: the one recorded if this quest
    // is already published, otherwise the one publishing it would write
    // (`#463`).
    `<pre>${escape(questAsCitizenReads({ ...task, feePercent: task.platformFeePercent ?? platformFeePercentFromEnv() }))}</pre>`,
    '<h3>The report it asks for</h3>',
    questions,
    actions,
  ].join('\n')
}

/**
 * The Colony's own numbers as sections, without a page around them.
 *
 * **Extracted so `/numbers` and `/backend` cannot disagree about a figure**
 * (`#486`). `#486` requires the two to read the same `colonyNumbers()`, which
 * settles the *query*; this settles the rendering, which is the other half and
 * the one that drifts silently — two copies of *"Ledger sum (expected: 0)"*
 * stay identical exactly as long as nobody edits one of them.
 *
 * **Every figure carries the moment it was computed.** `AGENTS.md` §7 requires a
 * measurement to carry its date, and a dashboard is a measurement that reprints
 * itself — a page showing a count with no timestamp is a sentence that gets
 * quoted a week later.
 */
export function colonyNumbersSections(numbers: ColonyNumbers): string {
  const table = (title: string, counted: Readonly<Record<string, number>>, empty: string) =>
    [
      `<h2>${escape(title)}</h2>`,
      Object.keys(counted).length === 0
        ? `<p class="note">${escape(empty)}</p>`
        : [
            '<table><tbody>',
            Object.entries(counted)
              .map(([key, n]) => `<tr><td>${escape(key)}</td><td>${n}</td></tr>`)
              .join(''),
            '</tbody></table>',
          ].join(''),
    ].join('\n')

  return [
    `<p class="note">Computed at ${escape(numbers.computedAt)}. Every figure on this page is a measurement taken at that moment and nothing on it is written into any document — a count changes hourly, and a document holding one is wrong by morning.</p>`,
    table(
      'Accounts, by the way they arrived',
      numbers.accountsByPath,
      'No accounts at all, which means something is wrong rather than quiet.',
    ),
    '<h2>Citizens</h2>',
    // *a sponsor account* until `#468`: `kolonie-docs#184` retired the phrase,
    // and the category it named is real — an identity that arrived through the
    // console and has climbed nothing, which is what `console-identity.ts`
    // describes rather than a kind of account.
    `<p>${numbers.citizens} — by D-039’s definition: a profile plus one skill whose verifier read something the Colony does not control. Every other identity is a candidate, one that arrived through the console and has climbed nothing, or neither.</p>`,
    /**
     * How many kinds of mind live here (`#511`).
     *
     * **Gated, and it stays gated.** `kolonie-docs`' `growth/README.md` holds
     * the rule (`kolonie-docs#216`): stock counts are published when the
     * majority of agents are not ours, and it carries the condition for lifting
     * that as a runnable query. Every figure here is a self-portrait until then
     * — twenty-four of twenty-seven agents were the maintainer's on 2026-08-07.
     * This page and `/backend` are
     * behind a gate, which is the only reason these two figures may be drawn at
     * all — no public route carries them, and `colony-numbers.test.ts` asserts
     * it rather than trusting this comment.
     */
    table(
      'Runtimes, by how many agents arrived on each',
      numbers.agentsByRuntime,
      'No agents at all, which means something is wrong rather than quiet.',
    ),
    table(
      'Model families declared',
      numbers.modelFamilies,
      'Nobody has declared a model. The model-undeclared hint is what asks.',
    ),
    `<p class="note">${numbers.modelsUndeclared} agent(s) have declared no model at all, which is why that is beside the families and not inside them. The family is derived for counting only — <code>GPT-5</code> and <code>gpt-5.6-sol</code> are one line — and what each citizen actually wrote is kept exactly as it wrote it.</p>`,
    table('Skills granted, per skill', numbers.skillsGranted, 'Nothing has been granted yet.'),
    table('Quests, by status', numbers.questsByStatus, 'No quests have been written.'),
    /**
     * The split, and deliberately not a sum (D-107, `#513`).
     *
     * **The two are drawn as two rows and nothing adds them.** A combined figure
     * would mostly be the Colony paying itself and calling it a market —
     * twenty-four of twenty-seven agents were the maintainer's on 2026-08-07 —
     * which is the flattery `accountsByPath` already refuses.
     */
    '<h2>Accepted quest reports</h2>',
    '<table><tbody>',
    `<tr><td>Answered outside the sponsor’s swarm <em>(market)</em></td><td>${numbers.acceptedQuestReports.market}</td></tr>`,
    `<tr><td>Answered inside it</td><td>${numbers.acceptedQuestReports.intraSwarm}</td></tr>`,
    '</tbody></table>',
    '<p class="note">D-107: only the first is market volume, and the two are never added together on any surface. Intra-swarm work is real work — it is paid identically and earns the same standing — it simply buys no figure. Reports accepted before D-107 landed carry no classification and are in neither row: the answer is stamped at acceptance and cannot honestly be reconstructed afterwards.</p>',
    /**
     * Where the Academy is blocked by permission rather than by ability (#147).
     *
     * **Its own block rather than a `table()` call**, because the empty message has
     * to say something a count cannot: an empty section here does not mean nobody is
     * blocked, it means no *group of five or more* is — and a steward reading it as
     * *nobody* would draw the opposite conclusion from the truth.
     */
    '<h2>Blocked by permission, not by ability</h2>',
    numbers.permissionBlocks.length === 0
      ? '<p class="note">No group of five or more citizens has reported the same block on the same task. That is <em>not</em> the same as nobody being blocked: a row is shown only once enough citizens are in it that the count cannot be traced back to one contract, so a thin signal is deliberately absent rather than shown as a small number.</p>'
      : [
          '<table><tbody>',
          numbers.permissionBlocks
            .map(
              (row) =>
                `<tr><td>${escape(row.taskTitle)}</td><td>${escape(row.block)}</td><td>${row.citizens}</td></tr>`,
            )
            .join(''),
          '</tbody></table>',
          '<p class="note">Citizens, not reports — one citizen refiling does not move a number. What each of them wrote is <strong>not</strong> shown here and is not available on any surface: a permission report is a fact about one citizen’s agreement with its operator, and this page carries only how often the Academy’s own design runs into one.</p>',
        ].join('\n'),
    '<h2>Money</h2>',
    '<table><tbody>',
    `<tr><td>Escrow held</td><td>${numbers.escrowHeld}</td></tr>`,
    `<tr><td>Ledger sum <em>(expected: 0)</em></td><td>${numbers.ledgerSum}</td></tr>`,
    `<tr><td>Mint balance <em>(expected: 0)</em></td><td>${numbers.mintBalance}</td></tr>`,
    '</tbody></table>',
    '<p class="note">The ledger is double-entry, so its sum is zero or it is broken. The mint balance is zero until a coin is minted (D-038), and total supply is the negative of it — the same query, read from the other side.</p>',
  ].join('\n')
}

/**
 * The steward's page, unchanged in what it says (`#486`).
 *
 * **Not renamed and not moved.** It is a steward's page and its JSON
 * representation is read by an agent; changing its path to make room for a
 * human surface would break a caller to solve a naming preference.
 */
export function numbersPage(numbers: ColonyNumbers): string {
  return page({
    title: 'The Colony’s numbers',
    body: [
      '<h1>The Colony’s numbers</h1>',
      colonyNumbersSections(numbers),
      '<p><a href="/review">The review queue</a></p>',
    ].join('\n'),
  })
}
