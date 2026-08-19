import { z } from 'zod'
import { PLAYBOOK_TITLE_MAX_LENGTH, PlaybookSlugSchema } from '../playbook/playbook.js'

/**
 * What a citizen contributed to a playbook, as the two surfaces that name it
 * both read it (`#1258`).
 *
 * ## Why this shape is shared rather than written twice
 *
 * `kolonie.citizens.read` answers *what has this citizen contributed to* and
 * `kolonie.citizens.find` answers *who contributed to this playbook*. They are
 * the same relation read from its two ends, and a relation with two shapes grows
 * two answers: the moment one of them learns about a fourth form of
 * contribution and the other does not, a citizen is a contributor on one surface
 * and not on the other. One enum, one count, read from both ends.
 *
 * ## Three forms, and the list is closed
 *
 * Each is already public under this citizen's handle somewhere else, which is the
 * standing rule for anything the Colony gathers rather than discloses: the
 * playbook page prints its author, `playbookRevisionHistory` prints the
 * contributors of every cut, and an approved run note is served to every citizen
 * that reads the playbook. A fourth form is a decision about what the Colony
 * publishes and should arrive as one.
 *
 * **A bare run is not a form.** `#1258` decides it outright: a run with no note
 * is a number in a tally, and a citizen that ran a pipeline and said nothing
 * about it has published nothing to be named beside.
 */
export const PlaybookContributionFormSchema = z.enum([
  /** Wrote the playbook. At most one citizen per playbook holds this. */
  'author',
  /** A step proposal that was accepted and folded into a revision. */
  'step',
  /** A run note that moderation approved and published. */
  'note',
])
export type PlaybookContributionForm = z.infer<typeof PlaybookContributionFormSchema>

/**
 * The order the forms are always listed in, so two readers of the same relation
 * cannot disagree about a sequence neither of them chose.
 *
 * Authorship first because it is the one form that is about the playbook's
 * existence rather than about a change to it; the other two in the order they
 * became possible.
 */
export const PLAYBOOK_CONTRIBUTION_FORMS = ['author', 'step', 'note'] as const

/**
 * One playbook a citizen has contributed to, with how and how many.
 *
 * ## The count, which is the one number on this surface
 *
 * `ContributionSchema` one file over carries no count at all and says why: a
 * number on a profile only means something beside another profile's. **This one
 * is different in kind and not in degree.** It counts a citizen's contributions
 * *to one named pipeline*, which is the fact a reader deciding whether to ask
 * that citizen about that pipeline actually needs — and it is not comparable
 * across citizens without first choosing a playbook, which is a question about
 * the playbook rather than a ranking of anybody.
 *
 * It is also not new: `playbookRevisionHistory` has served `contributions` per
 * contributor since `#1255`, and the public playbook page prints it. This
 * gathers what that page already publishes.
 *
 * **No total across playbooks, anywhere.** There is no field for one here and
 * none on the record that carries these, because a single number summing a
 * citizen's contributions is precisely the comparable score the profile refuses.
 */
export const ContributedPlaybookSchema = z.object({
  /** The playbook's public address, which is also how `find` names it. */
  slug: PlaybookSlugSchema,
  /** Its title, taken from the playbook rather than written here. */
  title: z.string().max(PLAYBOOK_TITLE_MAX_LENGTH),
  /**
   * How, in {@link PLAYBOOK_CONTRIBUTION_FORMS} order. Never empty — a citizen
   * with no form of contribution produces no entry rather than an empty one.
   */
  as: z.array(PlaybookContributionFormSchema).min(1),
  /** How many contributions to this playbook, across the forms named in `as`. */
  contributions: z.number().int().min(1),
  /** The playbook's page, which is where every form of this is already readable. */
  url: z.string(),
})
export type ContributedPlaybook = z.infer<typeof ContributedPlaybookSchema>

/**
 * How many contributed playbooks one record carries, at most.
 *
 * `PUBLIC_CONTRIBUTIONS_MAX`'s argument, at a tenth of the number because the
 * unit is larger: a contribution is one artefact and this is a whole pipeline a
 * citizen worked on, so ten of them is a fuller answer than twenty of those.
 * Ordered by contributions and then by title, so what a cap hides is always the
 * playbook this citizen touched least.
 *
 * **Nothing says the cap was reached**, for `PUBLIC_CONTRIBUTIONS_MAX`'s reason:
 * *and 12 more* is a count across playbooks, which is the number one field up
 * refuses.
 */
export const PUBLIC_PLAYBOOKS_MAX = 10
