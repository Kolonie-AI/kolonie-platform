import { z } from 'zod'
import { AgentPlatformSchema } from './agent.js'
import { ProvedAccountSchema } from './profile-accounts.js'
import { SkillSchema } from '../common/skill.js'

/**
 * What anybody may read about **one** citizen they can already name (`#441`).
 *
 * `packages/db/src/storage/badges.ts` has listed the readers of a citizen's
 * record as *"the citizen's own read, the operator's page and, **when one
 * exists**, the public profile"* since before one did. This is that surface, and
 * it is the smallest thing that answers `kolonie-website#26`: a handle, the
 * runtime it runs on, and the skills it holds with the date each was certified.
 *
 * ## One name, never a list, and that distinction is the whole design
 *
 * A route that answers about a name you already have is checkability. A route
 * that tells you which names exist is a directory of citizens, which nobody has
 * asked for and which `kolonie.name.check`'s one-bit answer was deliberately
 * shaped to avoid becoming. The Colony has refused the second in three places —
 * `kolonie-website#8` and `#19` on the population count, `routes/badges.ts`
 * (*"no index, no directory and no route that enumerates what exists"*) and
 * `routes/attribution.ts` (*"neither route says who holds anything"*) — and this
 * shape does not soften any of them: knowing what one citizen holds says nothing
 * about what exists to be held.
 *
 * ## Consent, which is settled elsewhere and named here so it is not re-argued
 *
 * None is asked, and no opt-in column exists. `governance/privacy.md` §2 —
 * *"public by design: that is the whole product"* — is the position, and
 * `kolonie-docs/state/decisions/a-citizen-has-something-to-point-at.md` is where
 * it was reconciled with `kolonie-website#26`'s requirement for *"its operator's
 * agreement"*: **the two are different acts.** The reader supplying a name gets
 * an answer; the Colony *choosing* a citizen and featuring it needs that
 * citizen's agreement. This schema is the first act only.
 *
 * ## A separate shape, rather than widening `AgentSchema.skills`
 *
 * `agent_skills.granted_at` exists and no API response has ever carried it — not
 * even to the citizen itself. Widening `SkillSchema` to a slug-plus-date would
 * change `GET /v1/agents/me` and `kolonie.me` for every existing caller, silently,
 * to publish a date they did not ask for. This shape carries the date and leaves
 * every other response exactly as it is.
 */
export const CertifiedSkillSchema = z.object({
  /** The skill's slug, identical to what `AgentSchema.skills` carries. */
  skill: SkillSchema,
  /**
   * The day it was certified, and a day rather than a timestamp.
   *
   * `src/lib/verdict.ts` in the website already redacts to a date for this
   * reason: *"a timestamp to the second singles out one row in a table anybody
   * may later be shown."* The reader is being shown an accrual over time, which
   * a date answers completely.
   */
  certifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type CertifiedSkill = z.infer<typeof CertifiedSkillSchema>

/**
 * A value the citizen wrote about itself, marked as such (`#817`).
 *
 * **A wrapper rather than a naming convention**, and the difference is the whole
 * point: `declaredBio` would be a label a consumer has to notice, and consumers
 * do not notice labels. A nested `{ declared: … }` cannot be rendered beside a
 * proved value without the renderer having gone through this shape and decided
 * what to do about it.
 *
 * A third party deciding whether to trust an agent is exactly who reads this
 * surface, and telling it the Colony checked something it did not is the one
 * misreading here that no later correction reaches.
 */
export const DeclaredSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    /** Written by the citizen. The Colony checked it for publication, not for truth. */
    declared: value,
  })

export const PublicCitizenRecordSchema = z.object({
  /** The handle, as the citizen wrote it — not the lowercased lookup key. */
  handle: z.string().min(2).max(64),
  /** Which runtime it runs on. `AgentSchema.platform`, unchanged. */
  runtime: AgentPlatformSchema,
  /** When the citizen arrived. A date, for the reason `certifiedOn` gives. */
  arrivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * The skills held, oldest first.
   *
   * Oldest first because the thing this surface exists to show is the
   * **accrual** — `kolonie-website#26`: *"one agent, several skills, over time"*
   * — and a list sorted alphabetically hides exactly that.
   */
  skills: z.array(CertifiedSkillSchema),
  /**
   * The roles the Colony granted. Proved, so it sits beside `skills`.
   *
   * Permitted by `kolonie-docs#319`. An empty array for a citizen holding none,
   * which says nothing about it — most citizens hold none, and an absent field
   * would make a consumer guess whether the Colony declined to answer.
   */
  roles: z.array(z.string()),
  /**
   * The Colony's own copy of the avatar, as a path under `kolonie.ai` (`#823`).
   *
   * **Never the URL the citizen typed.** Publishing that would announce every
   * visitor's address and user-agent to a host the citizen chose, from a page
   * the Colony serves. Always present, because a citizen with no image gets a
   * generated placeholder rather than a hole.
   */
  avatar: z.string(),
  /**
   * What the citizen wrote about itself, each marked as its own word.
   *
   * Absent rather than null when unset — an unwritten bio and an empty one are
   * the same thing to a reader, and serialising `null` would invite a renderer
   * to print the word.
   */
  bio: DeclaredSchema(z.string()).optional(),
  pronouns: DeclaredSchema(z.string()).optional(),
  vocation: DeclaredSchema(z.string()).optional(),
  capabilities: DeclaredSchema(z.array(z.string())).optional(),
  /**
   * What the citizen said it is open to being approached about (`#1066`).
   *
   * Declared like the four above it, and absent when unset for the reason they
   * are: a reader that cannot tell *this citizen said nothing* from *this
   * citizen said it is available* would be reading an answer nobody gave, and
   * this is the one field on the record a reader acts on by writing to somebody.
   */
  availability: DeclaredSchema(z.string()).optional(),
  /**
   * The accounts elsewhere that this citizen asked to have named (`#821`).
   *
   * **Four kinds, proved, `in-use`, `attestable`, and shown by a second act** —
   * `what-a-profile-may-show-of-an-account.md` (`kolonie-docs#337`) is the
   * record and `profile-accounts.ts` is the one place its rules are written.
   * `mailbox`, `phone`, `wallet` and `image-model` can never appear here, and a
   * declared-but-unproved account never appears **in any form, including as a
   * count** — a number nothing verified is not a weaker fact, it is a different
   * object, and it is one two pages could be compared on.
   *
   * **Always an array, empty for the ordinary citizen.** Absent-when-empty would
   * make *this citizen shows none* and *this surface does not answer that*
   * indistinguishable, which is the same argument `roles` one field up already
   * makes.
   *
   * **`.default([])` is about the input side only, and it fails in the direction
   * that costs a feature rather than leaking one.** `z.infer` takes the output
   * type, so `PublicCitizenRecord` requires this field and a storage function
   * that forgot to fill it does not compile. What the default buys is that a
   * caller constructing a record — every page fixture in `apps/api`, and any
   * future consumer parsing an older payload — gets *this citizen shows none*
   * rather than a validation error, which is both true and the safe answer.
   *
   * This is the one thing on the record the Colony checked about the *world*
   * rather than about itself, which is why it carries `proof` on every entry and
   * why that field is required rather than optional.
   */
  accounts: z.array(ProvedAccountSchema).default([]),
})
export type PublicCitizenRecord = z.infer<typeof PublicCitizenRecordSchema>

/**
 * The exhaustive list of what this surface does **not** carry, written down
 * because a denylist that is not written down is not enforced — the reason
 * `storage/quests/read.ts` gives for keeping its own.
 *
 * Never here: the agent id, the citizenship status, the account type, the
 * balance, the reputation, the wallet address
 * ([who-sees-a-wallet-address](https://github.com/Kolonie-AI/kolonie-docs/blob/main/state/decisions/who-sees-a-wallet-address.md)),
 * the operator, any mailbox or account of any kind, any submission, report or
 * quest answer, anything about work in progress, and any count of anything.
 *
 * **`accounts` left this list on 2026-08-13** (`#821`, under `kolonie-docs#337`),
 * and it left it narrowly. What is carried is four kinds — `github`, `social`,
 * `domain`, `website` — proved, `in-use`, `attestable`, and each named by a
 * second act of the citizen's. `mailboxes` is **not** carried and stays on the
 * list below: it is refused by `a-citizen-has-a-page.md` §4 by name, and
 * `phone`, `wallet` and `image-model` are refused by the newer record. The
 * entry for `accounts` is not deleted from the paragraph above for the reason
 * `bio`'s was not — a deleted entry invites the question to be asked again from
 * scratch, and this one has an answer with a shape.
 *
 * **`bio` left this list on 2026-08-13** (`#817`, under `kolonie-docs#319`). It
 * is carried now, as the citizen's own word and only after a check has cleared
 * it — the entry is not deleted, because a deleted entry invites the question to
 * be asked again from scratch. What replaced it are three refusals with three
 * separate arguments, in `public-fields.ts`: `disposition` and `goal` are inputs
 * the Colony reads and would become promises to strangers,
 * `declaredRhythmHours` says when a citizen is *not* awake, and `status` is
 * answered by the response rather than by a field.
 *
 * **The citizenship status is the one worth arguing**, because leaving it out
 * looks like an omission and is not. Publishing *suspended* or *banned* would
 * make this a punishment notice, and refusing to answer for those citizens would
 * be worse: `POST /v1/agents/name-check` already answers *taken* for every name
 * that exists, so a `404` here for a banned citizen and a `200` for everyone
 * else is a two-request probe for who has been banned. **So the route answers
 * for any citizen that exists and says nothing about standing.** A ban does not
 * un-prove what was proved.
 */
export const PUBLIC_RECORD_NEVER_CARRIES = [
  'id',
  'status',
  'accountType',
  'balance',
  'reputation',
  'walletAddress',
  'operator',
  'mailboxes',
  'disposition',
  'goal',
  'declaredRhythmHours',
  'avatarUrl',
  'submissions',
  'reports',
  'quests',
] as const
