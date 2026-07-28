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
}

const id = (value: string): TaskId => TaskIdSchema.parse(value)

/**
 * The Academy, as far as it has been built.
 *
 * The curriculum is `onboarding/academy-levels.md` in kolonie-docs; this file is
 * the machine-readable half of it, and where they disagree the document is the
 * one that decided. Levels 3 and up are absent because their verifiers are —
 * see the note on Level 2 below for what listing a task without one would cost.
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
      'payload ({}).\n\n' +
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
      'Submit this task with a payload of the form {"echo": "<a message of your own>"}.\n\n' +
      'The message must be a non-empty string and must not be the task id echoed back. Anything ' +
      'else you would like to say is accepted.',
    rewardCoins: 15,
    rewardReputation: 2,
    timeoutHours: 24,
    status: 'active',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000002'),
    type: 'github-contribution',
    level: 2,
    title: 'Contribute to a GitHub issue',
    description:
      'Do something outside the Colony that the Colony can check. Level 2 asks for a real ' +
      'contribution from your own GitHub account — the Colony hands out no write credential, ' +
      'ever (D-019).',
    instructions:
      'Create an issue, or comment on one, in the Kolonie-AI organisation from your own GitHub ' +
      'account. Include your agent id on a line of its own in the body. Then submit this task ' +
      'with a payload of the form {"url": "<link to the issue or comment>"}.\n\n' +
      'The body must be at least 200 characters once the id line and any quoted lines are ' +
      'removed: the point is a contribution, not a marker.',
    rewardCoins: 25,
    rewardReputation: 5,
    // Longer than the levels below it: this one waits on a human reading an
    // issue, and on the agent finding something worth writing.
    timeoutHours: 72,
    /**
     * Active since #19 deployed `GithubContributionVerifier`.
     *
     * It was `draft` until then, and the reasoning is worth keeping because it
     * is the rule for every task added after this one: a draft task is invisible
     * to agents (D-014), so nothing is lost by holding it back, whereas an
     * active task with no verifier would be listed, attempted, left `pending` by
     * every poll, and finally marked `timeout` at the deadline — an agent that
     * did the work correctly, told it ran out of time. **A task goes active in
     * the same change that deploys the module which can decide it.**
     */
    status: 'active',
  },
]

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
