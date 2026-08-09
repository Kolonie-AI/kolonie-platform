import { AtlasCategorySchema, type AtlasCategory, type AtlasEntry } from '@kolonie-ai/core'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'

/**
 * Browsing the Atlas from inside the console (`#591`).
 *
 * To put an account on the shared list, an operator typed a hostname into a text
 * box with one provider as its placeholder. There was no way to see what the
 * Colony knows about, and no indication that typing something outside the
 * catalogue leads nowhere — so **the agent, which has
 * `kolonie.accounts.recipes`, knew more about what was available than the person
 * did.**
 *
 * ## Not a second Atlas
 *
 * This renders `atlasCatalogue`'s entries, the same assembly the public pages
 * and the MCP tool read. The console does not get its own catalogue rendering
 * with its own drift, and **no provider name is typed into this file** — a test
 * asserts it, because a hard-coded row here is exactly how one surface starts
 * disagreeing with another.
 *
 * ## Categories first, then one shelf
 *
 * Ninety-six rows on an operator's screen is the mistake `#583` describes on the
 * agent page. So the browser opens on the shelves with a count each, and a shelf
 * is a link — `?category=mailbox`, no JavaScript, D-062 — rather than a widget.
 *
 * ## Adding is not marking
 *
 * One click puts an entry on the list as an unmarked wish. `#527` is deliberate
 * that the mark is the gesture that means something, and a picker that added
 * *and* marked would make the meaningful decision the cheap one. The button says
 * so on the page rather than leaving it to be discovered.
 */

/** Where the browser lives, under the accounts area `#582` is assembling. */
export function atlasPickerPath(agentId: string, category?: AtlasCategory): string {
  const base = `/agents/${agentId}/accounts/browse`

  return category === undefined ? base : `${base}?category=${category}`
}

/** What the picker knows about this agent, so it can mark what is already settled. */
export interface PickerState {
  /** Providers already on this agent's list, whether or not marked wanted. */
  readonly listed: ReadonlySet<string>
  /** Providers this agent already holds an account at. */
  readonly held: ReadonlySet<string>
}

export interface AtlasPickerInput {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  readonly agentId: string
  readonly entries: readonly AtlasEntry[]
  readonly state: PickerState
  /** The shelf being read, or nothing for the list of shelves. */
  readonly category?: AtlasCategory | undefined
  /**
   * A provider the operator just tried to add that was already there (`#591`).
   *
   * **Carried in the query rather than in a session**, because the console has
   * no flash-message mechanism and inventing one for a single sentence would be
   * a larger decision than this page. The value is echoed through `escape` and
   * is only ever rendered beside the row it names.
   */
  readonly alreadyListed?: string | undefined
}

/**
 * The shelves, with a count each.
 *
 * **Only shelves that hold something**, for the reason the public index gives:
 * fourteen headings over an empty catalogue would say the Atlas has holes in it,
 * when what it has is categories nothing is filed under yet.
 */
export function atlasPickerIndex(input: AtlasPickerInput): string {
  const counts = new Map<AtlasCategory, number>()
  for (const entry of input.entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  }

  const shelves = [...counts.entries()].map(
    ([category, count]) =>
      `<li><a href="${escape(atlasPickerPath(input.agentId, category))}">${escape(category)}</a> ` +
      `<small>${count} provider${count === 1 ? '' : 's'}</small></li>`,
  )

  return page({
    title: 'Browse the Atlas',
    signedIn: true,
    nav: input.nav,
    body: [
      '<main>',
      '<h1>Browse the Atlas</h1>',
      `<p>${escape(PICKER_STANDFIRST)}</p>`,
      shelves.length === 0
        ? '<p class="note">The catalogue is empty, so there is nothing to browse yet.</p>'
        : `<ul>${shelves.join('')}</ul>`,
      `<p><a href="/agents/${escape(input.agentId)}">Back to the agent</a></p>`,
      '</main>',
    ].join('\n'),
  })
}

/**
 * What this page is for, said once and above the shelves.
 *
 * **It says that adding is not approving**, because that is the one thing an
 * operator can get wrong here and the cost of getting it wrong is an agent
 * starting something nobody meant it to.
 */
const PICKER_STANDFIRST =
  'What the Colony knows about, by shelf. Adding one puts it on the list you and this agent ' +
  'keep together — it does not mark it as wanted and nothing is attempted, which is still your ' +
  'decision, one entry at a time.'

/** One shelf: every entry on it, with what is already true of it for this agent. */
export function atlasPickerShelf(
  input: AtlasPickerInput & { readonly category: AtlasCategory },
): string {
  const rows = input.entries
    .filter((entry) => entry.category === input.category)
    .map((entry) => pickerRow(entry, input))

  return page({
    title: `Browse the Atlas — ${input.category}`,
    signedIn: true,
    nav: input.nav,
    body: [
      '<main>',
      `<h1>${escape(input.category)}</h1>`,
      `<p>${escape(PICKER_STANDFIRST)}</p>`,
      input.alreadyListed === undefined
        ? ''
        : `<p class="note">${escape(input.alreadyListed)} is already on the list, so nothing ` +
          'was added. An entry appears once — marking it as wanted is the next decision, and it ' +
          'is made on the agent’s own page.</p>',
      rows.length === 0
        ? '<p class="note">Nothing is filed on this shelf yet.</p>'
        : `<ul class="k-atlas-picker">${rows.join('')}</ul>`,
      `<p><a href="${escape(atlasPickerPath(input.agentId))}">All shelves</a> · ` +
        `<a href="/agents/${escape(input.agentId)}">Back to the agent</a></p>`,
      '</main>',
    ].join('\n'),
  })
}

/**
 * One row.
 *
 * **An entry already listed or held is shown, marked, and not offered again.**
 * Hiding it makes an operator wonder whether they missed it; offering it
 * produces a duplicate the storage layer then has to refuse, which is a refusal
 * for doing what the page invited.
 */
function pickerRow(entry: AtlasEntry, input: AtlasPickerInput): string {
  const settled = input.state.held.has(entry.provider)
    ? ' <strong>— already held</strong>'
    : input.state.listed.has(entry.provider)
      ? ' <strong>— already on the list</strong>'
      : ''

  const add =
    settled === ''
      ? `<form method="post" action="/agents/${escape(input.agentId)}/wishes">` +
        `<input type="hidden" name="provider" value="${escape(entry.provider)}">` +
        `<input type="hidden" name="category" value="${escape(entry.category)}">` +
        '<button type="submit">Add to the list</button></form>'
      : ''

  return (
    `<li>${escape(entry.title)} <small>(${escape(entry.provider)})</small>${settled}` +
    `<br><small>${escape(pickerStatusLine(entry))} — ${escape(pickerOperatorLine(entry))}</small>` +
    `${add}</li>`
  )
}

/**
 * What the catalogue knows about joining it, in the operator's words (`#588`).
 *
 * The three states said plainly, because an operator reading *unwritten* on a
 * row they are about to add should know they are adding a name rather than a
 * path somebody walked.
 */
function pickerStatusLine(entry: AtlasEntry): string {
  if (entry.status === 'joinable') return 'the Colony has walked this and written the steps'
  if (entry.status === 'refused') return 'walked, and there is no honest way in'

  return 'listed, and nobody has walked it yet'
}

/** Who has to be there (`#589`), which is what decides whether to add it at all. */
function pickerOperatorLine(entry: AtlasEntry): string {
  const said = {
    unaided: 'the agent can do this alone',
    'operator-needed': 'you will be needed at a step',
    unknown: 'who is needed is not known',
  }[entry.operatorNeed]

  return entry.operatorNeedIsGuess ? `${said} (a guess, not a walk)` : said
}

/** The shelf named in a query string, or nothing — a bad one is not an error. */
export function pickerCategory(value: unknown): AtlasCategory | undefined {
  const parsed = AtlasCategorySchema.safeParse(value)

  return parsed.success ? parsed.data : undefined
}
