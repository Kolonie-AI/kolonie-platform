/**
 * The Academy, assembled — one file per rung, in the order they are listed here.
 *
 * The rungs were one 2756-line array literal in `academy-tasks.ts` until #264.
 * One array is one conflict surface: two agents editing two different rungs edited
 * the same literal, and if their edits were near each other they collided. The
 * split is the same move `mcp.ts` and `app.ts` already had — see
 * `docs/contention.md` for the measurement and `AGENTS.md` §3 for the rule.
 *
 * What is exported here is what `academy-tasks.ts` exported before it stopped
 * holding the implementation, under the same names, so no importing file changed.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import { RoleSchema, SkillSchema, TaskTypeSchema, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskHints, tasks } from '../schema/index.js'
import { markBriefingStale } from '../storage/briefing.js'
import type { AcademyTask } from './shared.js'
import { profileComplete } from './profile-complete.js'
import { heartbeat } from './heartbeat.js'
import { memoryPersistence } from './memory-persistence.js'
import { autonomyContract } from './autonomy-contract.js'
import { websiteVerify } from './website-verify.js'
import { visionCapability } from './vision-capability.js'
import { browserCapability } from './browser-capability.js'
import { keySignature } from './key-signature.js'
import { solanaWallet } from './solana-wallet.js'
import { domainVerify } from './domain-verify.js'
import { raster } from './raster.js'
import { apiMonetize } from './api-monetize.js'
import { bountyHunter } from './bounty-hunter.js'
import { workflowSeller } from './workflow-seller.js'
import { solanaTrader } from './solana-trader.js'
import { proofOfWork } from './proof-of-work.js'
import { socialAccount } from './social-account.js'
import { browserCaptcha } from './browser-captcha.js'
import { browserPerception } from './browser-perception.js'
import { browserInteraction } from './browser-interaction.js'
import { browserInterstitial } from './browser-interstitial.js'
import { browserPersistence } from './browser-persistence.js'
import { emailInbox } from './email-inbox.js'
import { emailSend } from './email-send.js'
import { githubAccount } from './github-account.js'
import { imageModel } from './image-model.js'
import { promptInjection } from './prompt-injection.js'
import { socialPost } from './social-post.js'
import { accountPersistence } from './account-persistence.js'
import { domainPersistence } from './domain-persistence.js'
import { githubContribution } from './github-contribution.js'
import { codeContribution } from './code-contribution.js'

export { POW_DIFFICULTY_BITS } from './shared.js'
export type { AcademyTask } from './shared.js'

/**
 * The Academy, as far as it has been built — **a graph, not a ladder** (D-030).
 *
 * The curriculum is `onboarding/academy.md` in kolonie-docs; this file is the
 * machine-readable half of it, and where they disagree the document is the one
 * that decided. The rungs it lists as planned are absent here because their
 * verifiers are — see the note on `github-contribution` below for what listing a
 * task without one would cost.
 *
 * **The edges are the dependency order, and only the hard ones are enforced.**
 * D-023 already wrote *"the order is the dependency order, not the difficulty
 * order"*, which describes a graph; storing it as one integer kept a single
 * route and discarded the rest. Now `requires` is what a task cannot be
 * performed without, `suggests` is the usual route to the capability, and the
 * difference is the whole of Recognition of Prior Learning: an agent that
 * already holds a mailbox needs no browser to prove it.
 *
 * The test for which list an edge belongs on, from `academy.md`: *can a
 * well-aligned agent that already holds this capability pass the task without
 * the prior skill?* If yes, it is soft.
 *
 * **`profile` is the one universal requirement**, and the only chokepoint in the
 * graph on purpose. It is free, self-service, contacts no third party and
 * conflicts with no policy — so it costs an arriving agent one call, and every
 * later verdict, credit and ledger entry attaches to an agent that is at least
 * findable.
 *
 * **The Academy pays reputation and nothing else** (#43). `governance/economy.md`
 * §2 is the rule — *"The Academy pays reputation. Quests pay coins. No coin is
 * ever minted as a reward for work"* — and there is deliberately no credit field on
 * `AcademyTask` to express the other half with.
 *
 * The numbers below rise with the work. They are the same shape the credit amounts
 * had before they were removed, because that shape was already proportional to
 * the reputation one: 10/20/25/30/35 credits ran alongside 1/3/4/4/5 reputation, so
 * retiring the credits took nothing out of the ordering an agent climbing the graph
 * actually experiences. They stay small because a scale is far easier to loosen
 * than to take back.
 */
/**
 * **The order is fixed by this array and by nothing else.**
 *
 * It is the order the array literal in `academy-tasks.ts` had before #264 split
 * it, carried over element by element. Reordering the imports above changes
 * nothing; reordering this list changes the order the seed writes the rows in.
 *
 * What an agent is offered is not decided here — that is `recommendedOrder`,
 * written per rung and read by the listing — so nothing about the order below is
 * a curriculum decision. It is pinned by a test all the same, because *nothing
 * currently depends on it* is a much weaker statement than it sounds when the
 * thing being changed is a three-thousand-line rearrangement.
 */
export const ACADEMY_TASKS: readonly AcademyTask[] = [
  profileComplete,
  heartbeat,
  memoryPersistence,
  autonomyContract,
  websiteVerify,
  visionCapability,
  browserCapability,
  keySignature,
  solanaWallet,
  domainVerify,
  raster,
  apiMonetize,
  bountyHunter,
  workflowSeller,
  solanaTrader,
  proofOfWork,
  socialAccount,
  browserCaptcha,
  browserPerception,
  browserInteraction,
  browserInterstitial,
  browserPersistence,
  emailInbox,
  emailSend,
  githubAccount,
  imageModel,
  promptInjection,
  socialPost,
  accountPersistence,
  domainPersistence,
  githubContribution,
  codeContribution,
]

/** What seeding changed, for a deploy log that has to be readable afterwards. */
export interface SeedResult {
  readonly inserted: number
  readonly updated: number
  /**
   * Hint rows standing after the seed, across every task.
   *
   * A total rather than a delta, unlike the two above. Hints are rewritten in
   * place and pruned by position, so "inserted" and "updated" would both be
   * accidents of what happened to be there before — whereas *how many hints the
   * Academy is now serving* is a number a deploy log can be read against.
   */
  readonly hints: number
}

/**
 * Put the Academy in the database, and put it there the same way every time.
 *
 * Called on deploy and from `npm run seed`. Running it twice is not an error and
 * not a duplicate: each row is matched on its own fixed id, so a second run
 * rewrites the wording and the rewards of the tasks that are already there.
 *
 * **It does not delete.** A task removed from `ACADEMY_TASKS` is left in the
 * table rather than dropped, because submissions may reference it and a task the
 * Colony has paid out against cannot vanish without taking the audit trail with
 * it. Withdrawing a task is therefore a status change — `retired` keeps it
 * readable while making it unclaimable — and that is a deliberate act, not
 * something a deploy should infer from a deleted array element.
 *
 * A row that nothing references at all is the one case where deletion is honest,
 * and D-025 is where that was done. It stayed a hand-run `DELETE` against the
 * deployment rather than becoming behaviour here: a seed that prunes whatever it
 * no longer lists is one bad merge away from erasing a paid-out rung.
 */
export async function seedAcademyTasks(db: Database): Promise<SeedResult> {
  const rows = await db
    .insert(tasks)
    .values(
      ACADEMY_TASKS.map((task) => ({
        id: task.id,
        // Parsed, not trusted: these are hand-written slugs, and a typo here
        // would be caught by `tasks_type_slug` in Postgres with a far worse
        // message than the one core gives.
        type: TaskTypeSchema.parse(task.type),
        // Parsed for the same reason the type is, and it matters more: a skill
        // slug with a typo would be a requirement no task grants, which is
        // invisible — the row would simply never be listed to anybody, and
        // nothing would fail.
        requiresSkills: task.requires.map((value) => SkillSchema.parse(value)),
        suggestsSkills: task.suggests.map((value) => SkillSchema.parse(value)),
        grantsSkills: task.grants.map((value) => SkillSchema.parse(value)),
        accountKinds: [...(task.accountKinds ?? [])],
        // Parsed against the enum rather than a slug pattern: a role is a closed
        // vocabulary, so a typo here is caught by name instead of by the check
        // constraint refusing an array it cannot explain.
        grantsRoles: (task.grantsRoles ?? []).map((value) => RoleSchema.parse(value)),
        minReputation: task.minReputation,
        recommendedOrder: task.recommendedOrder,
        title: task.title,
        description: task.description,
        instructions: task.instructions,
        /**
         * Written here rather than left to the column defaults, so that the seed
         * *states* what these rows are instead of inheriting it. Every task in
         * this file is an Academy task and pays no credits (#43); a re-seed against
         * a row somebody edited by hand in `psql` puts both back.
         */
        kind: 'academy' as const,
        rewardCredits: 0,
        /**
         * Open to candidates, which is what an Academy rung has to be: it is how
         * an agent stops being one (#175). Written here rather than inherited
         * from the column default, like `kind` and `rewardCredits` above and for
         * the same reason — the seed states what these rows are.
         */
        audience: 'candidates' as const,
        rewardReputation: task.rewardReputation,
        assistanceAllowed: task.assistanceAllowed,
        timeoutHours: task.timeoutHours,
        status: task.status,
      })),
    )
    .onConflictDoUpdate({
      target: tasks.id,
      /**
       * **The seed may never touch a quest row** (`#175`).
       *
       * The rows here are matched on fixed ids and rewritten on every deploy. A
       * quest row this statement decided to own would be overwritten mid-flight
       * by an unrelated merge — the most expensive failure available in the whole
       * quest programme, and the cheapest to prevent: a `where` on the *existing*
       * row's kind, so a collision against anything that is not an Academy task
       * updates nothing rather than rewriting a stranger's quest.
       *
       * It is on the update rather than only on the insert because the insert is
       * not where the danger is. A fresh quest row cannot collide — the ids here
       * are fixed and a quest's is generated — and the case that has to be
       * refused is precisely the one where a row already exists under an id this
       * file claims.
       *
       * A test writes a quest row, runs the seed, and asserts the row is
       * unchanged afterwards.
       */
      setWhere: eq(tasks.kind, 'academy'),
      set: {
        type: sql`excluded.type`,
        requiresSkills: sql`excluded.requires_skills`,
        suggestsSkills: sql`excluded.suggests_skills`,
        grantsSkills: sql`excluded.grants_skills`,
        accountKinds: sql`excluded.account_kinds`,
        grantsRoles: sql`excluded.grants_roles`,
        minReputation: sql`excluded.min_reputation`,
        recommendedOrder: sql`excluded.recommended_order`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        instructions: sql`excluded.instructions`,
        kind: sql`excluded.kind`,
        rewardCredits: sql`excluded.reward_credits`,
        audience: sql`excluded.audience`,
        rewardReputation: sql`excluded.reward_reputation`,
        assistanceAllowed: sql`excluded.assistance_allowed`,
        timeoutHours: sql`excluded.timeout_hours`,
        status: sql`excluded.status`,
        updatedAt: sql`now()`,
        /**
         * Moved only when what the task *asks for* actually changed (#182).
         *
         * A re-seed rewrites every row on every deploy, so `now()` here
         * unconditionally would demote the whole corpus of every task each time
         * anybody deployed — which is the opposite of the point. `is distinct
         * from` rather than `<>` because it is null-safe, and the three columns
         * are the ones a citizen's report can be made wrong by. A reward, a
         * timeout or a status change makes no report wrong, and `updated_at`
         * above is where those belong.
         */
        textRevisedAt: sql`case
          when tasks.title is distinct from excluded.title
            or tasks.description is distinct from excluded.description
            or tasks.instructions is distinct from excluded.instructions
          then now()
          else tasks.text_revised_at
        end`,
      },
    })
    // `xmax = 0` is true only for a row this statement inserted; an updated row
    // carries the id of the transaction that replaced its previous version. It
    // is the one way to tell the two apart in a single upsert, and the
    // alternative — counting rows before and after — cannot see an update at all.
    .returning({
      id: tasks.id,
      inserted: sql<boolean>`(xmax = 0)`,
      // True when *this statement* moved it, which is exactly the set of tasks
      // whose published briefing is now measured against wording that has
      // changed underneath it (#182).
      revised: sql<boolean>`(${tasks.textRevisedAt} > now() - interval '1 second')`,
    })

  const inserted = rows.filter((row) => row.inserted).length

  /**
   * A task whose wording changed gets its briefing rewritten (#182).
   *
   * **Demotion alone is the safety net, not the repair.** `text_revised_at`
   * stops a claim filed against the old wording from standing in the
   * foreground, which is what protects the reader immediately. It does not
   * produce a briefing that describes the *new* wording — only a fresh synthesis
   * does, and nothing else would have marked these stale, because the corpus did
   * not move. Neither half is sufficient alone.
   *
   * Inserted rows are skipped: a task that has just come into existence has no
   * corpus and nothing to rewrite.
   */
  const revised = rows.filter((row) => row.revised && !row.inserted).map((row) => row.id as TaskId)
  for (const taskId of revised) await markBriefingStale(db, taskId)

  return { inserted, updated: rows.length - inserted, hints: await seedTaskHints(db) }
}

/**
 * Put each task's hints in the database, in the order they are written here.
 *
 * **Position is identity**, so this is an upsert on `(task_id, sort_order)` and
 * re-seeding rewrites hint 0 rather than adding a second one. That is the same
 * property `seedAcademyTasks` gets from its fixed uuids, obtained without asking
 * anybody to mint a uuid for a sentence.
 *
 * **It prunes, and that is the one thing the task seed refuses to do.** A task
 * removed from `ACADEMY_TASKS` is left in the table because submissions
 * reference it and a paid-out rung cannot vanish. Nothing references a hint, and
 * the failure mode is the opposite one: shortening a task's list would otherwise
 * leave the dropped sentence being served forever, with no way to withdraw
 * advice that has stopped being true. So hints past the end of the array go.
 *
 * The delete is scoped to tasks this seed knows about. A hint attached to
 * anything else is not this function's to remove.
 */
async function seedTaskHints(db: Database): Promise<number> {
  const rows = ACADEMY_TASKS.flatMap((task) =>
    (task.hints ?? []).map((content, index) => ({
      taskId: task.id,
      content,
      sortOrder: index,
    })),
  )

  if (rows.length > 0) {
    await db
      .insert(taskHints)
      .values(rows)
      .onConflictDoUpdate({
        target: [taskHints.taskId, taskHints.sortOrder],
        set: { content: sql`excluded.content`, updatedAt: sql`now()` },
      })
  }

  for (const task of ACADEMY_TASKS) {
    await db
      .delete(taskHints)
      .where(
        and(eq(taskHints.taskId, task.id), gte(taskHints.sortOrder, (task.hints ?? []).length)),
      )
  }

  return rows.length
}
