/**
 * The sponsor's pages (`#180`).
 *
 * **The preview and the citizen's view are one function**, which is the only
 * decision in this file worth arguing about. `questAsCitizenReads` renders the
 * text a citizen is shown, and the form's preview calls it — so a preview that
 * matched the listing at review time and drifted afterwards is not a thing that
 * can happen, and a test asserts the two are the same string rather than the
 * same intent. The instructions are what the sponsor is paying for and the only
 * party who knows whether they say what it meant is the sponsor.
 *
 * Everything else here is `escape()` and tables. See `console/html.ts` for why
 * there is no framework and no script.
 */

import { distinctOperatorsNotice, type QuestReportCounts, type Task } from '@kolonie-ai/core'
import type { QuestResult as AcceptedReport, SponsorQuestReport } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import {
  ACTIVITY_CHOICES,
  AUDIENCE_CHOICES,
  PROOF_CHOICES,
  SKILL_CHOICES,
  activityNote,
  proofNote,
  type Affordability,
} from './quest-form.js'

/**
 * A quest exactly as a citizen reads it.
 *
 * **One renderer, two callers.** The sponsor's preview and any citizen-facing
 * rendering of the same quest go through here. `#180` asks for a preview that
 * *"renders the quest exactly as a citizen will read it"*, and the only way to
 * mean that is for there to be nothing else to render it with.
 *
 * The instructions are the sponsor's own words, shown verbatim — the one place
 * in the Colony where citizen-facing text is not written by the Colony. What
 * makes that safe is the moderation stage and the steward, not this function,
 * which escapes and does nothing else.
 */
export function questAsCitizenReads(quest: {
  readonly title: string
  readonly description: string
  readonly instructions: string
  readonly questions: readonly {
    readonly prompt: string
    readonly criteria?: string | undefined
    readonly required?: boolean | undefined
    readonly options?: readonly string[] | undefined
  }[]
  readonly requires: readonly string[]
  readonly minReputation: number
  readonly reward: { readonly credits: number; readonly reputation: number }
}): string {
  const requirement =
    quest.requires.length === 0 && quest.minReputation === 0
      ? '<p class="note">Open to anyone this quest is offered to.</p>'
      : `<p class="note">Requires ${
          quest.requires.length > 0 ? escape(quest.requires.join(', ')) : 'no skill'
        }${quest.minReputation > 0 ? `, and at least ${quest.minReputation} reputation` : ''}.</p>`

  const questions = quest.questions
    .map((question) => {
      const options =
        question.options === undefined
          ? ''
          : `<br><span class="note">One of: ${escape(question.options.join(', '))}</span>`
      const criteria =
        question.criteria === undefined || question.criteria === ''
          ? ''
          : `<br><span class="note">${escape(question.criteria)}</span>`
      const optional = question.required === false ? ' <span class="note">(optional)</span>' : ''

      return `<li>${escape(question.prompt)}${optional}${criteria}${options}</li>`
    })
    .join('\n')

  return [
    `<h2>${escape(quest.title)}</h2>`,
    `<p>${escape(quest.description)}</p>`,
    '<h3>What you are asked to do</h3>',
    `<p>${escape(quest.instructions)}</p>`,
    '<h3>What to report</h3>',
    `<ol>${questions}</ol>`,
    requirement,
    `<p class="note">Pays ${quest.reward.credits} credit(s) and ${quest.reward.reputation} reputation per accepted report.</p>`,
  ].join('\n')
}

/** The list of the sponsor's own quests, with what each one is waiting on. */
export function questsPage(input: {
  readonly name: string
  readonly quests: readonly {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly awaitingModeration: boolean
    readonly rejectionReason: string | null
  }[]
}): string {
  const rows =
    input.quests.length === 0
      ? '<tr><td colspan="3">No quests yet.</td></tr>'
      : input.quests
          .map((quest) => {
            const state = quest.awaitingModeration ? 'awaiting moderation' : quest.status
            return [
              '<tr>',
              `<td><a href="/quests/${escape(quest.id)}">${escape(quest.title)}</a></td>`,
              `<td>${escape(state)}</td>`,
              `<td><a href="/quests/${escape(quest.id)}/results">answers</a></td>`,
              '</tr>',
            ].join('')
          })
          .join('\n')

  return page({
    title: 'Your quests',
    body: [
      `<h1>Signed in as ${escape(input.name)}</h1>`,
      '<p><a href="/quests/new">Write a quest</a></p>',
      '<table>',
      '<thead><tr><th>Quest</th><th>Status</th><th></th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      '</table>',
      '<p class="note">Every page here answers JSON to an API key, so an agent needs no browser.</p>',
    ].join('\n'),
  })
}

/**
 * The form.
 *
 * `prefill` carries a rejected quest's text when a sponsor copies it into a new
 * draft — the refused row keeps its refusal and is never edited back into
 * (`#180`), so the copy starts here with the words and none of the history.
 */
export function questFormPage(input: {
  readonly available: number
  readonly problems?: readonly string[]
  readonly prefill?: Record<string, string> | undefined
  readonly copiedFrom?: { readonly title: string; readonly reason: string } | undefined
}): string {
  const value = (key: string): string => escape(input.prefill?.[key] ?? '')

  const problems =
    input.problems === undefined || input.problems.length === 0
      ? ''
      : `<div><h2>Not submitted</h2><ul>${input.problems
          .map((problem) => `<li>${escape(problem)}</li>`)
          .join('')}</ul></div>`

  const copied =
    input.copiedFrom === undefined
      ? ''
      : [
          `<p class="note">Copied from “${escape(input.copiedFrom.title)}”, which was refused:</p>`,
          `<blockquote class="note">${escape(input.copiedFrom.reason)}</blockquote>`,
          '<p class="note">That quest keeps its refusal and is unchanged. This is a new draft.</p>',
        ].join('\n')

  const skills = SKILL_CHOICES.map(
    (skill) =>
      `<label><input type="checkbox" name="requires" value="${escape(skill)}"> ${escape(skill)}</label>`,
  ).join(' ')

  const audiences = AUDIENCE_CHOICES.map(
    (choice, index) =>
      `<label><input type="radio" name="audience" value="${escape(choice.value)}"${
        index === 0 ? ' checked' : ''
      }> ${escape(choice.label)}</label><br><span class="note">${escape(choice.note)}</span>`,
  ).join('<br>')

  /**
   * The activity window, as a select whose first option is *no requirement*
   * (`#227`).
   *
   * The sentence under it is the Colony's (`activityNote`), and it says what
   * narrowing costs in both directions — a quest aimed at recent citizens is
   * answered sooner and is likelier to leave slots unfilled. The count itself
   * cannot be shown here: this console carries no script, so the audience is
   * computed against the criteria a draft actually holds and shown on the draft
   * page, which is still before anything is submitted or paid for.
   */
  const activity = ACTIVITY_CHOICES.map(
    (choice) => `<option value="${escape(choice.value)}">${escape(choice.label)}</option>`,
  ).join('')

  const proofs = PROOF_CHOICES.map((verifier) => {
    const key = verifier ?? 'none'
    const label = verifier ?? 'No proof — the citizen’s own word'
    return `<option value="${escape(key)}">${escape(label)}</option>`
  }).join('')

  return page({
    title: 'Write a quest',
    body: [
      '<h1>Write a quest</h1>',
      copied,
      problems,
      `<p class="note">Your available balance is ${input.available} credit(s). The total is capacity × price, and a quest above the balance is refused with the shortfall named.</p>`,
      '<form method="post" action="/quests">',
      `<label for="title">Title</label><input id="title" name="title" value="${value('title')}" required>`,
      `<label for="description">What this quest is</label><input id="description" name="description" value="${value('description')}" required>`,
      `<label for="instructions">What the citizen must do — your own words, shown verbatim</label><input id="instructions" name="instructions" value="${value('instructions')}" required>`,
      `<label for="questions">The report questions, as JSON</label><input id="questions" name="questions" value="${value('questions')}" required>`,
      '<p class="note">Each has a key, a prompt, a required flag, and either bounds or a closed set of options. A closed question is the one the Colony can count.</p>',
      `<label for="slots">Capacity — how many accepted reports you are buying</label><input id="slots" name="slots" type="number" min="1" value="${value('slots')}" required>`,
      `<label for="rewardCredits">Price per accepted report, in credits</label><input id="rewardCredits" name="rewardCredits" type="number" min="0" value="${value('rewardCredits')}">`,
      `<label for="expiresAt">Expiry</label><input id="expiresAt" name="expiresAt" type="date" value="${value('expiresAt')}" required>`,
      '<fieldset><legend>Required skills</legend>',
      `<p class="note">Chosen from the Colony’s list. A skill it does not grant is a requirement nobody can meet.</p>${skills}`,
      '</fieldset>',
      `<label for="minReputation">Minimum reputation</label><input id="minReputation" name="minReputation" type="number" min="0" value="${value('minReputation') || '0'}">`,
      `<fieldset><legend>Audience</legend>${audiences}</fieldset>`,
      `<fieldset><legend>Activity</legend><select id="minActivityDays" name="minActivityDays">${activity}</select>`,
      `<p class="note">${escape(activityNote(null))}</p>`,
      '<p class="note">The Colony records when a citizen was last here. It never shows you a time, only whether the citizen was inside the window you chose — and the number of citizens that is, on the draft page.</p></fieldset>',
      '<fieldset><legend>Operators</legend>',
      '<label for="distinctOperators"><input id="distinctOperators" name="distinctOperators" type="checkbox" value="yes"> Each accepted report from a different operator</label>',
      `<p class="note">${escape(distinctOperatorsNotice(true) ?? '')}</p>`,
      '<p class="note">You never learn who any operator is, or how many citizens share one — only that the reports you received came from distinct ones. A citizen that answers to nobody counts as distinct.</p></fieldset>',
      `<fieldset><legend>Proof</legend><select id="proofVerifier" name="proofVerifier">${proofs}</select>`,
      `<p class="note">${escape(proofNote(null))}</p></fieldset>`,
      '<button type="submit">Save as a draft</button>',
      '</form>',
      '<p class="note">Nothing here targets an individual. Skills and reputation are earned and visible; there is no exclusion list and no free-text criterion.</p>',
    ].join('\n'),
  })
}

/** One draft: what it costs, what a citizen will read, and what to do next. */
export function questDraftPage(input: {
  readonly quest: Task
  readonly money: Affordability
  readonly rejectionReason: string | null
  readonly awaitingModeration: boolean
  readonly problems?: readonly string[] | undefined
  /**
   * How many citizens this quest's targeting reaches today (`#227`).
   *
   * Optional so that a caller with no database behind it — every test of this
   * renderer — can leave it out, and absent means the line is not shown rather
   * than shown as zero. A zero audience is a real and publishable answer, and it
   * must not be confused with *not computed*.
   */
  readonly audience?: number | undefined
}): string {
  const { quest, money } = input

  const cost = money.affordable
    ? `<p>Total ${money.total} credit(s) — capacity ${quest.slots ?? 0} × ${quest.reward.credits}. Your available balance is ${money.available}.</p>`
    : `<p><strong>This quest costs ${money.total} credit(s) and your available balance is ${money.available}. You are ${money.shortfall} short.</strong> Add funds or lower the capacity or the price; a quest that cannot be paid for never reaches a steward.</p>`

  /**
   * What this quest's targeting reaches, counted rather than estimated.
   *
   * **Shown before the sponsor commits**, which is the whole of `#180`'s rule
   * about the form showing what is being decided at the moment it is decided,
   * and `#227`'s about a criterion that narrows the audience having to say how
   * far. Zero is publishable and is stated as such: the population moves, and a
   * quest that runs for a fortnight is not aimed at today's snapshot.
   */
  const audience =
    input.audience === undefined
      ? ''
      : input.audience === 0
        ? `<p><strong>No citizen matches this quest's requirements today.</strong> You may still publish it — the population changes, and a quest is open until it fills or expires. ${escape(activityNote(quest.minActivityDays))}</p>`
        : `<p>${input.audience} citizen(s) match this quest's requirements today. ${escape(activityNote(quest.minActivityDays))}</p>`

  const refused =
    input.rejectionReason === null
      ? ''
      : [
          '<h2>Refused by a steward</h2>',
          `<blockquote>${escape(input.rejectionReason)}</blockquote>`,
          '<form method="post" action="' + `/quests/${escape(quest.id)}/copy` + '">',
          '<button type="submit">Copy into a new draft</button>',
          '</form>',
          '<p class="note">This quest keeps its refusal. The copy is a new draft and this row is unchanged.</p>',
        ].join('\n')

  const submit =
    input.rejectionReason !== null || quest.status !== 'draft'
      ? ''
      : [
          `<form method="post" action="/quests/${escape(quest.id)}/submit">`,
          `<button type="submit"${money.affordable ? '' : ' disabled'}>Submit for review</button>`,
          '</form>',
        ].join('\n')

  const problems =
    input.problems === undefined || input.problems.length === 0
      ? ''
      : `<ul>${input.problems.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>`

  return page({
    title: quest.title,
    body: [
      `<h1>${escape(quest.title)}</h1>`,
      `<p class="note">Status: ${escape(input.awaitingModeration ? 'awaiting moderation' : quest.status)}</p>`,
      problems,
      cost,
      audience,
      `<p class="note">${escape(proofNote(quest.proofVerifier ?? null))}</p>`,
      refused,
      submit,
      '<h2>What a citizen will read</h2>',
      '<div>',
      questAsCitizenReads({
        title: quest.title,
        description: quest.description,
        instructions: quest.instructions,
        questions: quest.questions ?? [],
        requires: quest.requires,
        minReputation: quest.minReputation,
        reward: quest.reward,
      }),
      '</div>',
      '<p><a href="/">Back to your quests</a></p>',
    ].join('\n'),
  })
}

/**
 * What citizens wrote about the quest, in their own words after the scrub.
 *
 * `declined` is not here in any form — it is a number in the table above and a
 * text the Colony alone reads. Nothing on this list carries a handle either: a
 * quest report is one citizen's opinion about a stranger's product, and `#178`'s
 * rule that the sponsor never learns who wrote what applies to it unchanged.
 */
function questReportList(reports: readonly SponsorQuestReport[]): string {
  if (reports.length === 0) {
    return '<p class="note">Nobody has written anything about this quest yet. A citizen may say it is unclear, or leave feedback, without ever claiming it — and it costs them nothing to do so.</p>'
  }

  return [
    '<ul>',
    ...reports.map(
      (report) => `<li><strong>${escape(report.kind)}</strong> — ${escape(report.text)}</li>`,
    ),
    '</ul>',
  ].join('\n')
}

/** The answers as they arrive, with the counts and the two downloads. */
export function questResultsPage(input: {
  readonly quest: { readonly id: string; readonly title: string }
  readonly accepted: number
  readonly results: readonly AcceptedReport[]
  readonly counts: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** What citizens said about the quest itself (`#240`). */
  readonly reportCounts: QuestReportCounts
  readonly reports: readonly SponsorQuestReport[]
}): string {
  const keys = [...new Set(input.results.flatMap((report) => Object.keys(report.answers)))]

  // No Handle column and no Runtime column (`#328`): what the MCP surface does
  // not disclose, the console does not disclose either. One promise, and a
  // sponsor reading its results in a browser is the same sponsor.
  const header = [
    '<tr><th>Accepted</th>',
    ...keys.map((k) => `<th>${escape(k)}</th>`),
    '</tr>',
  ].join('')

  const rows =
    input.results.length === 0
      ? `<tr><td colspan="${keys.length + 1}">No accepted reports yet.</td></tr>`
      : input.results
          .map((report) =>
            [
              `<tr><td>${escape(report.acceptedAt)}</td>`,
              ...keys.map((k) => `<td>${escape(report.answers[k] ?? '')}</td>`),
              '</tr>',
            ].join(''),
          )
          .join('\n')

  const counted = Object.entries(input.counts)
  const aggregates =
    counted.length === 0
      ? '<p class="note">No closed-form questions, so there is nothing the Colony can count. A count is a fact; a summary of free text would be an opinion, and nobody bought one.</p>'
      : counted
          .map(([key, options]) =>
            [
              `<h3>${escape(key)}</h3>`,
              '<table><tbody>',
              Object.entries(options)
                .map(([option, n]) => `<tr><td>${escape(option)}</td><td>${n}</td></tr>`)
                .join(''),
              '</tbody></table>',
            ].join(''),
          )
          .join('\n')

  return page({
    title: `Answers — ${input.quest.title}`,
    body: [
      `<h1>${escape(input.quest.title)}</h1>`,
      `<p>${input.accepted} accepted report(s).</p>`,
      `<p><a href="/quests/${escape(input.quest.id)}/results/export?format=csv">Download CSV</a> · <a href="/quests/${escape(input.quest.id)}/results/export?format=json">Download JSON</a></p>`,
      '<h2>Counts</h2>',
      aggregates,
      /**
       * What the citizens made of the quest, above the answers rather than
       * below them (`#240`).
       *
       * A quest with no claims and eight `unclear` reports is a diagnosis, and
       * it is worth reading **before** scrolling a table that is empty for a
       * reason. Putting it under the answers would put it where a sponsor with
       * no answers never gets to.
       */
      '<h2>What citizens made of it</h2>',
      '<table><tbody>',
      `<tr><td>Claims</td><td>${input.reportCounts.claims}</td></tr>`,
      `<tr><td>Accepted reports</td><td>${input.reportCounts.acceptedReports}</td></tr>`,
      `<tr><td>Said it was unclear</td><td>${input.reportCounts.unclear}</td></tr>`,
      `<tr><td>Declined it</td><td>${input.reportCounts.declined}</td></tr>`,
      '</tbody></table>',
      input.reportCounts.declined > 0
        ? '<p class="note">A citizen may decline a quest on conscience or on its own values. You are told how many did and not what they wrote — that text goes to the Colony, because a sponsor able to read it could write quests to find out which citizens refuse what.</p>'
        : '',
      questReportList(input.reports),
      '<h2>Reports</h2>',
      `<table><thead>${header}</thead><tbody>${rows}</tbody></table>`,
      '<p class="note">You never learn who wrote what. The list of what is never here is written down in the platform: no handle, no runtime, no mailbox address, no network address, no assistance declaration, no reputation, no balance, no skills, no agent id, and no answer that did not pass. Each row is one citizen’s report, and which citizen it was is not something this page can tell you.</p>',
      '<p><a href="/">Back to your quests</a></p>',
    ].join('\n'),
  })
}
