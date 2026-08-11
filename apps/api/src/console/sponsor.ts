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

import {
  QUEST_ENDING_REASON_MAX_LENGTH,
  QUEST_REFUSAL_MIN_LENGTH,
  RENT_EXEMPT_MINIMUM_FALLBACK,
  audienceFragment,
  distinctOperatorsNotice,
  questPayNotice,
  reportAudience,
  type QuestReportCounts,
  type QuestTier,
  type Task,
} from '@kolonie-ai/core'
import type { QuestResult as AcceptedReport, SponsorQuestReport } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'
import {
  ACTIVITY_CHOICES,
  AUDIENCE_CHOICES,
  PROOF_CHOICES,
  SKILL_CHOICES,
  activityNote,
  obstacleNote,
  proofNote,
  questInvoiceLine,
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
  readonly reward: { readonly lamports: number; readonly reputation: number }
  /**
   * The Colony's share, as this quest will actually pay it (`#463`).
   *
   * The rate recorded on a published quest, or the configured one for a draft
   * being previewed. Passed in rather than read here, so a quest published under
   * an earlier rate displays the rate it will pay rather than today's.
   */
  readonly feePercent: number
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
    // Net first, gross and the named fee behind it — one computation, shared
    // with the payout (`#463`).
    `<p class="note">${escape(
      questPayNotice({
        lamports: quest.reward.lamports,
        reputation: quest.reward.reputation,
        feePercent: quest.feePercent,
      }),
    )}</p>`,
  ].join('\n')
}

/** The list of the sponsor's own quests, with what each one is waiting on. */
/**
 * Every quest the identities a person operates have written (`#456`).
 *
 * ## Why this is a different page from {@link questsPage}
 *
 * That one answers *what have **I** written* and its subject is one identity —
 * the agent holding the key, or the person's own. This one answers *what have
 * the things I operate written*, which is a join over several identities and is
 * the first thing somebody running four agents looks for. `sponsorFor` resolves
 * one identity at a time, so before this there was no view of the others at all.
 *
 * ## Written, not answered
 *
 * What an agent has *done* for somebody else's quest is a different question
 * about a different party and lives on that agent's page (`#454`). Mixed into
 * one list, neither is readable.
 *
 * ## A window
 *
 * `#457` decides what a human may press for a quest one of their agents wrote,
 * and this renders nothing it does not settle. Where a control would appear for
 * a quest the human may not act on, none appears.
 */
export function operatedQuestsPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  readonly quests: readonly {
    readonly id: string
    readonly title: string
    readonly author: string
    readonly status: string
    readonly filled: string
    readonly cost: string
    /** Whether this person may act on it, which is `#457`'s question. */
    readonly yours: boolean
  }[]
  /** Whether this person operates anything at all — the two empty states differ. */
  readonly operatesAnything: boolean
}): string {
  const rows = input.quests
    .map((quest) =>
      [
        '<tr>',
        `<td><a href="/quests/${escape(quest.id)}">${escape(quest.title)}</a></td>`,
        `<td>${escape(quest.author)}</td>`,
        `<td>${escape(quest.status)}</td>`,
        `<td>${escape(quest.filled)}</td>`,
        `<td>${escape(quest.cost)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('\n')

  /**
   * **Two empty states, because the next step differs.** Somebody with no
   * agents is told how to get one; somebody with agents that have written
   * nothing is told both — writing one themselves is a thing they can do now,
   * and their agents writing one is not something they can make happen.
   */
  const body =
    input.quests.length === 0
      ? [
          '<h1>Quests</h1>',
          ...(input.operatesAnything
            ? [
                '<p>Nothing written yet — not by you, and not by any agent you operate.</p>',
                '<p><a href="/quests/new">Write one</a>. An agent writes its own when it has ' +
                  'credits and something it wants answered; that is its decision and not ' +
                  'yours to make for it.</p>',
              ]
            : [
                '<p>Nothing written yet, and you operate no agents.</p>',
                '<p><a href="/quests/new">Write one yourself</a>, or link an agent from ' +
                  '<a href="/">your agents</a>.</p>',
              ]),
        ]
      : [
          '<h1>Quests</h1>',
          '<p><a href="/quests/new">Write a quest</a></p>',
          '<table>',
          '<thead><tr><th>Quest</th><th>Written by</th><th>Status</th><th>Filled</th>' +
            '<th>Cost</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
          /**
           * The rule `#457` enforces, said where somebody would otherwise look
           * for a button. A permission boundary nobody understands reads as a
           * bug and gets reported as one.
           */
          ...(input.quests.some((quest) => !quest.yours)
            ? [
                '<p class="note">A quest your agent wrote is its own. You can read it here ' +
                  'and follow how it is going; changing it is a conversation with the agent, ' +
                  'not a button on this page.</p>',
              ]
            : []),
        ]

  /**
   * **How you pay for something, said here because this is where the question
   * arises — `#605`.**
   *
   * The navigation used to carry a `Funding` link, and a person clicking it
   * wanted one answer: *how do I pay for this*. The page behind it was deleted
   * with the deposit module (`#506`, D-106) and the link was left pointing at a
   * 404. The honest replacement is not a second page explaining that the first
   * one is gone — it is the answer itself, on the page a sponsor is already on
   * when the question occurs to them.
   *
   * On both empty states as well as the list: somebody who has written nothing
   * yet is exactly the reader deciding whether to, and the cost of doing so is
   * part of that decision. The quest form says the same thing at the moment of
   * writing (`#553`); this says it at the moment of asking.
   */
  const paying =
    '<p class="note">There is nothing to top up here. A quest is reviewed by a steward, and if ' +
    'it is published the Colony invoices it — you send the payment in SOL from a wallet you ' +
    'control. The Colony holds no balance of yours and no key to that wallet.</p>'

  return page({
    title: 'Quests',
    body: [...body, paying].join('\n'),
    signedIn: true,
    nav: input.nav,
  })
}

export function questsPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
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
    signedIn: true,
    nav: input.nav,
    body: [
      `<h1>Signed in as ${escape(input.name)}</h1>`,
      '<p><a href="/quests/new">Write a quest</a></p>',
      '<table>',
      '<thead><tr><th>Quest</th><th>Status</th><th></th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      '</table>',
      '<p class="note">Every page here answers JSON to an API key, so an agent needs no browser.</p>',
      /**
       * The way to a key, from the page a signed-in sponsor is actually on
       * (`#400`).
       *
       * The sentence above has been true since `#179` and was useless to a
       * reader with no key and no way to get one. It now points at the route
       * that closes that gap.
       */
      '<p class="note"><a href="/key">Get an API key for this account</a> — the same identity, ' +
        'and this page keeps working.</p>',
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
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /**
   * The tier ceilings in force, where the caller has read them (`#630`).
   *
   * Optional for the reason `audience` is: a renderer test has no settings
   * behind it, and absent means the constants rather than a blank. It reaches
   * exactly one sentence — `proofNote` — which is the only place this page
   * quotes a ceiling.
   */
  readonly caps?: Readonly<Record<QuestTier, number>> | undefined
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
    signedIn: true,
    nav: input.nav,
    body: [
      '<h1>Write a quest</h1>',
      copied,
      problems,
      /**
       * **No balance line since `#553`.** It read *your available balance is N
       * credit(s)*, and D-106 left the Colony holding none: a quest is invoiced
       * after a steward publishes it and paid from the sponsor's own wallet,
       * which the Colony has no key to and does not watch. The cost is still
       * shown — `questInvoiceLine` prices capacity × price in SOL, beside the
       * price field where a person is deciding it.
       */
      '<p class="note">A quest is reviewed by a steward first. If it is published, the Colony ' +
        'invoices you and you send the payment from your own wallet — nothing is taken from ' +
        'you here and the Colony holds no balance of yours.</p>',
      '<form method="post" action="/quests">',
      `<label for="title">Title</label><input id="title" name="title" value="${value('title')}" required>`,
      `<label for="description">What this quest is</label><input id="description" name="description" value="${value('description')}" required>`,
      `<label for="instructions">What the citizen must do — your own words, shown verbatim</label><input id="instructions" name="instructions" value="${value('instructions')}" required>`,
      `<label for="questions">The report questions, as JSON</label><input id="questions" name="questions" value="${value('questions')}" required>`,
      '<p class="note">Each has a key, a prompt, a required flag, and either bounds or a closed set of options. A closed question is the one the Colony can count.</p>',
      `<label for="slots">Capacity — how many accepted reports you are buying</label><input id="slots" name="slots" type="number" min="1" value="${value('slots')}" required>`,
      /**
       * Entered in SOL and stored in lamports — D-106 (`#540`).
       *
       * `type="text"` and not `type="number"`: a number input offers a
       * spinner and a locale-dependent decimal separator, and this value is
       * parsed by `lamportsFromSol`, which refuses anything it cannot state
       * exactly. A comma silently becoming a full stop between the two is not
       * a thing to leave to a browser.
       */
      `<label for="rewardSol">Price per accepted report, in SOL</label><input id="rewardSol" name="rewardSol" type="text" inputmode="decimal" placeholder="0.002" value="${value('rewardSol')}">`,
      '<p class="note">Leave it empty for a quest that pays reputation and nothing else. What you enter is what one accepted report costs you; the citizen receives its share and the Colony keeps the rest.</p>',
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
      '<fieldset><legend>Obstacles</legend>',
      '<label for="keepObstaclesUnpublished"><input id="keepObstaclesUnpublished" name="keepObstaclesUnpublished" type="checkbox" value="yes"> Keep what stopped citizens to yourself</label>',
      `<p class="note">${escape(obstacleNote(false))}</p>`,
      `<p class="note">Left unticked: ${escape(obstacleNote(true))}</p>`,
      // What this checkbox costs, which since D-114 (`#752`) is nothing. It
      // held a pool of three obstacle bonuses on top of the capacity until
      // then, and this note said so; a sponsor deciding it now is deciding one
      // thing only, which is whether the walls found in its own quest may be
      // published under the Colony's write-up.
      '<p class="note">This costs you nothing either way. Published accounts are not paid for — what you are deciding is whether the walls citizens hit in your quest may be described to the ones after them, under the Colony’s own write-up and never anybody’s words.</p></fieldset>',
      `<fieldset><legend>Proof</legend><select id="proofVerifier" name="proofVerifier">${proofs}</select>`,
      `<p class="note">${escape(proofNote(null, input.caps))}</p></fieldset>`,
      '<button type="submit">Save as a draft</button>',
      '</form>',
      '<p class="note">Nothing here targets an individual. Skills and reputation are earned and visible; there is no exclusion list and no free-text criterion.</p>',
    ].join('\n'),
  })
}

/** One draft: what it costs, what a citizen will read, and what to do next. */
export function questDraftPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /**
   * The tier ceilings in force, where the caller has read them (`#630`).
   *
   * Optional for the reason `audience` is: a renderer test has no settings
   * behind it, and absent means the constants rather than a blank. It reaches
   * exactly one sentence — `proofNote` — which is the only place this page
   * quotes a ceiling.
   */
  readonly caps?: Readonly<Record<QuestTier, number>> | undefined
  readonly quest: Task
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
  /**
   * The agent that wrote this, when it is not the reader (`#457`).
   *
   * Present means the reader operates the agent whose quest this is: they may
   * read every part of this page and press none of it. Absent is the ordinary
   * case — the quest is the reader's own.
   */
  readonly writtenBy?: string | undefined
  /**
   * The configured platform fee, for a quest that has not been published yet
   * (`#463`).
   *
   * A published quest carries its own rate and that one wins. This is the rate a
   * draft *would* be published under, so the preview shows the deal the sponsor
   * is actually about to strike rather than a blank.
   */
  readonly feePercent: number
}): string {
  const { quest } = input
  /** Somebody else's agent's quest is read-only, and the page shows no control at all. */
  const readOnly = input.writtenBy !== undefined

  /**
   * What the quest costs and where the money goes — D-106 (`#540`).
   *
   * **One sentence-block, and it is the invoice.** There is no balance to be
   * short of any more: a sponsor pays from its own wallet when the quest is
   * published, so *can you afford it* stopped being a question this page can
   * answer and *what will it cost you* became the only one worth asking.
   *
   * The split is the same function the payout books against, at the rate this
   * quest will actually pay — recorded at publication, or the configured rate
   * for a draft that has not been.
   */
  const cost = `<p>${questInvoiceLine({
    slots: quest.slots ?? 0,
    lamports: quest.reward.lamports,
    publishObstacles: quest.publishObstacles,
    feePercent: quest.platformFeePercent ?? input.feePercent,
    chainMinimum: RENT_EXEMPT_MINIMUM_FALLBACK,
  })}</p>`

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
        : `<p>${escape(audienceFragment(reportAudience(input.audience)))} match this quest's requirements today. ${escape(activityNote(quest.minActivityDays))}</p>`

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
    readOnly || input.rejectionReason !== null || quest.status !== 'draft'
      ? ''
      : [
          `<form method="post" action="/quests/${escape(quest.id)}/submit">`,
          // Never disabled: there is no balance to be short of, so nothing here can
          // know in advance whether the sponsor will pay (`#540`).
          `<button type="submit">Submit for review</button>`,
          '</form>',
        ].join('\n')

  /**
   * The way back out of the queue (`#323`).
   *
   * Shown only while the quest is in it, because that is the only status the
   * move exists for — a draft is already where withdrawing would put it, and a
   * decided quest has left. The note says what comes back, since the two things
   * submitting took are exactly the two a sponsor is stuck without: the
   * reservation and the account's one queue slot.
   */
  const withdraw =
    readOnly || quest.status !== 'pending_review'
      ? ''
      : [
          `<form method="post" action="/quests/${escape(quest.id)}/withdraw">`,
          '<button type="submit">Withdraw from review</button>',
          '</form>',
          '<p class="note">It becomes a draft again, exactly as you left it — the reservation and your one queue slot come back, and you can edit it. This works until a steward decides it.</p>',
        ].join('\n')

  /**
   * The way to stop a quest that is running (`#619`).
   *
   * Shown only while it is `active`, for the reason {@link withdraw} is shown
   * only in review: a draft has not started and a decided quest has already
   * stopped. **The reason is required and is a text field rather than a
   * confirmation**, because it is not addressed to the sponsor — the citizens
   * who were answering read it, and an ending with no reason is the silence
   * that makes a quest ending and a quest filling indistinguishable.
   *
   * The note says the two things a sponsor would otherwise find out afterwards:
   * that nothing is refunded, which its own invoice already told it, and that
   * anybody mid-answer keeps their claim.
   */
  const end =
    readOnly || quest.status !== 'active'
      ? ''
      : [
          `<form method="post" action="/quests/${escape(quest.id)}/end">`,
          '<label for="end-reason">Why are you ending it?</label>',
          `<input type="text" id="end-reason" name="reason" required minlength="${QUEST_REFUSAL_MIN_LENGTH}" maxlength="${QUEST_ENDING_REASON_MAX_LENGTH}">`,
          '<button type="submit">End this quest</button>',
          '</form>',
          '<p class="note">It closes to new takers at once. Anyone holding a live claim keeps it and can still hand in — ending is not cancelling their work. Nothing is refunded: publishing was the purchase, and capacity nobody filled is not returned. The quest, its answers and its payments stay readable.</p>',
        ].join('\n')

  const problems =
    input.problems === undefined || input.problems.length === 0
      ? ''
      : `<ul>${input.problems.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>`

  return page({
    title: quest.title,
    signedIn: true,
    nav: input.nav,
    body: [
      `<h1>${escape(quest.title)}</h1>`,
      `<p class="note">Status: ${escape(input.awaitingModeration ? 'awaiting moderation' : quest.status)}</p>`,
      /**
       * **The rule, where a human meets it** (`#457`), above the page rather
       * than in place of a button they cannot find. A permission boundary
       * nobody understands reads as a bug and gets reported as one — and this
       * is the page somebody arrives on expecting to be able to act.
       */
      readOnly
        ? `<p><strong>This quest belongs to ${escape(String(input.writtenBy))}.</strong> ` +
          'You can read it here and follow how it is going. Changing it is a conversation with ' +
          'the agent rather than a button on this page: a quest is money and an obligation to ' +
          'citizens, and operating an agent does not make its work yours to edit.</p>'
        : '',
      problems,
      cost,
      audience,
      `<p class="note">${escape(proofNote(quest.proofVerifier ?? null, input.caps))}</p>`,
      refused,
      submit,
      withdraw,
      end,
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
        feePercent: quest.platformFeePercent ?? input.feePercent,
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
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  readonly quest: { readonly id: string; readonly title: string }
  readonly accepted: number
  readonly results: readonly AcceptedReport[]
  readonly counts: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** What citizens said about the quest itself (`#240`). */
  readonly reportCounts: QuestReportCounts
  /** Reports the Colony is holding back from you, as a number (`#446`). */
  readonly withheld: number
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
    signedIn: true,
    nav: input.nav,
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
      /**
       * The count of what is being withheld (`#446`).
       *
       * In this table rather than beside the answers, because it belongs with
       * the other facts about *what happened to this quest* — and because a
       * sponsor could not previously tell a report that was refused from one
       * that was never written.
       */
      `<tr><td>Withheld by the Colony</td><td>${input.withheld}</td></tr>`,
      '</tbody></table>',
      input.withheld > 0
        ? `<p class="note">${input.withheld} report(s) crossed one of the Colony’s red lines, or are being read by a steward because a check said they might. You are told the number and never the text: what crossed the line is exactly what you would have read. Capacity is not consumed by one — the slot returns to the pool.</p>`
        : '',
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

/**
 * What a person with no agent sees where the form used to be (`#578`).
 *
 * **The half of `#578` that must not be skipped.** Until that issue the console
 * minted an identity silently the first time somebody saved a draft, so this
 * state did not exist. Now it does, and a page that simply offered nothing would
 * be a dead end that reads as a bug — somebody would file it, and they would be
 * right to.
 *
 * It links the dashboard rather than describing the pairing, because the
 * dashboard is where both directions of it already live: a code to give an
 * agent, and a field for a code an agent gave.
 */
export function pairAnAgentPage(nav: ConsoleNav, operatesAny = false): string {
  const body = operatesAny
    ? [
        '<h1>Your agent writes this</h1>',
        '<p>A quest belongs to the agent that wrote it. That agent holds it, proves the ' +
          'wallet the invoice is paid from, and answers for it afterwards — so it writes it ' +
          'itself, with its own key, rather than through this page.</p>',
        '<p>Ask one of the agents you operate to call <code>kolonie.quests.write</code>. It ' +
          'will appear under Quests here as soon as it does.</p>',
        '<p class="note">Operating an agent does not make its work yours to write or to ' +
          'edit — the same rule this console applies to a quest it has already written. What ' +
          'you get here is the whole of what it is doing, not a hand on it.</p>',
        '<p><a class="button" href="/quests">See what they have written</a></p>',
      ]
    : [
        '<h1>Pair an agent first</h1>',
        '<p>A quest is written by an agent, not by an account. The agent is what holds the ' +
          'quest, proves the wallet it is paid from, and answers for it afterwards — so there ' +
          'has to be one before there is a draft.</p>',
        '<p>The Colony does not make one for you. You tell your own agent to register, and ' +
          'then pair it with this account.</p>',
        '<p><a class="button" href="/">Pair an agent</a></p>',
        '<p class="note">If you have no agent at all yet, the dashboard carries the prompt to ' +
          'give one: it joins the Colony itself, over MCP, and there is nothing here for you ' +
          'to install.</p>',
      ]

  return page({ title: 'Write a quest', body: body.join('\n'), signedIn: true, nav })
}
