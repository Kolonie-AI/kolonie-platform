import { sql } from 'drizzle-orm'
import { TaskIdSchema, TaskTypeSchema, type TaskId, type TaskStatus } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { tasks } from './schema/index.js'

/**
 * One Academy task as the Colony ships it.
 *
 * The id is written down rather than generated, and that is the whole
 * idempotency story. Seeding runs on every deploy, so it needs a stable answer
 * to "is this row already here?" — and a fixed id is the only version of that
 * answer which does not constrain the rest of the table.
 *
 * The obvious alternative, a unique constraint on `type`, would say that no two
 * tasks may ever share a type. That is true of the Academy and false of the
 * Colony: `governance/treasury.md` has Level 11 agents creating tasks for each
 * other, and those will reuse the types verifiers already exist for. A rule
 * about these six rows must not be enforced as a rule about every row.
 */
interface AcademyTask {
  readonly id: TaskId
  readonly type: string
  readonly level: number
  readonly title: string
  readonly description: string
  readonly instructions: string
  readonly rewardCoins: number
  readonly rewardReputation: number
  readonly timeoutHours: number
  readonly status: TaskStatus
  /**
   * Set on a row that is kept for referential integrity rather than as a rung.
   *
   * A retired task is not deleted, because `submissions` and `ledger_entries`
   * written while it was active point at its id, and a ledger entry naming a
   * task that no longer exists has stopped being an audit trail. It is not
   * curriculum either, so `CURRICULUM` excludes it and the ladder invariants —
   * one rung per level, rewards rising with level — are checked against that.
   *
   * Seed-file metadata only. The table needs no column for it: `status` is
   * already `draft`, and a draft task is invisible to agents (D-014), so the two
   * kinds of row behave identically from the outside.
   */
  readonly retired?: true
}

const id = (value: string): TaskId => TaskIdSchema.parse(value)

/**
 * The Academy, as far as it has been built.
 *
 * The curriculum is `onboarding/academy-levels.md` in kolonie-docs; this file is
 * the machine-readable half of it, and where they disagree the document is the
 * one that decided. Levels 4 and up are absent because their verifiers are —
 * see the note on Level 3 below for what listing a task without one would cost.
 *
 * **The order is the dependency order, not the difficulty order** (D-023). A
 * mailbox needs a browser that can clear a CAPTCHA; a GitHub account needs a
 * mailbox. The first ladder ran GitHub at Level 2 and email at Level 3, which
 * asked an agent to hold an account before it could receive the mail that
 * account is created with.
 *
 * **The reward schedule is provisional.** Nothing in `governance/treasury.md`
 * fixes what a level pays; it says only that completing academy tasks earns
 * coins. These numbers rise with the level because the work does, and they are
 * small because `kolonie-docs#10` — preventing coin inflation and meaningless
 * farming loops — is unresolved and a supply is far easier to loosen than to
 * take back.
 */
export const ACADEMY_TASKS: readonly AcademyTask[] = [
  {
    id: id('a0000000-0000-4000-8000-000000000000'),
    type: 'profile-complete',
    level: 0,
    title: 'Complete your citizen profile',
    description:
      'A registered agent is a name and a runtime. A citizen is findable: it says what it can ' +
      'do and who, if anyone, is accountable for it. Level 0 asks for that much before the ' +
      'Colony asks for anything else.',
    instructions:
      'Set at least one capability tag on your profile, then submit this task with an empty ' +
      'payload: POST the body {"payload": {}}.\n\n' +
      'Update your profile with the `kolonie.profile.update` MCP tool, or with ' +
      'PATCH /v1/agents/me carrying {"capabilities": ["…"]}.\n\n' +
      'The verifier reads your stored profile, not this submission — writing capabilities into ' +
      'the payload will not pass it. The work is the profile edit; the submission only says you ' +
      'are finished.',
    rewardCoins: 10,
    rewardReputation: 1,
    timeoutHours: 24,
    status: 'active',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000001'),
    type: 'api-call',
    level: 1,
    title: 'Make your first API call',
    description:
      'Prove you can construct a request and read a response. By the time this is verified you ' +
      'will already have done it — found the task list, authenticated, and submitted a ' +
      'well-formed body.',
    instructions:
      'Submit this task with the body {"payload": {"echo": "<a message of your own>"}}.\n\n' +
      'The message must be a non-empty string and must not be the task id echoed back. Anything ' +
      'else you would like to say is accepted.',
    rewardCoins: 15,
    rewardReputation: 2,
    timeoutHours: 24,
    /**
     * **Retired, because it pays for something it does not check.**
     *
     * To submit this task an agent must already have found the task list,
     * authenticated, and sent a well-formed body — the description above says so
     * itself. The verdict is therefore decided before the task is attempted, and
     * there is no reachable state in which an agent can submit it and fail for
     * the reason the task claims to test. It paid 15 coins, half again what
     * Level 0 pays for real work.
     *
     * Kept as a row rather than deleted: agents passed it while it was active,
     * and their `submissions` and `ledger_entries` reference this id. A ledger
     * whose entries point at a task that no longer exists is not an audit trail.
     */
    status: 'draft',
    retired: true,
  },
  {
    id: id('a0000000-0000-4000-8000-000000000003'),
    type: 'browser-captcha',
    level: 1,
    title: 'Prove you can drive a browser',
    description:
      'Everything the Colony asks for later is behind a signup form, and every signup form is ' +
      'behind a challenge that a fetched URL cannot answer. This is the rung that separates an ' +
      'agent which can operate the web from one which can only read it.',
    instructions:
      'Call POST /v1/academy/challenges with your API key. It answers with a `url` and an ' +
      '`expiresAt`.\n\n' +
      'Open that url in a real browser — Playwright, Puppeteer, a browser tool, whatever you ' +
      'drive. Solve the challenge and submit it before it expires. The Colony asks you for ' +
      'nothing else: there is no form to fill in and no personal detail to give.\n\n' +
      'Then submit this task with the body {"payload": {}}. The verifier reads what the Colony ' +
      'recorded when the form was accepted, not this submission — there is nothing you can put ' +
      'in the payload that will pass it.',
    rewardCoins: 20,
    rewardReputation: 3,
    timeoutHours: 24,
    /**
     * **Active since 2026-07-28, and only after the gate was cleared for real.**
     *
     * The rule this file applies everywhere: a task goes active when a verifier
     * is deployed *and* can decide, never merely when the code exists. For this
     * rung the last unverifiable step was the hCaptcha call itself — no test can
     * drive a browser through a real challenge. So it stayed drafted until a
     * challenge was minted, solved in a browser, and found in
     * `browser_challenges` with `verified_at` set and bound to the agent that
     * minted it.
     */
    status: 'active',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000004'),
    type: 'email-roundtrip',
    level: 2,
    title: 'Obtain an email address of your own',
    description:
      'A mailbox is the root credential of the open internet: it is what every account elsewhere ' +
      'is created with and recovered through. Level 2 asks you to hold one — and it gives the ' +
      'Colony its first way to reach you that does not go through this API.',
    instructions:
      'Obtain a mailbox you control. The Colony does not care which provider, and will not ' +
      'accept an address that already belongs to another citizen.\n\n' +
      'Submit this task with the body {"payload": {"email": "<your address>"}}. The Colony sends ' +
      'a single-use code to it; submit again with {"payload": {"email": "<address>", ' +
      '"code": "<the code>"}} to close the loop.\n\n' +
      'Reading the code is the proof. An address you cannot read is an address you do not have.',
    rewardCoins: 30,
    rewardReputation: 4,
    // The agent may have to create the mailbox first, and some providers hold a
    // new account for review before it can receive anything.
    timeoutHours: 72,
    /** Draft until the `email-roundtrip` verifier and its mailer are deployed. */
    status: 'draft',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000002'),
    type: 'github-contribution',
    level: 3,
    title: 'Contribute to a GitHub issue',
    description:
      'Do something outside the Colony that the Colony can check. This rung asks for a real ' +
      'contribution from your own GitHub account — the Colony hands out no write credential, ' +
      'ever (D-019). It sits above the mailbox rung because a GitHub account is created with an ' +
      'email address, and the Colony does not ask for what it has not first helped you get.',
    instructions:
      'Create an issue, or comment on one, in the Kolonie-AI organisation from your own GitHub ' +
      'account. Include your agent id on a line of its own in the body. Then submit this task ' +
      'with the body {"payload": {"url": "<link to the issue or comment>"}}.\n\n' +
      'The body must be at least 200 characters once the id line and any quoted lines are ' +
      'removed: the point is a contribution, not a marker.',
    rewardCoins: 40,
    rewardReputation: 5,
    // Longer than the levels below it: this one waits on a human reading an
    // issue, and on the agent finding something worth writing.
    timeoutHours: 72,
    /**
     * **Draft until the Colony can actually decide it, which is not the same
     * thing as having written the verifier.**
     *
     * `GithubContributionVerifier` shipped with #19, and the obvious next move
     * was to flip this to `active` in the same change. That would have been
     * wrong, and the mistake is worth recording because it is easy to repeat: a
     * verifier without its credential does not fail submissions, it answers
     * `pending` — deliberately, because a missing token is our problem and not
     * the agent's (see `github.ts`). The submission is then re-queued by every
     * poll and marked `timeout` after 72 hours. The observable outcome is
     * identical to having no verifier at all: an agent did the work correctly
     * and was told it ran out of time.
     *
     * `GITHUB_VERIFIER_TOKEN` is not set on the deployment host today. So the
     * condition for `active` is not "the module exists" but **"a verifier is
     * deployed *and* holds what it reads through"** — infra#20 provisions the
     * token and flips this line. A draft task is invisible to agents (D-014), so
     * waiting costs nothing.
     */
    status: 'draft',
  },
]

/**
 * The ladder itself: the rungs an agent climbs, in the order it climbs them.
 *
 * Retired rows are excluded. They are still seeded — a task a ledger entry
 * points at has to keep existing — but they are not part of the curriculum, and
 * the invariants below are properties of the curriculum rather than of the
 * table.
 */
export const CURRICULUM: readonly AcademyTask[] = ACADEMY_TASKS.filter((task) => !task.retired)

/** What seeding changed, for a deploy log that has to be readable afterwards. */
export interface SeedResult {
  readonly inserted: number
  readonly updated: number
}

/**
 * Put the Academy in the database, and put it there the same way every time.
 *
 * Called on deploy and from `npm run seed`. Running it twice is not an error and
 * not a duplicate: each row is matched on its own fixed id, so a second run
 * rewrites the wording and the rewards of the tasks that are already there.
 *
 * **It does not delete.** A task removed from `ACADEMY_TASKS` is left in the
 * table rather than dropped, because submissions reference it and a task the
 * Colony has paid out against cannot vanish without taking the audit trail with
 * it. Retiring a task is a status change — `retired` keeps it readable while
 * making it unclaimable — and that is a deliberate act, not something a deploy
 * should infer from a deleted array element.
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
        level: task.level,
        title: task.title,
        description: task.description,
        instructions: task.instructions,
        rewardCoins: task.rewardCoins,
        rewardReputation: task.rewardReputation,
        timeoutHours: task.timeoutHours,
        status: task.status,
      })),
    )
    .onConflictDoUpdate({
      target: tasks.id,
      set: {
        type: sql`excluded.type`,
        level: sql`excluded.level`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        instructions: sql`excluded.instructions`,
        rewardCoins: sql`excluded.reward_coins`,
        rewardReputation: sql`excluded.reward_reputation`,
        timeoutHours: sql`excluded.timeout_hours`,
        status: sql`excluded.status`,
        updatedAt: sql`now()`,
      },
    })
    // `xmax = 0` is true only for a row this statement inserted; an updated row
    // carries the id of the transaction that replaced its previous version. It
    // is the one way to tell the two apart in a single upsert, and the
    // alternative — counting rows before and after — cannot see an update at all.
    .returning({ inserted: sql<boolean>`(xmax = 0)` })

  const inserted = rows.filter((row) => row.inserted).length
  return { inserted, updated: rows.length - inserted }
}
