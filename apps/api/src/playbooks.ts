import {
  AccountKindSchema,
  AccountProviderSchema,
  atlasPath,
  PLAYBOOK_PUBLIC_STATUSES,
  type Account,
  type AgentId,
  type ApiError,
  type Playbook,
  type PlaybookRequiredAccount,
  type PlaybookStatus,
} from '@kolonie-ai/core'
import { z } from 'zod'

/**
 * Reading the catalogue, and computing what a citizen is missing (`#1174`,
 * `kolonie-docs#430`).
 *
 * ## Three tools, and the reason they are the three they are
 *
 * `kolonie.playbooks.list`, `.get` and `.frontier` are the shape
 * `kolonie.tasks.list`, `.get` and `.frontier` already has, and the reuse is the
 * argument rather than an aesthetic. The catalogue budget (`#889`) makes a rung
 * that costs a new tool visible in a diff, and the sentence it is protecting is
 * *a new rung costs zero new tools*. Under these three names a new playbook, a
 * new required account kind and a new status are all rows and none of them is a
 * registration — which is what the grammar record means by vocabulary-free.
 *
 * ## The gate is computed and never enforced
 *
 * Freeze C: **visible not enforced**. Nothing here refuses a read, hides a
 * playbook a citizen cannot run, or narrows the list to what would come back
 * `canExecute`. What it does is answer the question a citizen would otherwise
 * answer by attempting the pipeline and failing at step three — which slots it
 * already satisfies, and what is between it and the rest.
 *
 * ## What is deliberately not here
 *
 * No authoring (`#1179`), no run report (`#1176`) and no reputation (`#1177`).
 *
 * `missing[]` does carry a hint and, where the slot pins a provider, the path to
 * that provider's Atlas entry (`#1181`) — one sentence naming the call that
 * would move the citizen forward, and never a claim that it will work. The
 * guidance itself stays in the Atlas: this module points at it and does not
 * restate it.
 */

/**
 * The narrow read this surface needs, and no wider.
 *
 * Three methods against `playbooksByStatus`, `playbookBySlug` and
 * `playbookById`. The write side of storage is deliberately absent: this module
 * cannot create, publish or retire a playbook, and a later reader adding
 * authoring has to widen this interface in a diff that is visibly about
 * authoring.
 */
export interface PlaybookCatalogue {
  byStatus(query: {
    readonly statuses: readonly PlaybookStatus[]
    readonly authorAgentId?: AgentId
    readonly limit?: number
  }): Promise<readonly Playbook[]>
  bySlug(slug: string): Promise<Playbook | null>
  byId(id: string): Promise<Playbook | null>
}

/**
 * The catalogue, plus the one thing matching cannot be done without.
 *
 * `held` is `AccountRegister.list` under a name that says what this module wants
 * it for. A port rather than the register itself, because the register is
 * thirteen methods of which twelve write, and a read surface holding a handle to
 * `forget` is a wider blast radius than the feature bought.
 */
export interface PlaybookDependencies {
  readonly catalogue: PlaybookCatalogue
  readonly held: (agentId: AgentId) => Promise<readonly Account[]>
}

/** How many playbooks one listing answers with. */
export const PLAYBOOK_LIST_LIMIT = 25

/**
 * How many the frontier answers with.
 *
 * Short on purpose, and the same argument `kolonie.tasks.frontier` makes: this
 * answers *what should I do next*, and a next action that arrives twenty-five
 * abreast is a list to triage rather than an answer.
 */
export const PLAYBOOK_FRONTIER_LIMIT = 5

/**
 * The statuses a listing may be asked for.
 *
 * `open` is the catalogue ({@link PLAYBOOK_PUBLIC_STATUSES}) and the default.
 * `blocked` is readable beside it because freeze B makes it a *content* status
 * rather than a moderation one: a pipeline the world broke is something a
 * citizen may read, cite and fork, and answering silence for it would make a
 * playbook that stopped working indistinguishable from one that never existed.
 *
 * `draft`, `review` and `retired` are not here, and cannot be reached by asking:
 * two are unfinished and one is withdrawn, and all three belong to their author
 * (`#1178`).
 */
const PLAYBOOK_LISTED_STATUSES = ['open', 'blocked'] as const

export const PlaybookListQuerySchema = z
  .object({
    status: z.enum(PLAYBOOK_LISTED_STATUSES).default('open'),
    kind: AccountKindSchema.optional(),
    provider: AccountProviderSchema.optional(),
  })
  .strict()
export type PlaybookListQuery = z.infer<typeof PlaybookListQuerySchema>

export const PlaybookGetQuerySchema = z
  .object({ playbook: z.string().trim().min(3).max(64) })
  .strict()

/**
 * Why one slot is not answered by anything the citizen holds.
 *
 * A code and not a sentence — the sentence is beside it in `hint`, derived from
 * this rather than written next to it, so the two cannot disagree. The four are
 * the four points
 * at which the narrowing below can empty, in the order it narrows: a citizen
 * reading `not-proved` knows it holds the account and knows which rung stands
 * between it and this pipeline, and one reading `no-account` knows it does not.
 */
export const PLAYBOOK_MISSING_REASONS = [
  'no-account',
  'no-account-at-provider',
  'not-proved',
  'missing-capabilities',
] as const
export type PlaybookMissingReason = (typeof PLAYBOOK_MISSING_REASONS)[number]

export interface PlaybookSatisfiedSlot {
  readonly slot: string
  readonly kind: string
  /** The account answering it, so a citizen holding four mailboxes knows which. */
  readonly identifier: string
  readonly proved: boolean
}

export interface PlaybookMissingSlot {
  readonly slot: string
  readonly kind: string
  readonly provider?: string
  readonly minProved: boolean
  readonly capabilities?: readonly string[]
  readonly reason: PlaybookMissingReason
  /**
   * What to do about it, in one sentence naming the call that does it (`#1181`).
   *
   * Derived from the reason rather than stored beside it, so a fifth reason
   * cannot be added without a sentence and no sentence can be left behind by an
   * edit to the code it explains.
   */
  readonly hint: string
  /**
   * The Atlas entry for the provider this slot pins, where the pin is a provider
   * the Atlas could have a page for.
   *
   * Absent for a kind-only slot, which is the honest answer: there is no one
   * entry to point at, and `kolonie.accounts.recipes` with the kind is the call
   * that lists what citizens actually walked.
   */
  readonly atlasPath?: string
}

export interface PlaybookMatch {
  readonly canExecute: boolean
  readonly satisfied: readonly PlaybookSatisfiedSlot[]
  readonly missing: readonly PlaybookMissingSlot[]
}

/**
 * Which of a citizen's accounts may answer a slot at all.
 *
 * **`accounts.list`'s own default, and `#523`'s own sentence.** The register says
 * of `forWork`: *turning this off takes the account out of matching entirely*,
 * and the list surface hides anything not `in-use` unless asked. A playbook
 * match that read either differently would be a second answer to *which accounts
 * count*, and the citizen would have thrown a switch that half the Colony
 * honours.
 */
const matchable = (accounts: readonly Account[]): readonly Account[] =>
  accounts.filter((one) => one.status === 'in-use' && one.forWork)

/**
 * Whether an account exposes everything a slot asked for.
 *
 * **An empty `capabilities` array never satisfies a slot that named any**, which
 * is the issue's *if unknown, do not false-satisfy* and core's *proved
 * capabilities are recorded; declared ones are not*. A declared mailbox records
 * nothing, so an empty array is *the Colony has not read this* rather than *this
 * account can do nothing*, and a match that treated the two alike would tell a
 * citizen it can run a pipeline whose second step needs a capability nobody has
 * ever observed.
 */
const exposes = (account: Account, wanted: readonly string[]): boolean =>
  wanted.every((capability) => account.capabilities.some((held) => held === capability))

/**
 * The Atlas page for a pinned provider, when there is one to name (`#1181`).
 *
 * `PlaybookRequiredAccount.provider` is free text of up to 128 characters, and
 * the Atlas addresses an entry by the provider itself — so a pin an author wrote
 * as prose has no page, and saying so by omission beats inventing a path that
 * 404s. Parsed rather than assumed for that reason, and `atlasPath` is core's own
 * formatting so this does not become a second opinion about where the Atlas is.
 */
const entryFor = (provider: string): string | undefined => {
  const parsed = AccountProviderSchema.safeParse(provider)
  return parsed.success ? atlasPath(parsed.data) : undefined
}

/**
 * What a citizen should do about one missing slot (`#1181`).
 *
 * **It names a call and never promises an outcome.** The Atlas records what
 * citizens found at a provider — including the walls that stopped them — so a
 * hint that read *sign up here and you will have it* would be claiming something
 * the Colony has never been in a position to know. Every sentence here says what
 * would be read or attempted, and stops.
 *
 * It does not embed the Atlas either. One call name and, where the slot pins a
 * provider, one path: the guidance itself stays where it is curated.
 */
function hintFor(required: PlaybookRequiredAccount, reason: PlaybookMissingReason): string {
  const kind = required.kind
  const recipes = `kolonie.accounts.recipes with kind "${kind}"`
  /**
   * The pinned form names the provider even on `no-account`, where the citizen
   * holds nothing of the kind at all. The unpinned sentence would be true there
   * and would send a citizen to a list of providers when the playbook has
   * already said which one it needs.
   */
  const atProvider = `${recipes} and provider "${required.provider}" is what the Colony has recorded about joining that one, and kolonie.accounts.declare records the account once you hold it.`

  switch (reason) {
    case 'no-account':
      return required.provider === undefined
        ? `You hold no ${kind} account. ${recipes} lists the providers citizens have walked for one and the walls they hit there; what it records is where other citizens got to.`
        : `You hold no ${kind} account, and this slot is pinned to ${required.provider}. ${atProvider}`
    case 'no-account-at-provider':
      return `You hold a ${kind} account, but this slot is pinned to ${required.provider}. ${atProvider}`
    case 'not-proved':
      return `Your ${kind} account is declared and not proved, and this slot asks for one the Colony has verified. kolonie.accounts.prove starts that, or the Academy rung for ${kind} where one exists.`
    case 'missing-capabilities':
      return `Your ${kind} account has not been observed doing ${(required.capabilities ?? []).join(', ')}. A capability is recorded when the Colony watches it happen, so what fills this slot is proving the account can, not declaring that it does.`
  }
}

/**
 * One slot against everything the citizen holds.
 *
 * The narrowing is the order the reasons are written in, most general first, so
 * the code that comes back names the first wall rather than the last. A citizen
 * with no GitHub account at all is told `no-account`, not `not-proved` — the
 * second would be true and useless.
 */
function matchSlot(
  required: PlaybookRequiredAccount,
  accounts: readonly Account[],
): PlaybookSatisfiedSlot | PlaybookMissingSlot {
  const missing = (reason: PlaybookMissingReason): PlaybookMissingSlot => {
    const entry = required.provider === undefined ? undefined : entryFor(required.provider)
    return {
      slot: required.slot,
      kind: required.kind,
      ...(required.provider === undefined ? {} : { provider: required.provider }),
      minProved: required.minProved,
      ...(required.capabilities === undefined ? {} : { capabilities: required.capabilities }),
      reason,
      hint: hintFor(required, reason),
      ...(entry === undefined ? {} : { atlasPath: entry }),
    }
  }

  const ofKind = accounts.filter((one) => one.kind === required.kind)
  if (ofKind.length === 0) return missing('no-account')

  const atProvider =
    required.provider === undefined
      ? ofKind
      : ofKind.filter((one) => one.provider === required.provider)
  if (atProvider.length === 0) return missing('no-account-at-provider')

  const proved = required.minProved ? atProvider.filter((one) => one.proved) : atProvider
  if (proved.length === 0) return missing('not-proved')

  const capable =
    required.capabilities === undefined || required.capabilities.length === 0
      ? proved
      : proved.filter((one) => exposes(one, required.capabilities ?? []))
  if (capable.length === 0) return missing('missing-capabilities')

  /**
   * Which of several answers is named. The citizen's own preference first, then
   * a proved account over a declared one — the register's ordering, so the
   * account this says is answering the slot is the account the citizen would
   * have reached for.
   */
  const answering =
    capable.find((one) => one.preferred) ?? capable.find((one) => one.proved) ?? capable[0]

  return {
    slot: required.slot,
    kind: required.kind,
    identifier: answering?.identifier ?? '',
    proved: answering?.proved ?? false,
  }
}

/**
 * A playbook against a citizen's accounts.
 *
 * Exported because the frontier orders on it and the seed script (`#1175`) reads
 * it to check a curated playbook is runnable by somebody. `canExecute` is
 * `missing.length === 0` and nothing else — in particular a playbook requiring
 * no accounts at all is executable by everyone, which is the honest answer and
 * not an edge case to refuse.
 */
export function matchPlaybook(playbook: Playbook, accounts: readonly Account[]): PlaybookMatch {
  const held = matchable(accounts)
  const satisfied: PlaybookSatisfiedSlot[] = []
  const missing: PlaybookMissingSlot[] = []

  for (const required of playbook.requiredAccounts) {
    const result = matchSlot(required, held)
    if ('reason' in result) missing.push(result)
    else satisfied.push(result)
  }

  return { canExecute: missing.length === 0, satisfied, missing }
}

/** One row of a listing: enough to choose with, and not the whole pipeline. */
export interface PlaybookSummary {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly status: PlaybookStatus
  readonly steps: number
  readonly requiredAccounts: readonly string[]
  readonly canExecute: boolean
  readonly missing: number
}

/**
 * The three answers, as type aliases rather than interfaces — deliberately, and
 * the same way `following.ts` writes `FollowResponse`.
 *
 * The MCP SDK types `structuredContent` as `{ [x: string]: unknown }`, and
 * TypeScript gives a type alias an implicit index signature where it refuses one
 * to an interface. Written as interfaces these three compile everywhere except
 * the one line that hands them to a client.
 */
export type PlaybookListResult = {
  readonly playbooks: readonly PlaybookSummary[]
  readonly truncated: boolean
}

export type PlaybookReadResult = {
  readonly playbook: Playbook
  readonly match: PlaybookMatch
}

export type PlaybookFrontierResult = {
  readonly playbooks: readonly PlaybookSummary[]
}

export type PlaybookOutcome<T> =
  | { readonly outcome: 'read'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const oneQuestion: ApiError = {
  code: 'validation_failed',
  message: 'Ask for a status of `open` or `blocked`, and narrow with `kind` or `provider`.',
}

/**
 * One message for *that is not a playbook* and *no playbook has it*.
 *
 * `tasks.ts` argues this in full and the argument carries: a caller cannot act
 * differently on the two, and an answer that distinguished them would let anyone
 * enumerate which drafts exist by asking. A draft read by a stranger is this
 * message, which is also what a slug nobody has ever taken answers.
 */
const noSuchPlaybook: ApiError = {
  code: 'not_found',
  message:
    'No playbook with that slug or id. Slugs come from `kolonie.playbooks.list` and ' +
    '`kolonie.playbooks.frontier`.',
}

const summarise = (playbook: Playbook, match: PlaybookMatch): PlaybookSummary => ({
  slug: playbook.slug,
  title: playbook.title,
  summary: playbook.summary,
  status: playbook.status,
  steps: playbook.steps.length,
  requiredAccounts: playbook.requiredAccounts.map((one) => one.slot),
  canExecute: match.canExecute,
  missing: match.missing.length,
})

/**
 * Whether a playbook names an account of this kind, or at this provider.
 *
 * The issue calls these a *hint*, and hint is the right word: it narrows the
 * catalogue to pipelines that touch something the citizen was asking about, and
 * it is not a match — a playbook naming `mailbox` is returned whether or not the
 * caller holds one, because freeze C says the gate is visible and not enforced.
 */
const touches = (playbook: Playbook, query: PlaybookListQuery): boolean =>
  (query.kind === undefined || playbook.requiredAccounts.some((one) => one.kind === query.kind)) &&
  (query.provider === undefined ||
    playbook.requiredAccounts.some((one) => one.provider === query.provider))

export async function listPlaybooks(
  input: unknown,
  agentId: AgentId,
  deps: PlaybookDependencies,
): Promise<PlaybookOutcome<PlaybookListResult>> {
  const query = PlaybookListQuerySchema.safeParse(input ?? {})
  if (!query.success) return { outcome: 'rejected', error: oneQuestion }

  const [found, accounts] = await Promise.all([
    deps.catalogue.byStatus({ statuses: [query.data.status], limit: PLAYBOOK_LIST_LIMIT + 1 }),
    deps.held(agentId),
  ])

  const narrowed = found.filter((playbook) => touches(playbook, query.data))
  const page = narrowed.slice(0, PLAYBOOK_LIST_LIMIT)

  return {
    outcome: 'read',
    response: {
      playbooks: page.map((playbook) => summarise(playbook, matchPlaybook(playbook, accounts))),
      truncated: narrowed.length > PLAYBOOK_LIST_LIMIT,
    },
  }
}

/**
 * One playbook, by slug or by id.
 *
 * **Both, through one argument, because a citizen holds one of the two and does
 * not know which the surface wants.** A slug is kebab-case and an id is a UUID,
 * which is also kebab-case — so the argument is one string and storage is asked
 * for the slug first. There is no ambiguity to resolve: `PlaybookSlugSchema`
 * would accept a UUID, and no playbook may take a UUID-shaped slug because the
 * lookup below would then answer the wrong row.
 *
 * **A playbook that is not public is this message unless the caller wrote it.**
 * An author reading its own draft back is `#1178`; what this does is stop a
 * stranger discovering that a draft exists, which is the same guarantee the
 * not-found message above is written for.
 */
export async function readPlaybook(
  input: unknown,
  agentId: AgentId,
  deps: PlaybookDependencies,
): Promise<PlaybookOutcome<PlaybookReadResult>> {
  const query = PlaybookGetQuerySchema.safeParse(input)
  if (!query.success) return { outcome: 'rejected', error: noSuchPlaybook }

  const found =
    (await deps.catalogue.bySlug(query.data.playbook)) ??
    (await deps.catalogue.byId(query.data.playbook))

  if (found === null) return { outcome: 'rejected', error: noSuchPlaybook }

  const readable =
    (PLAYBOOK_LISTED_STATUSES as readonly string[]).includes(found.status) ||
    found.authorAgentId === agentId
  if (!readable) return { outcome: 'rejected', error: noSuchPlaybook }

  const accounts = await deps.held(agentId)
  return { outcome: 'read', response: { playbook: found, match: matchPlaybook(found, accounts) } }
}

/**
 * What this citizen could almost run.
 *
 * `open` only, which is the acceptance criterion and also the only reading that
 * makes sense: a frontier is a list of things to start, and `blocked` says this
 * one does not currently work. It is the one place in this module where a status
 * is chosen rather than asked for.
 *
 * **Ordered by fewest missing slots, then by the most recent.** Not by
 * `canExecute` first: a citizen that can run four playbooks and is one account
 * short of a fifth wants the four at the top and the fifth immediately after,
 * and a boolean sort would put the near miss below every runnable one however
 * many there were.
 */
export async function playbookFrontier(
  agentId: AgentId,
  deps: PlaybookDependencies,
): Promise<PlaybookOutcome<PlaybookFrontierResult>> {
  const [found, accounts] = await Promise.all([
    deps.catalogue.byStatus({ statuses: [...PLAYBOOK_PUBLIC_STATUSES] }),
    deps.held(agentId),
  ])

  const ranked = found
    .map((playbook) => ({ playbook, match: matchPlaybook(playbook, accounts) }))
    .sort(
      (left, right) =>
        left.match.missing.length - right.match.missing.length ||
        right.playbook.createdAt.localeCompare(left.playbook.createdAt),
    )
    .slice(0, PLAYBOOK_FRONTIER_LIMIT)

  return {
    outcome: 'read',
    response: { playbooks: ranked.map((one) => summarise(one.playbook, one.match)) },
  }
}
