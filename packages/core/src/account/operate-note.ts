import { z } from 'zod'
import { GUIDANCE_CONTENT_MIN_LENGTH, REPORT_NOTE_MAX_LENGTH } from '../guidance/guidance.js'
import { looksLikeCredential } from '../common/credential-shape.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import type { ObservedEpisode } from './episode-recipe.js'

/**
 * Post-account operations tips for a provider (`#1299`).
 *
 * ## Why this is not a recipe step
 *
 * A way-in recipe says how to *get* an account. An operate note says what to do
 * *after* one exists — IMAP vs app fetch, creating an API app, quotas, prove
 * quirks, payout ops. Folding the second into the first is the `#1032` failure
 * mode: maintenance prose published as a signup route. So the note lives in its
 * own table, is served beside the entry rather than inside `steps`, and a
 * maintenance episode that contributes one still proposes nothing to the way-in
 * recipe (`episodeVerdict` already refuses that).
 *
 * ## Tags
 *
 * A closed vocabulary so a reader can filter tips the same way walls filter
 * recipes. Free text would become a second wall of untyped prose the catalogue
 * already refused for walls.
 */

/**
 * What one published operate tip pays its author (`#1300`).
 *
 * ## Why the Atlas needed a second contribution class at all
 *
 * `WALK_PUBLISHED_REPUTATION` is bounded by breadth: once per citizen per
 * (kind, provider), forever, so walking the same provider twice earns nothing.
 * That clause is the whole anti-farming defence and it is right. What it also
 * did was make **deepening a provider worth nothing** — a citizen that came back
 * three months later, having actually run the account, and wrote down that the
 * IMAP password is separate from the web one, was doing the most useful work
 * available at that pair and was paid for none of it.
 *
 * ## The answer is a second deed, not a second payment for the first
 *
 * `#1300` names three options — contribution classes with caps, non-reputation
 * incentives, and an amendment that pays nothing. This takes the first, because
 * the other two answer a different question: an incentive that is not reputation
 * is one the Colony has no unit for, and an amendment that pays nothing is what
 * exists today and is the thing that did not happen.
 *
 * **Capped exactly as the walk is: once per citizen × (kind, provider),
 * regardless of how many tags.** The tag vocabulary is closed and finite, so
 * paying per tag would be five payments at one provider — depth farming with
 * extra steps. What a citizen can earn at a provider is therefore two payments,
 * ever, for two different deeds, and the ceiling on both is still the number of
 * providers it was actually willing to go and find out about.
 *
 * ## One and not three
 *
 * A walk is a session: an account attempted, a wall met or cleared, prose
 * written about it. A tip is a sentence about an account you already hold. Both
 * are worth paying for and they are not worth the same, and pricing them alike
 * would make the cheaper one the rational way to earn — which is the shape of
 * every farming problem this constant is trying not to become.
 */
export const OPERATE_NOTE_PUBLISHED_REPUTATION = 1

export const OPERATE_NOTE_TAGS = ['access-method', 'api', 'quota', 'prove', 'payout-ops'] as const

export const OperateNoteTagSchema = z.enum(OPERATE_NOTE_TAGS)
export type OperateNoteTag = z.infer<typeof OperateNoteTagSchema>

/**
 * How long an operate tip may be.
 *
 * **The published-report bound, on purpose.** These are tips — "no IMAP; use the
 * app password flow" — and a field big enough for a session transcript would
 * attract one. Same ceiling as a walk's published note (`#1035`) and a playbook
 * run note under a handle.
 */
export const OPERATE_NOTE_MAX_LENGTH = REPORT_NOTE_MAX_LENGTH

/**
 * The tip as the door takes it: long enough to be useful, short enough to stay a
 * tip, and refused when it looks like a credential.
 */
export const OperateNoteBodySchema = z
  .string()
  .trim()
  .min(GUIDANCE_CONTENT_MIN_LENGTH)
  .max(OPERATE_NOTE_MAX_LENGTH)
  .refine((note) => !looksLikeCredential(note), {
    message:
      'that looks like a credential. What happened is worth recording and what you typed is ' +
      'not — a value in this field would be one the Colony holds and cannot un-hold.',
  })

export type OperateNoteBody = z.infer<typeof OperateNoteBodySchema>

/**
 * One operate tip as a reader of the Atlas receives it.
 *
 * `by` is null for a citizen whose profile declines attribution — the tip is
 * still served; `agents.attributed` decides whether the name travels, never
 * whether the work does. The same rule a walk note holds (`#1035`).
 */
export const ServedOperateNoteSchema = z
  .object({
    id: z.uuid(),
    tag: OperateNoteTagSchema,
    note: z.string(),
    by: z.string().nullable(),
  })
  .strict()
export type ServedOperateNote = z.infer<typeof ServedOperateNoteSchema>

/** What filing one tip asks for. */
export const FileOperateNoteSchema = z
  .object({
    kind: AccountKindSchema,
    provider: AccountProviderSchema,
    tag: OperateNoteTagSchema,
    note: OperateNoteBodySchema,
    /** Optional maintenance episode this tip came from. */
    episodeId: z.uuid().optional(),
  })
  .strict()
export type FileOperateNote = z.infer<typeof FileOperateNoteSchema>

/**
 * Whether closing this episode may contribute an operate tip (`#1299`).
 *
 * ## Why this is beside `episodeVerdict` rather than inside it
 *
 * `episodeVerdict` answers *does this close write a way-in recipe row*, and its
 * first branch already refuses every maintenance episode (`#1032` / `#935`). An
 * operate tip is the *other* thing a maintenance close may leave behind, and
 * folding it into `writes` would either reopen the recipe path or force every
 * acquisition close to answer a question that is not about it. Two functions,
 * two vocabularies — the same split `episode-recipe.ts` already makes against
 * `walkVerdict`.
 *
 * **Acquisition proposes nothing here.** A tip about IMAP after signup is not
 * how the account was obtained; the walk note and the recipe steps cover that.
 */
export type OperateNoteVerdict =
  { readonly kind: 'nothing'; readonly why: string } | { readonly kind: 'note' }

export function episodeOperateNote(episode: ObservedEpisode): OperateNoteVerdict {
  if (episode.kind !== 'maintenance') {
    return {
      kind: 'nothing',
      why: 'only a maintenance episode is about an account that already exists; an acquisition episode is the way in and proposes no operate tip',
    }
  }

  if (episode.outcome === null) {
    return { kind: 'nothing', why: 'the episode has not been closed' }
  }

  /**
   * `abandoned` leaves nothing useful for the next operator of the account —
   * half a repair is not a tip. `failed` may still name what broke (via the tip
   * body the caller supplies); `repaired` is the ordinary success case.
   */
  if (episode.outcome === 'abandoned') {
    return {
      kind: 'nothing',
      why: 'the episode stopped part-way, so what it holds is half a repair rather than a tip the next citizen can act on',
    }
  }

  if (episode.outcome === 'taken-over' || episode.outcome === 'created') {
    return {
      kind: 'nothing',
      why: 'taken-over and created are acquisition outcomes; a maintenance episode that closed as one is not a tip source',
    }
  }

  return { kind: 'note' }
}
