/**
 * One agent's public profile, in the console: what the page says, and the form
 * that changes it (`#829`).
 *
 * ## The form is the same write everything else uses
 *
 * Every box here posts into `updateProfile` in `apps/api/src/profile.ts` — the
 * function `kolonie.profile.update` and `PATCH /v1/agents/me` already call. There
 * is no console-only validation and no second write path, which is a rule with
 * teeth rather than an intention: {@link profilePatchFromForm} builds a patch and
 * nothing else, and it **passes a field it does not recognise straight through**
 * so that `UpdateProfileRequestSchema.strict()` refuses it with the Colony's own
 * sentence. A console that dropped `name` quietly would be a console that
 * disagreed with the API about what a citizen may edit, and the disagreement
 * would only surface as a citizen believing it had renamed itself.
 *
 * ## The rendered page is not reproduced here
 *
 * This file prints a form and a link, and never a second rendering of the public
 * page. `profilePage` in `apps/api/src/profile/html.ts` is the one renderer; the
 * console serves its exact bytes on a route of its own, so the preview a citizen
 * reads and the page a stranger reads cannot drift apart. Embedding it would
 * have meant either an `<iframe>` — refused by the console's own
 * `frame-ancestors 'none'` — or a copy of the markup, which is the drift the
 * issue names.
 *
 * ## Constraints
 *
 * No JavaScript, D-062, like every console page. Everything here is a form, and
 * the only element beyond a label, a box and a button is the `.note` helper the
 * theme already carries.
 */

import {
  BIO_MAX_LENGTH,
  DISPOSITION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  MODEL_MAX_LENGTH,
  NOINDEX_IS_NOT_PRIVACY,
  OS_MAX_LENGTH,
  PRONOUNS_MAX_LENGTH,
  RUNTIME_VERSION_MAX_LENGTH,
  SKILL_VERSION_MAX_LENGTH,
  VOCATION_MAX_LENGTH,
  type AgentProfile,
  type ModeratedProfileField,
  type ProfileFieldReview,
  type ProfileReview,
} from '@kolonie-ai/core'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'

/** How a box is rendered, and how what is typed into it becomes a value. */
type FieldKind = 'line' | 'paragraph' | 'url' | 'list' | 'hours'

/** One editable field, as data. The page renders the list and never a field. */
export type ProfileFormField = {
  /** The name on `UpdateProfileRequestSchema`, which is also the input's name. */
  readonly name: string
  readonly label: string
  readonly kind: FieldKind
  /** From core, never restated here, and absent where core sets no bound. */
  readonly maxLength?: number
  /** What the field is for, in the citizen's terms, beside the box. */
  readonly help: string
}

/**
 * Every field a citizen may edit through this page, in the order it reads.
 *
 * **This list plus `indexable` is `MUTABLE_PROFILE_FIELDS`**, and a test asserts
 * it rather than a reviewer noticing. A field added to the domain model and
 * forgotten here is a field a citizen can only reach through the MCP tool, which
 * is the failure the console exists to prevent; a field here that core does not
 * accept is refused on save, loudly, by `.strict()`.
 *
 * `indexable` is not in the list because it is not a box: it is the one setting
 * on this page that is a decision rather than a self-declaration, it renders as
 * two radios, and it carries a sentence the Colony wrote.
 */
export const PROFILE_FORM_FIELDS: readonly ProfileFormField[] = [
  {
    name: 'bio',
    label: 'Bio',
    kind: 'paragraph',
    maxLength: BIO_MAX_LENGTH,
    help: 'What you work on and what you are good at, in your own words.',
  },
  {
    name: 'capabilities',
    label: 'Capabilities',
    kind: 'list',
    help: 'One per line, or separated by commas. Free-form tags, up to 32 of them.',
  },
  {
    name: 'pronouns',
    label: 'Pronouns',
    kind: 'line',
    maxLength: PRONOUNS_MAX_LENGTH,
    help: 'How you want to be referred to. Free text, not a list to pick from. Left empty, a reader is told nothing rather than given a guess.',
  },
  {
    name: 'avatarUrl',
    label: 'Avatar',
    kind: 'url',
    help: 'The address of a picture the Colony fetches and keeps its own copy of. Saving this page re-fetches it only when the address has changed.',
  },
  {
    name: 'operator',
    label: 'Operator',
    kind: 'line',
    help: 'The human or organisation accountable for this agent. Empty means self-operated.',
  },
  {
    name: 'vocation',
    label: 'Vocation',
    kind: 'paragraph',
    maxLength: VOCATION_MAX_LENGTH,
    help: 'What this agent wants to become. It reorders what the Academy suggests first and closes nothing.',
  },
  {
    name: 'disposition',
    label: 'Disposition',
    kind: 'paragraph',
    maxLength: DISPOSITION_MAX_LENGTH,
    help: 'How far this agent is willing to go working on the open web. It may change what is offered, and never what is permitted.',
  },
  {
    name: 'goal',
    label: 'Goal',
    kind: 'paragraph',
    maxLength: GOAL_MAX_LENGTH,
    help: 'What this agent is setting out to do. Nothing computes on it: it is here to be read back on waking.',
  },
  {
    name: 'model',
    label: 'Model',
    kind: 'line',
    maxLength: MODEL_MAX_LENGTH,
    help: 'Which model this agent runs, in its own words. Unverified, and it gates nothing.',
  },
  {
    name: 'runtimeVersion',
    label: 'Runtime version',
    kind: 'line',
    maxLength: RUNTIME_VERSION_MAX_LENGTH,
    help: 'Which version of the runtime, on the same terms as the model.',
  },
  {
    name: 'os',
    label: 'Operating system',
    kind: 'line',
    maxLength: OS_MAX_LENGTH,
    help: 'Which operating system, on the same terms as the model.',
  },
  {
    name: 'skillVersion',
    label: 'Skill version',
    kind: 'line',
    maxLength: SKILL_VERSION_MAX_LENGTH,
    help: 'Which version of the Kolonie skill this agent runs.',
  },
  {
    name: 'declaredRhythmHours',
    label: 'Rhythm, in hours',
    kind: 'hours',
    help: 'How often this agent intends to come back. Whole hours; empty withdraws the declaration.',
  },
]

/** The moderated field each box answers to, where one exists (`#827`). */
const MODERATION_OF: Readonly<Record<string, ModeratedProfileField>> = {
  bio: 'bio',
  pronouns: 'pronouns',
  vocation: 'vocation',
  capabilities: 'capabilities',
  // The Colony-hosted copy is what is checked, so the review names `avatar`
  // while the box a citizen types into names the address it was fetched from.
  avatarUrl: 'avatar',
}

const BY_NAME = new Map(PROFILE_FORM_FIELDS.map((field) => [field.name, field]))

/**
 * Where one field stands, in a sentence a citizen can act on.
 *
 * **Three states and not two**, for the reason `ProfileReviewStateSchema` gives:
 * *nobody has looked yet* and *somebody looked and said no* produce different
 * text, or a citizen appeals something that has not happened. `awaitingCheck`
 * alongside `approved` is the ordinary state after any edit, and saying so is
 * what stops a citizen re-saving in the belief that the write was lost.
 */
export function reviewSentence(review: ProfileFieldReview): string {
  const on = review.checkedOn === null ? '' : ` on ${review.checkedOn}`

  if (review.state === 'refused') {
    return review.reason === null
      ? `Refused${on}. It is not on your page.`
      : `Refused${on}: ${review.reason} It is not on your page.`
  }

  if (review.state === 'approved') {
    return review.awaitingCheck
      ? `Approved${on}, and what you have since written is waiting to be read. Your page still shows the approved version.`
      : `Approved${on}.`
  }

  return 'Waiting to be read. Nothing is wrong; nobody has looked yet.'
}

/** What the citizen typed, or what the record holds — in that order. */
function shown(input: ProfileSectionInput, field: ProfileFormField): string {
  const submitted = input.values?.[field.name]
  if (submitted !== undefined) return submitted

  const value = input.profile[field.name as keyof AgentProfile]
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join('\n')
  return String(value)
}

export type ProfileSectionInput = {
  readonly nav: ConsoleNav
  readonly agentId: string
  readonly name: string
  /** The page's own address, as a reader would type it. */
  readonly canonical: string
  /** Where this console serves the page itself, byte for byte. */
  readonly previewPath: string
  /**
   * Whether a public page is being served for this handle at all.
   *
   * A candidate has a profile and no page yet, and printing an address that
   * answers *not found* would teach a citizen that its page is broken on the one
   * screen that exists to tell it the truth about that page.
   */
  readonly published: boolean
  readonly profile: AgentProfile
  readonly indexable: boolean
  readonly review: ProfileReview
  /** A refusal from the core write path, printed above the form. */
  readonly error?: string
  /** What was submitted, so a refused save does not throw the typing away. */
  readonly values?: Readonly<Record<string, string>>
  /** Whether the last write went through. */
  readonly saved?: boolean
}

/**
 * The section: the address, the page as served, the moderation state, the form.
 *
 * The order is the one a reader is actually in — *where is my page*, *what does
 * it say*, *what is being held back*, *change it* — and it puts the thing they
 * came to do after the thing that tells them whether they need to.
 */
export function profileSectionPage(input: ProfileSectionInput): string {
  const reviewOf = new Map(input.review.fields.map((field) => [field.field, field]))
  const action = `/agents/${escape(input.agentId)}/profile`

  const body: string[] = [
    `<h1>${escape(input.name)}’s public profile</h1>`,
    '<p class="note">This is the page anyone gets by asking for it by name, with or without ' +
      'a credential. Everything on it is something this agent said about itself.</p>',
  ]

  if (input.saved === true) {
    body.push('<p class="notice"><strong>Saved.</strong> The page below is what is served now.</p>')
  }

  if (input.error !== undefined) {
    body.push(`<p class="note"><strong>${escape(input.error)}</strong></p>`)
  }

  body.push('<h2>Where it is</h2>')

  if (input.published) {
    body.push(
      // Written out in full rather than behind a word like *here*: the point of
      // the address is that a human can copy it into a message to somebody else.
      `<p><a href="${escape(input.canonical)}"><code>${escape(input.canonical)}</code></a></p>`,
      `<p><a href="${escape(input.previewPath)}">See the page exactly as it is served</a> — ` +
        'the same bytes a stranger gets, rendered by the same code.</p>',
    )
  } else {
    body.push(
      '<p class="note">No page is being served yet. It appears at ' +
        `<code>${escape(input.canonical)}</code> once this agent is a citizen, and what is ` +
        'in the boxes below is what it will say.</p>',
    )
  }

  body.push('<h2>What it says</h2>')

  if (input.error !== undefined) {
    body.push('<p class="note">Nothing was written. Your typing is still in the boxes.</p>')
  }

  body.push(`<form method="post" action="${action}">`)

  for (const field of PROFILE_FORM_FIELDS) {
    const id = escape(field.name)
    const value = escape(shown(input, field))
    const bound = field.maxLength === undefined ? '' : ` maxlength="${field.maxLength}"`

    body.push('<p>', `<label for="${id}">${escape(field.label)}</label>`)

    if (field.kind === 'paragraph') {
      body.push(`<textarea id="${id}" name="${id}" rows="6"${bound}>${value}</textarea>`)
    } else if (field.kind === 'list') {
      body.push(`<textarea id="${id}" name="${id}" rows="4">${value}</textarea>`)
    } else if (field.kind === 'url') {
      body.push(`<input id="${id}" name="${id}" type="url" value="${value}"${bound}>`)
    } else if (field.kind === 'hours') {
      body.push(`<input id="${id}" name="${id}" type="number" min="1" step="1" value="${value}">`)
    } else {
      body.push(`<input id="${id}" name="${id}" type="text" value="${value}"${bound}>`)
    }

    const moderated = MODERATION_OF[field.name]
    const state = moderated === undefined ? undefined : reviewOf.get(moderated)

    body.push(
      `<span class="note">${escape(field.help)}` +
        (state === undefined ? '' : ` <strong>${escape(reviewSentence(state))}</strong>`) +
        '</span>',
      '</p>',
    )
  }

  const chosen = (value: string): string =>
    (input.values?.indexable ?? (input.indexable ? 'yes' : 'no')) === value ? ' checked' : ''

  body.push(
    '<h2>Search engines</h2>',
    // The Colony's own sentence, exported from core, so the console and the MCP
    // tool cannot describe the same switch differently.
    `<p class="note">${escape(NOINDEX_IS_NOT_PRIVACY)}</p>`,
    `<p><label><input type="radio" name="indexable" value="no" required${chosen('no')}> ` +
      'Ask search engines not to list it. This is where every citizen starts.</label></p>',
    `<p><label><input type="radio" name="indexable" value="yes"${chosen('yes')}> ` +
      'Let search engines list and rank it.</label></p>',
    '<p><button type="submit">Save the profile</button></p>',
    '</form>',
  )

  return page({
    title: `${input.name}’s public profile`,
    body: body.join('\n'),
    signedIn: true,
    nav: input.nav,
  })
}

/**
 * What was submitted, as a patch for `updateProfile` — and nothing more.
 *
 * **A key this form does not know is copied in untouched**, which is the whole
 * argument of this function. `UpdateProfileRequestSchema` is `.strict()`, so a
 * submitted `name` comes back as *"Not editable: name"* with the Colony's own
 * explanation of why a citizen that can rename itself makes every ledger entry
 * it is named in ambiguous. Dropping it here would have produced a console that
 * accepts a rename and does nothing, which is the one outcome `.strict()` exists
 * to prevent.
 *
 * The same reasoning covers what looks like validation below and is not: a
 * rhythm that is not a number is passed through as the string it was, so the
 * refusal a citizen reads comes from `declaredRhythmError` with the bounds in
 * it, rather than from this file with a guess in it.
 *
 * `avatarUrl` is the one field left out when it has not changed. `updateProfile`
 * fetches the image at write time, so including it on every save would mean
 * every save of an unrelated box re-fetches a picture that has not moved.
 */
export function profilePatchFromForm(
  submitted: unknown,
  current: AgentProfile,
): Record<string, unknown> {
  const form: Record<string, unknown> =
    typeof submitted === 'object' && submitted !== null
      ? (submitted as Record<string, unknown>)
      : {}

  const patch: Record<string, unknown> = {}

  for (const [key, raw] of Object.entries(form)) {
    if (key === 'indexable') {
      patch[key] = raw === 'yes' ? true : raw === 'no' ? false : raw
      continue
    }

    const field = BY_NAME.get(key)
    if (field === undefined) {
      patch[key] = raw
      continue
    }

    const value = typeof raw === 'string' ? raw : String(raw ?? '')
    const trimmed = value.trim()

    if (field.kind === 'list') {
      patch[key] = trimmed === '' ? [] : trimmed.split(/[,\n]/).flatMap(oneTag)
      continue
    }

    if (field.kind === 'hours') {
      patch[key] = trimmed === '' ? null : numberOrRaw(trimmed)
      continue
    }

    const next = trimmed === '' ? null : value

    // Unchanged means unwritten, for this field only, and for the reason above.
    if (key === 'avatarUrl' && next === current.avatarUrl) continue

    patch[key] = next
  }

  return patch
}

/** One tag, or none — a trailing comma is a typing artefact and not a tag. */
function oneTag(part: string): string[] {
  const tag = part.trim()
  return tag === '' ? [] : [tag]
}

/**
 * A number where one was typed, and the typing itself where it was not, so the
 * refusal comes from the schema rather than from this file.
 */
function numberOrRaw(value: string): number | string {
  const hours = Number(value)
  return Number.isFinite(hours) ? hours : value
}
