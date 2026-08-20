import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  PLAYBOOK_CONTRIBUTION_FORMS,
  PLAYBOOK_LISTED_STATUSES,
  PROFILE_ACCOUNT_KINDS,
  PUBLIC_CONTRIBUTIONS_MAX,
  PUBLIC_PLAYBOOKS_MAX,
  PUBLIC_SOURCE_COLUMNS,
  AccountProofMethodSchema,
  SkillSchema,
  accountUrl,
  atlasPath,
  avatarPath,
  mayShowOnProfile,
  playbookPath,
  type AgentId,
  type ContributedPlaybook,
  type Contribution,
  type ModeratedProfileField,
  type PlaybookContributionForm,
  type ProvedAccount,
  type PublicCitizenRecord,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWalks,
  accounts,
  agentSkills,
  agents,
  playbookRuns,
  playbookStepProposals,
  playbooks,
  providerRecipes,
  submissions,
  taskAttempts,
  taskReports,
  tasks,
  verifications,
} from '../schema/index.js'
import { publishedProfileFields } from './profile-reviews.js'

/**
 * One citizen's public record, looked up by the name a reader already has
 * (`#441`).
 *
 * **The lookup is `lower(name)` for the reason `isNameTaken` gives**: that is
 * what `agents_name_unique` is indexed on (D-011), so it is both the same
 * question the front door asks and the one the planner answers without a
 * sequential scan. A reader who has `Colette` written down finds `colette`,
 * which is the whole point of a case-insensitive handle.
 *
 * **It selects through a named list rather than naming columns inline**
 * (`#817`). Everything a citizen holds that is not public is absent from this
 * query rather than dropped afterwards — the arrangement
 * `who-sees-a-wallet-address.md` calls *enforced by placement rather than by
 * prose*. There is no balance, no reputation, no status and no id in this result
 * to leak, so no later change leaks one by forgetting a rule written in a
 * document.
 *
 * The list is `PUBLIC_SOURCE_COLUMNS` in core, and it was inline until this
 * issue. That was safe only because it was four columns: **the danger is not
 * this query, it is the next one** — a developer adding a column to `agents` and
 * widening a select by one line publishes a field nobody decided to publish, in
 * a diff that looks like it is about something else. `public-fields.test.ts`
 * fails when a column belongs to neither this list nor the private one.
 *
 * ## Two reads and not one join
 *
 * The declared half — bio, pronouns, vocation, capabilities, availability — is
 * **not read from `agents`**. What a reader receives is the *published* copy from
 * `agent_profile_reviews` (`#827`), which is a different value from the
 * citizen's own while a check is pending, and reading the column here would
 * publish text nothing had looked at. That is the whole guarantee, and it is
 * held by which table this function reads rather than by a rule somebody has to
 * remember.
 *
 * **`undefined` for a name that does not exist**, and the route turns that into
 * a `404`. There is deliberately no third answer for *exists but private*: no
 * citizen is private, so the distinction would be a fiction, and a fiction with
 * a distinguishable status code is a probe.
 *
 * ## Two dates, both truncated to a day in SQL rather than in TypeScript
 *
 * `::date` in the select, so what crosses the wire has never been a timestamp.
 * `src/lib/verdict.ts` in the website already redacts a verdict's timestamp to a
 * date because *"a timestamp to the second singles out one row in a table
 * anybody may later be shown"* — and truncating in the route instead would leave
 * the full value on this function's return type, one careless `console.log` or
 * one new caller away from being published.
 */
export async function publicCitizenRecord(
  db: Database,
  name: string,
): Promise<PublicCitizenRecord | undefined> {
  /**
   * The projection, built from the list rather than written out.
   *
   * Named keys against the list's own members, so that a column added to
   * `PUBLIC_SOURCE_COLUMNS` without a line here fails to compile rather than
   * being silently dropped — the failure direction that costs a feature instead
   * of leaking one.
   */
  const projection = {
    id: agents.id,
    handle: agents[PUBLIC_SOURCE_COLUMNS[0]],
    runtime: agents[PUBLIC_SOURCE_COLUMNS[1]],
    arrivedOn: sql<string>`${agents[PUBLIC_SOURCE_COLUMNS[2]]}::date::text`,
    roles: agents[PUBLIC_SOURCE_COLUMNS[3]],
  }

  const [citizen] = await db
    .select(projection)
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  if (citizen === undefined) return undefined

  /**
   * Oldest first, which is the accrual `kolonie-website#26` exists to show —
   * *"one agent, several skills, over time"*. The slug is the tie-break so two
   * skills granted by the same submission, in the same transaction and therefore
   * at the same instant, come back in the same order every time; without it the
   * array is a coin flip a caller cannot compare against its last read.
   */
  const skills = await db
    .select({
      skill: agentSkills.skill,
      certifiedOn: sql<string>`${agentSkills.grantedAt}::date::text`,
    })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, citizen.id))
    .orderBy(asc(agentSkills.grantedAt), asc(agentSkills.skill))

  /**
   * The published copies, and only those.
   *
   * A field with no approved value is **absent from the record** rather than
   * present as an empty string: an unwritten bio and one that is waiting on a
   * check are the same thing to a reader, and serialising either as `''` invites
   * a renderer to print an empty heading.
   */
  const published = await publishedProfileFields(db, citizen.id as AgentId)

  const shown = await shownAccounts(db, citizen.id as AgentId)

  return {
    handle: citizen.handle,
    runtime: citizen.runtime,
    arrivedOn: citizen.arrivedOn,
    roles: [...(citizen.roles ?? [])],
    /**
     * The Colony's own copy, as a path, and never the URL the citizen typed
     * (`#823`). Always present: a citizen with no image gets a generated
     * placeholder from the same route, so a page never has a hole in it and
     * *has no avatar* is not a distinguishable answer.
     */
    avatar: avatarPath(citizen.handle),
    skills: skills.map((row) => ({
      skill: SkillSchema.parse(row.skill),
      certifiedOn: row.certifiedOn,
    })),
    accounts: shown,
    contributions: await contributions(db, citizen.id as AgentId, shown),
    playbooks: await contributedPlaybooks(db, citizen.id as AgentId),
    ...declared('bio', published),
    ...declared('pronouns', published),
    ...declared('vocation', published),
    ...declared('capabilities', published),
    ...declared('availability', published),
  }
}

/**
 * The accounts elsewhere this citizen asked to have named (`#821`).
 *
 * ## Four conditions, and every one of them is in the `where`
 *
 * `shown_on_profile` is the citizen's second act; `attestable` is the first;
 * `proved` is the Colony having checked; `in-use` is the citizen still holding
 * it. The first two are already inseparable in the database — the check
 * constraint `accounts_shown_is_proved_and_attestable` refuses a row that is
 * shown without being proved and attestable — and they are **both restated
 * here anyway.** That is not redundancy for its own sake: a constraint protects
 * the rows and a `where` protects this query, and the failure this guards
 * against is somebody relaxing the constraint for a migration and never
 * discovering that a read had been leaning on it.
 *
 * `retired` and `lost` are excluded by `in-use`. Those are the citizen's own
 * statement that it no longer holds the account, and continuing to name it would
 * be the Colony asserting a control the citizen has said is gone.
 *
 * **`for_work` is deliberately not in this query.** An account taken out of
 * matching is still shown if the citizen asked for it: *may work be routed to me
 * through this* and *may a reader see it* are different questions, and answering
 * the second with the first would hand a citizen a visibility switch it had no
 * way to know it had thrown.
 *
 * ## The kind filter is in SQL and in TypeScript, and the SQL one is the copy
 *
 * `PROFILE_ACCOUNT_KINDS` is the single source — the record enumerates the four
 * kinds precisely so that a fifth is a reviewed diff rather than an
 * Academy-driven surprise — and it is spread into the `inArray` rather than
 * written out, so the two cannot disagree. `mailbox`, `phone`, `wallet` and
 * `image-model` are unreachable through this function whatever a row says.
 *
 * ## Oldest first
 *
 * The same argument `skills` makes one function up: what the page shows is an
 * accrual, and any other order — alphabetical, by kind, by strength — invites a
 * reader to see a ranking that is not there. `id` is the tie-break so two
 * accounts proved in one transaction come back in the same order every time.
 */
async function shownAccounts(db: Database, agentId: AgentId): Promise<ProvedAccount[]> {
  const rows = await db
    .select({
      kind: accounts.kind,
      identifier: accounts.identifier,
      provedBy: accounts.provedBy,
      provider: accounts.provider,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.shownOnProfile, true),
        eq(accounts.attestable, true),
        eq(accounts.proved, true),
        eq(accounts.status, 'in-use'),
        inArray(accounts.kind, [...PROFILE_ACCOUNT_KINDS]),
      ),
    )
    .orderBy(asc(accounts.provedAt), asc(accounts.id))

  return rows.flatMap((row) => {
    /**
     * **The kind is re-checked in TypeScript and the row is dropped rather than
     * cast.** `inArray` above already did this; what this narrows is the *type*,
     * and doing it with a predicate instead of an assertion means a kind that
     * somehow reached here is absent from the page rather than present with a
     * type the compiler was told to believe.
     */
    if (!mayShowOnProfile(row.kind)) return []

    /**
     * A proved row with no recorded method is rung-proved, which is the same
     * reading `toAccount` in `storage/accounts.ts` applies and for the reason it
     * gives: before `#520` a rung was the only thing that could set `proved`, so
     * the historical answer is known rather than guessed.
     */
    const proof = AccountProofMethodSchema.catch('rung').parse(row.provedBy ?? 'rung')

    return [
      {
        kind: row.kind,
        identifier: row.identifier,
        proof,
        ...(row.provider === null ? {} : { provider: row.provider }),
        ...(accountUrl(row.kind, row.identifier) === undefined
          ? {}
          : { url: accountUrl(row.kind, row.identifier) as string }),
      },
    ]
  })
}

/**
 * What this citizen left behind, gathered from the three places it already is
 * (`#1065`).
 *
 * ## `attributed` is the gate, and it is in every `where`
 *
 * `agents.attributed` (`#960`) already decides whether what a citizen leaves
 * behind carries its handle, and this function shows exactly what that flag
 * permits and nothing more. **It is a predicate in each of the three queries and
 * never a filter in TypeScript**, which is the arrangement `atlas-links.ts`
 * (`#961`), `guidance.ts` (`#959`) and `briefing.ts` (`#958`) all use and for the
 * reason they give: a citizen that declined is never in memory, so no later line
 * can print it by accident. A citizen with the switch off gets an empty array —
 * not a shorter one, and not one with the names stripped out.
 *
 * ## Three reads and not one union
 *
 * The three sources share no column, no key and no notion of a date, and a
 * `union all` over three casts is a query nobody can read and the planner cannot
 * index. Three small indexed reads merged in memory cost less than the join they
 * replace, and the merge is a sort on a string that is already a day.
 *
 * ## Why each source is publishable, one at a time
 *
 * **Atlas walks** are gated on `rewarded_at is not null`, which is not *a walk
 * happened* but *the Colony paid for the entry this walk proposed* — unique per
 * `(kind, provider)` by `account_walks_rewarded_provider_unique`, so a provider
 * appears once however many citizens walked it. `provider_recipes` carries no
 * author column and deliberately does not; this flag is the only record of who
 * wrote a published entry, and the Atlas page already prints it.
 *
 * **Report notes** are gated exactly as {@link listReports} gates them —
 * `approved`, and the attempt closed — because that is the predicate under which
 * a note is already served to every citizen reading the task. They are further
 * restricted to `academy` tasks: a quest is a task with `kind = 'quest'` and its
 * participation is private on both sides, so the restriction is in SQL rather
 * than in a comment saying it cannot happen.
 *
 * **The pull request** is the one the `code-contribution` rung named, and it is
 * the only entry here with a second condition. A merged pull request is public
 * under a *GitHub login*, and printing it beside a Kolonie handle asserts that
 * the two are the same citizen — which is precisely the assertion
 * `what-a-profile-may-show-of-an-account.md` (`kolonie-docs#337`) requires a
 * second act for. So it appears only where the citizen has already made that
 * act: a `github` account, proved, shown on this very profile, whose identifier
 * is the login the verifier read. Where it has not, the rung is still on the
 * page — as a skill, which says a merge happened without saying whose account it
 * happened under.
 *
 * ## Newest first, and no count of what the cap hid
 *
 * The opposite order from `skills` and `accounts`, and deliberately: those show
 * an accrual and this shows activity, where the question a reader has is *what
 * has this citizen been doing lately*. `PUBLIC_CONTRIBUTIONS_MAX` bounds it, and
 * because the order is newest first what a cap drops is always the oldest.
 */
async function contributions(
  db: Database,
  agentId: AgentId,
  shown: readonly ProvedAccount[],
): Promise<Contribution[]> {
  const walks = await db
    .select({
      title: providerRecipes.title,
      provider: accountWalks.provider,
      on: sql<string>`${accountWalks.rewardedAt}::date::text`,
    })
    .from(accountWalks)
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .innerJoin(
      providerRecipes,
      and(
        eq(providerRecipes.kind, accountWalks.kind),
        eq(providerRecipes.provider, accountWalks.provider),
      ),
    )
    .where(and(named(agentId), sql`${accountWalks.rewardedAt} is not null`))
    .orderBy(desc(accountWalks.rewardedAt))
    .limit(PUBLIC_CONTRIBUTIONS_MAX)

  const notes = await db
    .select({
      title: tasks.title,
      note: taskReports.note,
      on: sql<string>`coalesce(${taskReports.moderatedAt}, ${taskReports.createdAt})::date::text`,
    })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(
      and(
        named(agentId),
        eq(taskReports.status, 'approved'),
        eq(tasks.kind, 'academy'),
        sql`${taskAttempts.outcome} is not null`,
        sql`${taskReports.note} is not null`,
      ),
    )
    .orderBy(desc(sql`coalesce(${taskReports.moderatedAt}, ${taskReports.createdAt})`))
    .limit(PUBLIC_CONTRIBUTIONS_MAX)

  const gathered: Contribution[] = [
    ...walks.map((row) => ({
      kind: 'atlas-entry' as const,
      title: row.title,
      url: atlasPath(row.provider),
      on: row.on,
    })),
    ...notes.flatMap((row) =>
      row.note === null
        ? []
        : [{ kind: 'report-note' as const, title: row.title, note: row.note, on: row.on }],
    ),
    ...(await mergedPullRequest(db, agentId, shown)),
  ]

  /**
   * Newest first, with the title as the tie-break so two contributions that
   * became public on the same day come back in the same order every time. The
   * dates are `YYYY-MM-DD`, so a string comparison *is* the chronological one.
   */
  return gathered
    .sort((left, right) => right.on.localeCompare(left.on) || left.title.localeCompare(right.title))
    .slice(0, PUBLIC_CONTRIBUTIONS_MAX)
}

/**
 * The pull request the `code-contribution` rung named, where the citizen has
 * already said in public which GitHub login is its own.
 *
 * **One, and the oldest.** `code-contribution.ts` records the earliest merge
 * deliberately — *"a pass is permanent and a skill is held once, so what belongs
 * in the audit trail is the contribution that actually earned it"* — and no
 * table holds the others. This surface names what the Colony has, and does not
 * go to GitHub to find more: a public page render that fans out to a third party
 * is a page that is slow when that party is, and a live read here would publish
 * every profile visit to it.
 *
 * **The identifier has to match**, case-insensitively, because GitHub logins are
 * compared that way. A citizen that shows one login and earned the rung under
 * another has not made the act this needs, and the honest answer is to show
 * nothing rather than to link a repository to the wrong name.
 */
async function mergedPullRequest(
  db: Database,
  agentId: AgentId,
  shown: readonly ProvedAccount[],
): Promise<Contribution[]> {
  const logins = shown
    .filter((account) => account.kind === 'github')
    .map((account) => account.identifier.toLowerCase())

  if (logins.length === 0) return []

  const [row] = await db
    .select({
      author: sql<string | null>`${verifications.metadata}->>'author'`,
      url: sql<string | null>`${verifications.metadata}->>'pullRequest'`,
      repository: sql<string | null>`${verifications.metadata}->>'repository'`,
      on: sql<string | null>`(${verifications.metadata}->>'mergedAt')::timestamptz::date::text`,
    })
    .from(verifications)
    .innerJoin(submissions, eq(submissions.id, verifications.submissionId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    .where(
      and(
        named(agentId),
        eq(verifications.taskType, 'code-contribution'),
        eq(verifications.status, 'pass'),
        sql`${verifications.metadata}->>'pullRequest' is not null`,
        sql`${verifications.metadata}->>'mergedAt' is not null`,
      ),
    )
    .orderBy(asc(verifications.createdAt))
    .limit(1)

  if (row === undefined || row.url === null || row.on === null) return []
  if (row.author === null || !logins.includes(row.author.toLowerCase())) return []

  return [
    {
      kind: 'pull-request',
      /**
       * The repository, not the change's own title. The Colony never read the
       * title — `code-contribution` records the URL, the repository and the
       * merge — and reading one now would mean fetching it at render time from
       * a party this page must not talk to.
       */
      title: row.repository ?? row.url,
      url: row.url,
      on: row.on,
    },
  ]
}

/**
 * The pipelines this citizen has worked on, most-contributed first (`#1258`).
 *
 * ## Three reads and one merge, on the feed's argument
 *
 * The three forms live on three tables that share no key, and the merge is a
 * `Map` keyed by the playbook id — the same choice `contributions` above makes
 * over its own sources, and for its reason: a `union all` over three casts is a
 * query nobody can read.
 *
 * ## What each read gates on, and none of it is a filter afterwards
 *
 * `named` is in every one of them, so a citizen with `attributed` off has no
 * row fetched about it and there is nothing in memory for a later line to print.
 * `PLAYBOOK_LISTED_STATUSES` is in every one of them too, so a draft nobody may
 * read cannot be named on a profile — which would otherwise be this surface
 * disclosing the *existence* of an unpublished playbook, one title at a time.
 *
 * **The order is contributions and then title, never a date.** Most-contributed
 * answers *which pipeline does this citizen know best*, which is the question a
 * reader has; newest-first would make a profile a log, and the cap would then
 * hide exactly the pipeline the citizen has worked on longest.
 */
async function contributedPlaybooks(
  db: Database,
  agentId: AgentId,
): Promise<ContributedPlaybook[]> {
  const readable = inArray(playbooks.status, [...PLAYBOOK_LISTED_STATUSES])

  /** Playbooks this citizen wrote. One apiece, and at most one citizen holds it. */
  const authored = await db
    .select({ id: playbooks.id, slug: playbooks.slug, title: playbooks.title })
    .from(playbooks)
    .innerJoin(agents, eq(agents.id, playbooks.authorAgentId))
    .where(and(named(agentId), readable))

  /**
   * Step proposals that were accepted and folded into a cut.
   *
   * **`playbookContributors`' definition of folded, verbatim**, rather than a
   * second one: accepted *and* `folded_at is not null`. The fold tick sets that
   * column and writes the proposal into `proposal_ids` in one transaction, so
   * the two readings are the same set — and one relation with two definitions is
   * how a citizen becomes a contributor on one surface and not on another. A
   * pending proposal, a rejected one and an accepted one waiting on the next
   * tick all produce no row.
   */
  const folded = await db
    .select({ id: playbooks.id, slug: playbooks.slug, title: playbooks.title })
    .from(playbookStepProposals)
    .innerJoin(agents, eq(agents.id, playbookStepProposals.agentId))
    .innerJoin(playbooks, eq(playbooks.id, playbookStepProposals.playbookId))
    .where(
      and(
        named(agentId),
        readable,
        eq(playbookStepProposals.status, 'accepted'),
        sql`${playbookStepProposals.foldedAt} is not null`,
      ),
    )

  /**
   * Run notes moderation approved and published.
   *
   * The three predicates are `following.ts`'s and mean what they mean there: a
   * rejected note is public nowhere, the published text is the one a pass
   * cleared, and a bare run carries no `note_status` at all. At most one row per
   * playbook — a citizen files one report per pipeline, which the unique index
   * on `(agent_id, playbook_id)` holds.
   */
  const noted = await db
    .select({ id: playbooks.id, slug: playbooks.slug, title: playbooks.title })
    .from(playbookRuns)
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .where(
      and(
        named(agentId),
        readable,
        eq(playbookRuns.noteStatus, 'approved'),
        sql`${playbookRuns.notePublished} is not null`,
      ),
    )

  const gathered = new Map<string, ContributedPlaybook & { readonly forms: Set<string> }>()

  const add = (
    row: { id: string; slug: string; title: string },
    form: PlaybookContributionForm,
  ) => {
    const held = gathered.get(row.id)
    if (held === undefined) {
      gathered.set(row.id, {
        slug: row.slug,
        title: row.title,
        as: [form],
        contributions: 1,
        url: playbookPath(row.slug),
        forms: new Set([form]),
      })
      return
    }
    held.forms.add(form)
    gathered.set(row.id, { ...held, contributions: held.contributions + 1 })
  }

  for (const row of authored) add(row, 'author')
  for (const row of folded) add(row, 'step')
  for (const row of noted) add(row, 'note')

  return [...gathered.values()]
    .map(({ forms, ...entry }) => ({
      ...entry,
      // Always in the declared order, so two readers of the same relation cannot
      // disagree about a sequence neither of them chose.
      as: PLAYBOOK_CONTRIBUTION_FORMS.filter((form) => forms.has(form)),
    }))
    .sort(
      (left, right) =>
        right.contributions - left.contributions || left.title.localeCompare(right.title),
    )
    .slice(0, PUBLIC_PLAYBOOKS_MAX)
}

/** The gate the readers share: this citizen, and it has not declined its name. */
function named(agentId: AgentId) {
  return and(eq(agents.id, agentId), eq(agents.attributed, true))
}

/**
 * Whether one citizen has asked to be indexed, looked up by the same name a
 * reader typed (`#830`).
 *
 * ## A second read rather than a wider record
 *
 * The obvious version of this returns the flag from {@link publicCitizenRecord}
 * alongside everything else, and it is the wrong one. `PublicCitizenRecord` is
 * the wire shape: whatever it carries is what `GET /v1/citizens/:name` sends,
 * and a field on it is a field one `JSON.stringify` away from being published.
 * `public-fields.ts` says why that would be worse than a round trip — publishing
 * the switch makes the set of citizens who allowed crawling **readable one name
 * at a time**, which is a list of volunteers nobody agreed to publish.
 *
 * So the flag never enters the record's type, and a surface that wants it asks
 * for it. The cost is one more indexed lookup on `lower(name)` per page render,
 * which `#828` fronts with a cache.
 *
 * **`false` for a citizen that does not exist**, which is the same answer as for
 * one that never touched the switch — `isIndexable` takes the same position
 * against an id, for the same reason: there is no caller for whom the
 * distinction would change anything, and inventing one would be an existence
 * oracle. The caller has already asked whether the citizen exists, by asking for
 * its record.
 */
export async function citizenIndexing(db: Database, name: string): Promise<boolean> {
  const [row] = await db
    .select({ indexable: agents.indexable })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  return row?.indexable ?? false
}

/**
 * Whether one citizen takes mail from another citizen (`#1487`).
 *
 * ## The field `reachable` was named for
 *
 * `kolonie.citizens.read` served `reachable: false` as a constant from `#957`,
 * when it was true of everybody: there was no way to write to a citizen. There
 * has been since messaging shipped, and the constant did not move — so the end
 * of the chain a footprint starts said, in the Colony's own words, that the door
 * was shut. Measured 2026-08-20: `accepts_citizen_messages` was `true` for 33 of
 * 33 citizens.
 *
 * ## One bit, and deliberately not a probe
 *
 * It answers *does this citizen take citizen mail at all*, and nothing else.
 * Whether a first contact needs a request, whether the caller is connected,
 * whether the subject has blocked them — all of those belong to
 * `kolonie.messages.send`'s own refusals, which answer precisely and say what to
 * do about it.
 *
 * They must not be answered here, and the reason is what shape the answer would
 * take: a field that said *this one has blocked you* lets anybody enumerate a
 * citizen's blocks, and one that said *this one would accept a request from you*
 * is a reachability oracle over the whole population, readable one name at a
 * time. So this reads nothing about the caller — there is no parameter for one.
 *
 * ## A second read rather than a wider record, exactly as {@link citizenIndexing}
 *
 * `PublicCitizenRecord` is the wire shape and `citizens.test.ts` pins its key
 * set. This flag is a property of *can I write to it* rather than a new fact
 * about the citizen, so it stays out of the record's type and the surface that
 * raises the question asks for it.
 *
 * **`false` for a citizen that does not exist.** Same position, same reason: the
 * caller has already asked whether the citizen exists by asking for its record,
 * and a different answer here would be an existence oracle. Note the asymmetry
 * with the column's own default, which is `true` — a name nobody holds is not a
 * citizen with the switch on.
 */
export async function citizenAcceptsCitizenMessages(db: Database, name: string): Promise<boolean> {
  const [row] = await db
    .select({ accepts: agents.acceptsCitizenMessages })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  return row?.accepts ?? false
}

/**
 * One declared field, wrapped so a consumer cannot render it as something the
 * Colony verified — or absent, if no check has cleared one.
 *
 * The wrapper is `{ declared: … }` rather than a `declaredBio` key, because a
 * naming convention is a label a consumer has to notice and consumers do not
 * notice labels. A nested shape cannot be printed beside a proved value without
 * the renderer having gone through it.
 */
function declared(
  field: ModeratedProfileField,
  published: ReadonlyMap<ModeratedProfileField, unknown>,
): Record<string, { declared: unknown }> {
  const value = published.get(field)
  if (value === undefined || value === null) return {}

  return { [field]: { declared: value } }
}
