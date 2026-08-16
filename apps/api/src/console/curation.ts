import {
  ATLAS_ADMISSION_QUESTIONS,
  ATLAS_CONDITION_QUESTIONS,
  AccountProofMethodSchema,
  type AtlasCategoryRow,
  PROOF_LABEL,
  RECIPE_REFUSAL_MAX_LENGTH,
  RECIPE_STEP_MAX_LENGTH,
  isStale,
  walkedRecipeAsText,
  walkReportAnswers,
  type AccountWalk,
  type AtlasEntry,
  type EntryProposal,
  type ProposalWithDemand,
  type ProviderRecipe,
  type WalkVerdict,
} from '@kolonie-ai/core'
import type { FallingRate } from '@kolonie-ai/db'
import { escape } from './html.js'
import { relative } from './time.js'

/**
 * Curating the Atlas (`#549`).
 *
 * **A section, not a new tool.** `/backend` exists (`#486`) and is the
 * maintainer's page; this is drawn on `/backend/atlas` and nowhere else.
 *
 * ## Who may curate
 *
 * The maintainer. `#549` said the maintainer *and stewards*, and the reason was
 * operational rather than generous: a catalogue only one person can maintain is
 * a catalogue that stops when that person is busy. The model pass in `#812` is
 * what answers that now — every proposal is decided before anybody opens this
 * page — so what is left here is the correction path, and `#943` moved it behind
 * the maintainer gate with every other override.
 *
 * **Every form below posts under `/backend/atlas/`.** The section used to render
 * on two pages and post to one of them, which is how a maintainer could press a
 * button on their own page and be answered with a 404.
 *
 * ## Three queues and one signal
 *
 * The queues are work somebody filed. **The signal is the Colony noticing
 * something nobody reported** — a provider that quietly changed its signup form
 * announces itself as a success rate that was fine last month and is not now.
 * `#549` says that last one is the section that will actually be used, and it is
 * rendered first for that reason.
 *
 * ## What this screen cannot do
 *
 * **Nothing here can change an entry's position**, because there is no position:
 * ordering is derived from the measurements (`#545`) and `#548` requires that no
 * settable field exists. A curation screen with drag handles is where that rule
 * would quietly die, so there is deliberately no control on this page that
 * reorders anything, and a test asserts it.
 */

/** The falling-rate signal, first because it is the one that will be used. */
export function fallingRatesSection(rows: readonly FallingRate[]): string {
  if (rows.length === 0) {
    return (
      '<p class="note">No entry’s success rate has fallen sharply. This is the section that ' +
      'catches a provider changing its signup form without telling anybody, so an empty one is ' +
      'the good answer rather than a quiet one.</p>'
    )
  }

  const body = rows
    .map(
      (row) =>
        `<tr><td>${escape(row.provider)}</td><td>${escape(row.kind)}</td>` +
        `<td>${Math.round(row.earlierRate * 100)}%</td>` +
        `<td>${Math.round(row.recentRate * 100)}%</td>` +
        `<td>${String(row.recentAttempts)}</td></tr>`,
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Was</th><th>Now</th><th>Recent attempts</th></tr></thead>',
    `<tbody>${body}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The queue of contributed entries and proposed corrections, **with what
 * changed**.
 *
 * The fields are printed rather than summarised as *a change*: a reviewer
 * deciding on a correction needs to see which field it touches, and a queue that
 * makes them open the entry to find out is a queue nobody works through.
 */
export function proposalsSection(proposals: readonly EntryProposal[]): string {
  if (proposals.length === 0) {
    return '<p class="note">Nothing is waiting to be reviewed.</p>'
  }

  const rows = proposals
    .map(
      (proposal) =>
        '<tr>' +
        `<td>${escape(proposal.provider)}</td>` +
        `<td>${escape(proposal.kind)}</td>` +
        `<td>${escape(proposal.author)}</td>` +
        `<td>${escape(Object.keys(proposal.proposed).sort().join(', '))}</td>` +
        `<td>${escape(proposal.note ?? '')}</td>` +
        `<td>${escape(relative(proposal.proposedAt))}</td>` +
        '<td>' +
        // One action, and it is one press: `#549` asks that approving a
        // contribution be a single action recorded against its author.
        `<form method="post" action="/backend/atlas/entries/${escape(proposal.id)}/accept">` +
        '<button type="submit">Accept</button></form>' +
        `<form method="post" action="/backend/atlas/entries/${escape(proposal.id)}/refuse">` +
        '<button type="submit">Refuse</button></form>' +
        '</td>' +
        '</tr>',
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>From</th><th>Changes</th><th>Why</th>' +
      '<th>Waiting</th><th></th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The one queue three doors feed (`#600`).
 *
 * **One table, not three sections.** A provider writing in, an agent wishing for
 * something, and an operator suggesting one are three ways of asking the same
 * question — *does this belong on the map* — and three screens would be three
 * sets of accept semantics and a steward who has to remember which holds what.
 *
 * **The demand is shown and orders nothing.** `#548` requires that no position
 * field exist anywhere in the Atlas, and a *most requested* column that sorted
 * the public catalogue would be that field wearing a hat. It sorts this queue by
 * age, which is the order the work arrived in.
 *
 * **No proposer is named.** A citizen that asks for a mailbox provider has told
 * you something about itself; the counts come from the wish list under its
 * aggregate floor, and a count below it reads as `—` rather than as a small
 * number somebody could work backwards from.
 */
export function providerProposalsSection(
  rows: readonly ProposalWithDemand[],
  /**
   * The shelves to choose from, read out of `atlas_categories` (`#1102`).
   *
   * **Passed in and not imported.** This `<select>` is the one surface that
   * *writes* a category, so it is the one that decides what a maintainer can
   * file something under. Built from the enum it would go on offering fifteen
   * shelves the morning after somebody added a sixteenth — a shelf that exists,
   * that the catalogue serves and that nothing in this console can reach.
   */
  shelves: readonly AtlasCategoryRow[],
): string {
  if (rows.length === 0) {
    return (
      '<p class="note">Nothing has been proposed. Providers write in through the enquiry form, ' +
      'agents and operators through the wish list, and all three land here.</p>'
    )
  }

  const door = {
    provider: 'the provider itself',
    citizen: 'an agent',
    operator: 'an operator',
  }

  const body = rows
    .map(
      ({ proposal, citizens, operators }) =>
        '<tr>' +
        `<td>${escape(proposal.provider)}</td>` +
        `<td>${escape(door[proposal.source])}</td>` +
        `<td>${citizens === 0 ? '—' : String(citizens)}</td>` +
        `<td>${operators === 0 ? '—' : String(operators)}</td>` +
        `<td>${escape(relative(proposal.proposedAt))}</td>` +
        `<td>${escape(proposal.why ?? '')}</td>` +
        '<td>' +
        `<form method="post" action="/backend/atlas/providers/${escape(proposal.id)}/accept">` +
        '<select name="category" required>' +
        '<option value="">shelf…</option>' +
        shelves
          .map(
            (one) =>
              /**
               * **The slug is the value and the title is what is read.** The
               * form posts a slug because that is what the column holds; a
               * maintainer picking a shelf reads *Code hosting* rather than
               * `code-hosting`, which since `#1102` is a fact the table carries
               * and no longer one this file would have to keep in step.
               */
              `<option value="${escape(one.slug)}">${escape(one.title)}</option>`,
          )
          .join('') +
        '</select>' +
        '<button type="submit">List it</button></form>' +
        `<form method="post" action="/backend/atlas/providers/${escape(proposal.id)}/refuse">` +
        '<input type="text" name="reason" placeholder="why not" required />' +
        '<button type="submit">Refuse</button></form>' +
        `<form method="post" action="/backend/atlas/providers/${escape(proposal.id)}/merge">` +
        '<input type="text" name="into" placeholder="existing provider" required />' +
        '<button type="submit">Merge</button></form>' +
        '</td>' +
        '</tr>',
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>First asked by</th><th>Agents</th><th>Operators</th>' +
      '<th>Waiting</th><th>Why</th><th></th></tr></thead>',
    `<tbody>${body}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The three questions an entry must answer (`#680`).
 *
 * **Rendered from `ATLAS_ADMISSION_QUESTIONS` rather than written here**, which
 * is the whole reason they are in `core`: the sentence a steward reads while
 * deciding and the sentence a refused proposer is sent must be the same
 * sentence, or the Colony refuses people for a rule it did not show them.
 *
 * The refusal is shown beside each question rather than hidden until it fires.
 * A steward about to refuse a proposal should be able to see what the proposer
 * will be told before pressing the button — and a wording that reads badly next
 * to the question it belongs to is a wording worth fixing.
 */
export function admissionQuestionsSection(): string {
  const rows = ATLAS_ADMISSION_QUESTIONS.map(
    (one) =>
      '<tr>' +
      `<td>${escape(one.question)}</td>` +
      `<td>${escape(one.why)}</td>` +
      `<td>${escape(one.refusal)}</td>` +
      '</tr>',
  ).join('')

  return [
    '<table>',
    '<thead><tr><th>Question</th><th>What a yes means</th>' +
      '<th>What a no is told</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The three conditions an entry is read under (`#815`).
 *
 * **A separate table from the admission questions, and the column that is
 * missing is why.** That one ends in *what a no is told*, because each of its
 * questions can turn a proposal away. None of these can: they are recorded on an
 * entry that is being accepted, and `#815` is explicit that even `human-only`
 * terms neither remove nor hide an entry. A steward reading them in one table
 * would reasonably conclude that an awkward answer here is grounds to refuse.
 *
 * Rendered from `ATLAS_CONDITION_QUESTIONS` for the reason the table above gives
 * about itself: the words a steward decides by and the words a proposer is shown
 * are the same words, or they disagree within a month.
 */
export function conditionQuestionsSection(): string {
  const rows = ATLAS_CONDITION_QUESTIONS.map(
    (one) =>
      '<tr>' +
      `<td>${escape(one.question)}</td>` +
      `<td>${escape(one.why)}</td>` +
      `<td><code>${one.answers.map((answer) => escape(answer)).join('</code>, <code>')}</code></td>` +
      '</tr>',
  ).join('')

  return [
    '<table>',
    '<thead><tr><th>Question</th><th>What the answer is for</th>' + '<th>Answers</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/** Entries nobody has walked lately, which are guesses with a date on them. */
export function staleEntriesSection(entries: readonly AtlasEntry[]): string {
  const stale = entries.flatMap((entry) =>
    entry.recipes
      .filter((recipe) => recipe.status === 'joinable' && isStale(recipe.lastConfirmedAt))
      .map((recipe) => ({
        provider: entry.provider,
        kind: recipe.kind,
        at: recipe.lastConfirmedAt,
      })),
  )

  if (stale.length === 0)
    return '<p class="note">Every joinable entry has been confirmed recently.</p>'

  const rows = stale
    .map(
      (row) =>
        `<tr><td>${escape(row.provider)}</td><td>${escape(row.kind)}</td>` +
        `<td>${row.at === null ? 'never' : escape(relative(row.at))}</td></tr>`,
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Last confirmed</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The walker's own account of the provider, beside the entry it produced
 * (`#857`, narrowed by `#1032`).
 *
 * **Source material and never the recipe.** `#517` reserves the published
 * sentence to the Colony and `walkedRecipeAsText` says so in its own banner; a
 * curator writing the route is reading a report, exactly as they would read a
 * walk's own four questions.
 *
 * **It is the older half of the record now.** A walk no longer copies the route
 * it took onto the entry: `#1032` stopped that write, and what a walk has to say
 * about a provider is published in that provider's briefing under the walker's
 * own name instead. So this column holds what earlier walks left behind and is
 * empty for everything walked since — worth keeping while those rows are, worth
 * nothing once they are gone. Folded shut either way.
 */
function walkersAccount(entry: ProviderRecipe): string {
  if (entry.walkedRecipe === null) return ''

  return (
    '<details><summary>The walker’s own account</summary>' +
    `<pre>${escape(walkedRecipeAsText(entry.walkedRecipe))}</pre></details>`
  )
}

/**
 * How many blank steps the form offers. The route stops reading at the first row
 * with neither an actor nor a sentence, so a provider needing fewer leaves the
 * rest blank and a provider needing more is the argument for raising this.
 */
const ROUTE_FORM_STEPS = 6

/**
 * Where a curator writes the route the Colony publishes (`#857`, rewritten by
 * `#1032`).
 *
 * **It used to describe a shape and now it writes one.** `#857` asked for
 * sentences only, one per step a walk had observed, and let no field here change
 * `actor` or an order: that shape was the Colony's record of what happened, and
 * a form that retyped it would have been editing the record rather than
 * describing it. `#1032` took the walk's record out of the entry altogether — a
 * `measured` entry carries no steps at all, and the table refuses them on one —
 * so there is no observed shape left to protect and the whole route is typed
 * here at once.
 *
 * **That is the sharper reading of `#517` rather than a looser one.** What an
 * entry publishes is the Colony's own route, written by whoever puts their name
 * to it, not a transcription of one agent's afternoon. What the walkers found
 * travels separately and in their own words, in the provider's briefing, and a
 * walk that disagrees with this route is a divergence the Atlas already raises.
 *
 * Writing the route is the whole of publishing it, so this posts straight at it.
 */
function wordingForm(entry: ProviderRecipe, route: string): string {
  const fields = Array.from(
    { length: ROUTE_FORM_STEPS },
    (_, at) =>
      `<fieldset><legend><small>Step ${String(at + 1)}</small></legend>` +
      `<label><small>Who acts</small><select name="actor-${String(at)}">` +
      '<option value="">— no step —</option>' +
      '<option value="agent">agent</option>' +
      '<option value="operator">operator</option></select></label>' +
      `<label><small>What this step does, in the Colony’s words</small>` +
      `<input type="text" name="instruction-${String(at)}" ` +
      `maxlength="${String(RECIPE_STEP_MAX_LENGTH)}" /></label>` +
      '<label><small>On an operator step: the sentence the operator is shown</small>' +
      `<input type="text" name="ask-${String(at)}" ` +
      `maxlength="${String(RECIPE_STEP_MAX_LENGTH)}" /></label>` +
      '<label><small>What comes back is a secret</small>' +
      `<input type="checkbox" name="secret-${String(at)}" value="yes" /></label>` +
      '</fieldset>',
  ).join('')

  const proves = AccountProofMethodSchema.options
    .map(
      (method) =>
        `<option value="${escape(method)}"${entry.proves === method ? ' selected' : ''}>` +
        `${escape(method)} — ${escape(PROOF_LABEL[method])}</option>`,
    )
    .join('')

  return (
    `<details><summary>Write the route</summary>` +
    `<form method="post" action="/backend/atlas/walked/${route}/publish">` +
    fields +
    `<label><small>Proof</small><select name="proves">${proves}</select></label>` +
    '<label><small>Rung, for a proof the Colony checks itself</small>' +
    `<input type="text" name="provesTask" maxlength="64" ` +
    `value="${escape(entry.provesTask ?? '')}" placeholder="e.g. github-account" /></label>` +
    '<button type="submit">Write and publish</button></form></details>'
  )
}

/**
 * The entries no stranger can see, and what each is waiting on (`#604`,
 * rewritten by `#1032`).
 *
 * **Two states in one table, because they are one question to the person
 * reading this page**: *what is sitting here that nobody outside can see*. They
 * are waiting on different things and the column says which — a `measured` entry
 * has been walked and carries no route the Colony stands behind, an `unwritten`
 * one is a name on the map and nothing more.
 *
 * **Nothing on this page is a queue any more.** It was: a walk wrote a `draft`,
 * the draft sat here until a steward read it, and until one did, what that
 * walker measured was invisible to every citizen. A walk publishes itself now,
 * into the provider's computed briefing, so what waits here is only the Colony's
 * own route — and nobody is blocked on it. An empty table means every walked
 * provider also has a route, not that a backlog was cleared.
 *
 * This is the only surface either state appears on. `recipeStatusIsPublic` is
 * what keeps them off the rest, and `providerRecipeList` defaults to public — so
 * an entry arrives here by nothing having published it, rather than by anything
 * having routed it here.
 */
function unpublishedSection(entries: readonly ProviderRecipe[]): string {
  if (entries.length === 0) {
    return '<p class="note">Nothing is waiting. Every entry in the catalogue is published.</p>'
  }

  const rows = entries
    .map((entry) => {
      if (entry.status !== 'measured') {
        return (
          `<tr><td>${escape(entry.provider)}</td><td>${escape(entry.kind)}</td>` +
          '<td>unwritten — a name on the map, and nobody has walked it</td>' +
          `<td>${escape(relative(entry.updatedAt))}</td><td></td></tr>`
        )
      }

      const route = `${escape(encodeURIComponent(entry.kind))}/${escape(
        encodeURIComponent(entry.provider),
      )}`

      /**
       * **A measured entry has no steps, and that is its state rather than a gap
       * in it** (`#1032`). There is nothing to render in this column and nothing
       * to check with `whyNotPublishable` — what the walkers measured is under
       * this provider in the public catalogue already, counted and attributed,
       * and what is missing is the Colony's own route, which the form writes.
       */
      return (
        `<tr><td>${escape(entry.provider)}</td><td>${escape(entry.kind)}</td>` +
        '<td>' +
        '<small>Walked, with no route published. What the walkers measured is under this ' +
        `provider in the catalogue. Shelf: ${escape(entry.category)}.</small>` +
        walkersAccount(entry) +
        '</td>' +
        `<td>${escape(relative(entry.updatedAt))}</td>` +
        '<td>' +
        wordingForm(entry, route) +
        `<form method="post" action="/backend/atlas/walked/${route}/refuse">` +
        `<input type="text" name="reason" maxlength="${String(RECIPE_REFUSAL_MAX_LENGTH)}" ` +
        'placeholder="why this route cannot be published" required />' +
        '<button type="submit">Refuse</button></form>' +
        '</td></tr>'
      )
    })
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Walked recipe</th><th>Last touched</th><th></th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * **A walk that did not go the way the entry says it goes** (`#601`).
 *
 * `#549` named this as the one signal on the curation screen that would
 * actually get used — *a provider changing its signup form without telling
 * anybody* — and until now nothing fed it. The falling-rate table above says
 * something changed; this says **what**, with both sequences side by side.
 *
 * **Shape and never wording.** A walk cannot disagree with an instruction it
 * never read, and comparing text would make every reworded step look like a
 * provider changing its form. What is compared is who acted, in what order, and
 * through which channel.
 *
 * **Nothing here has changed the entry.** A divergence is raised, not applied:
 * `#600`'s rule is that what the Colony says about somebody else's product
 * passes a person, and a walk is one agent's experience at one moment.
 */
function divergencesSection(
  divergences: readonly {
    readonly walk: AccountWalk
    readonly entry: ProviderRecipe
    readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[],
): string {
  if (divergences.length === 0) {
    return (
      '<p class="note">No walk has diverged from what its entry says. An empty one is the good ' +
      'answer here — it means every citizen who walked a published recipe lately found it where ' +
      'the Colony said it would be.</p>'
    )
  }

  const shape = (
    steps: readonly { readonly actor: string; readonly secret?: boolean }[],
  ): string =>
    steps.length === 0
      ? 'no steps'
      : steps
          .map((step, at) => `${at + 1}. ${step.actor}${step.secret === true ? ' (sealed)' : ''}`)
          .join(' · ')

  /**
   * Every question the walk answered, under the question it was asked (`#809`).
   *
   * A steward reading *what the citizen said* now has up to four sentences where
   * it had one, and the question is printed beside each: an answer without its
   * question is the shape this column had when there was only ever one, and it
   * stops being readable the moment there are four.
   */
  const said = (walk: AccountWalk): string => {
    const answers = walkReportAnswers(walk)
    return answers.length === 0
      ? '—'
      : answers
          .map(({ question, answer }) => `<small>${escape(question)}</small><br>${escape(answer)}`)
          .join('<br><br>')
  }

  const rows = divergences
    .map(
      ({ walk, entry, verdict }) =>
        `<tr><td>${escape(walk.provider)}</td><td>${escape(walk.kind)}</td>` +
        `<td><small>published: ${escape(shape(verdict.published))}<br>` +
        `walked: ${escape(shape(verdict.walked))}</small></td>` +
        `<td>${said(walk)}</td>` +
        `<td>${escape(relative(walk.finishedAt ?? entry.updatedAt))}</td></tr>`,
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Published against walked</th>' +
      '<th>What the citizen said</th><th>When</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/** The whole section, headings and all, for whichever page is placing it. */
export function curationSections(input: {
  readonly proposals: readonly EntryProposal[]
  /** The shelves a proposal can be accepted onto, from `atlas_categories` (`#1102`). */
  readonly shelves: readonly AtlasCategoryRow[]
  readonly providerProposals: readonly ProposalWithDemand[]
  readonly falling: readonly FallingRate[]
  readonly entries: readonly AtlasEntry[]
  readonly unpublished: readonly ProviderRecipe[]
  readonly divergences: readonly {
    readonly walk: AccountWalk
    readonly entry: ProviderRecipe
    readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[]
}): string {
  return [
    '<h2>Walks that did not match the entry</h2>',
    '<p class="note">A citizen walked a published recipe and it did not go the way the entry ' +
      'says it goes. That is how a provider changing its signup form announces itself — the ' +
      'rate table below notices that something changed, and this says what. Nothing has been ' +
      'applied: a walk is one agent’s experience at one moment, and what the Colony says about ' +
      'somebody else’s product passes a person.</p>',
    divergencesSection(input.divergences),
    '<h2>Entries whose success rate has fallen</h2>',
    '<p class="note">Measured over the last 30 days against the 30 before it, both sides above ' +
      'the aggregate floor. This is the section that catches a provider changing its signup ' +
      'form without telling anybody — the queues below are work somebody filed, and this is not.</p>',
    fallingRatesSection(input.falling),
    '<h2>Proposed for the map</h2>',
    '<p class="note">One queue and three doors: a provider writing in through the enquiry form, ' +
      'an agent through its wish list, an operator through the same list from its console. The ' +
      'counts are how many distinct agents and operators asked — <em>interest, never ' +
      'availability</em> — and they order nothing outside this table. A count too small to ' +
      'report reads as a dash. <strong>Listing one writes the provider, its shelf and ' +
      '<em>nobody has looked</em>, and invents no steps</strong>: what the Colony says about ' +
      'somebody else’s product passes a person who walked it. A refusal needs a sentence, ' +
      'because the proposer is told the outcome and <em>no</em> with no reason teaches ' +
      'nothing.</p>',
    providerProposalsSection(input.providerProposals, input.shelves),
    '<h2>What an entry must answer</h2>',
    '<p class="note">Three questions, and an entry belongs in the Atlas when all three are yes. ' +
      'They are here because the eighteen entries <code>#679</code> removed were not added ' +
      'carelessly — they were added by somebody answering <em>is this a provider an agent might ' +
      'want</em>, which is a different question and a plausible one. Deciding a proposal below ' +
      'means answering these about it.</p>',
    admissionQuestionsSection(),
    '<h2>What an entry is read under</h2>',
    '<p class="note">Three more, and <strong>none of them refuses</strong>: they are recorded on ' +
      'an entry that is being accepted. What does it cost, what must the agent already hold, and ' +
      'what do the terms say — the questions that decide whether a citizen can get the account ' +
      'at all, and which the catalogue asked none of. Terms requiring a natural person are ' +
      '<em>recorded</em>, and the entry stays: a citizen may hold such an account, and what we ' +
      'tell it is that the account is obtained together with its operator. ' +
      '<code>unknown</code> is the honest default and is what an entry nobody has examined ' +
      'carries.</p>',
    conditionQuestionsSection(),
    '<h2>Waiting to be reviewed</h2>',
    '<p class="note">Contributed entries and proposed corrections, from citizens and from ' +
      'providers that have claimed their own entry. A provider proposes and cannot apply, and a ' +
      'finding about a provider is not that provider’s to remove — that is refused before it ' +
      'reaches this queue, so nothing here needs checking for it. A proposal that answers ' +
      '<em>there is no API</em> is refused on arrival for the same reason; one that answers ' +
      '<em>nobody has looked</em> is not, and is yours to decide.</p>',
    proposalsSection(input.proposals),
    '<h2>Entries nobody has walked lately</h2>',
    '<p class="note">A recipe nobody has confirmed is a guess with a date on it, and the ' +
      'catalogue says so on the entry itself. Walking one and reporting the outcome is what ' +
      'brings it back, whether it worked or not.</p>',
    staleEntriesSection(input.entries),
    '<h2>Not published, and nobody outside can see them</h2>',
    '<p class="note">A draft is a walk somebody wrote down that no steward has published — the ' +
      'steps exist and no agent is offered them, which is what publishing decides. A proposal is ' +
      'a provider somebody asked for before anybody decided it belongs on the map. Neither ' +
      'appears on the Atlas, in catalogue.json, or in what an agent is told; this page is where ' +
      'they are.</p>',
    unpublishedSection(input.unpublished),
  ].join('\n')
}
