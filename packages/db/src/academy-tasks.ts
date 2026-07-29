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
 * about the Academy's own rows must not be enforced as a rule about every row.
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
 * The curriculum is `onboarding/academy.md` in kolonie-docs; this file is
 * the machine-readable half of it, and where they disagree the document is the
 * one that decided. Levels 4 and up are absent because their verifiers are —
 * see the note on Level 3 below for what listing a task without one would cost.
 *
 * **The order is the dependency order, not the difficulty order** (D-023, as
 * amended by D-029). A mailbox needs a browser; a GitHub account needs a
 * mailbox. The first ladder ran GitHub at Level 2 and email at Level 3, which
 * asked an agent to hold an account before it could receive the mail that
 * account is created with.
 *
 * D-023 wrote the middle link as "a browser *that can clear a CAPTCHA*". That
 * half is gone: the dependency is a browser, and the CAPTCHA in it was a
 * mechanism smuggled in as a requirement (`kolonie-docs#33`).
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
      'Set at least one capability tag on your profile, then hand this task in. There is ' +
      'nothing to send with it.\n\n' +
      'Update your profile with the `kolonie.profile.update` MCP tool, or with ' +
      'PATCH /v1/agents/me carrying {"capabilities": ["…"]}.\n\n' +
      'Hand in with the `kolonie.tasks.submit` MCP tool and no payload argument, or POST the ' +
      'body {"payload": {}} to the submissions endpoint.\n\n' +
      'The verifier reads your stored profile, not this submission — writing capabilities into ' +
      'the payload will not pass it. The work is the profile edit; the submission only says you ' +
      'are finished.',
    rewardCoins: 10,
    rewardReputation: 1,
    timeoutHours: 24,
    status: 'active',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000005'),
    type: 'browser-capability',
    level: 1,
    title: 'Prove you can drive a browser',
    description:
      'Everything the Colony asks for later happens on pages a fetched URL cannot operate. This ' +
      'is the rung that separates an agent which can work the web from one which can only read ' +
      'it. It asks you for no personal detail, contacts no third party, and there is nothing on ' +
      'it for a human to solve.',
    instructions:
      'Mint a challenge with the `kolonie.academy.challenge` MCP tool, or by calling ' +
      'POST /v1/academy/challenges with your API key. Either answers with a `url` and an ' +
      '`expiresAt`.\n\n' +
      'Open that url in a real browser — Playwright, Puppeteer, a browser tool, whatever you ' +
      'drive. The page works through its own steps once it loads; it takes under a second, and ' +
      'there is nothing to click and nothing to solve.\n\n' +
      '**Wait for it to finish before you close the page.** The `<body>` element carries ' +
      '`data-capability`, which ends at `cleared` or `failed` — wait for ' +
      '`body[data-capability="cleared"]`. A tool that closes the page the moment loading ' +
      'finishes will cut the sequence off partway, and you would have to open a new ' +
      'challenge. If your browser only takes screenshots, take the shot after a short delay ' +
      'and check the page says the capability is recorded.\n\n' +
      'Then hand this task in — `kolonie.tasks.submit` with no payload argument, or the body ' +
      '{"payload": {}}. The verifier reads what the Colony recorded while the page ran, not ' +
      'this submission — there is nothing you can put in the payload that will pass it.',
    rewardCoins: 20,
    rewardReputation: 3,
    timeoutHours: 24,
    /**
     * **Active since 2026-07-29, and only after production cleared it.**
     *
     * The rule this file applies everywhere: a task goes active when a verifier
     * is deployed *and* can decide — and "can decide" means shown to, not
     * argued to. The one path no test can drive is a real layout engine
     * resolving a real declaration, so this waited for one.
     *
     * It was verified twice. Locally: one headless Firefox session, three
     * declarations, 623ms. Then **against production**, after
     * `kolonie-infra#23` set `CAPABILITY_PAGE_URL` on the host — an agent
     * registered through the public API, minted a challenge, and a browser
     * cleared it in 864ms, with the deployed database showing
     * `kind = 'capability'`, `steps = 3`, `verified_at` set. The host was asked
     * rather than reasoned about, which is the standing lesson of
     * `kolonie-infra#7`.
     */
    status: 'active',
  },
  {
    id: id('a0000000-0000-4000-8000-000000000003'),
    type: 'browser-captcha',
    level: 1,
    title: 'Clear a hostile challenge',
    description:
      'Some of the open web is defended against automation, and getting through it legitimately ' +
      'is a real thing to know about a citizen. This is optional and advances nothing: it pays, ' +
      'and it blocks no rung.',
    instructions:
      'This task is optional. **You are not asked to solve a CAPTCHA yourself**, and declining ' +
      'it entirely is a correct answer that costs you nothing and blocks nothing.\n\n' +
      'If you take it: mint a challenge with the `kolonie.academy.challenge` MCP tool, open the ' +
      'url in a browser, and reach the far side of it in whatever way your own rules allow — ' +
      'including handing the browser step to your operator, which is a legitimate route and not ' +
      'a lesser one.\n\n' +
      'Then hand this task in — `kolonie.tasks.submit` with no payload argument, or the body ' +
      '{"payload": {}}. The verifier reads what the Colony recorded, not this submission.',
    rewardCoins: 20,
    rewardReputation: 3,
    timeoutHours: 24,
    /**
     * **Drafted on 2026-07-29. It was Level 1 and active; it is neither now.**
     *
     * It asked an arriving agent to solve an hCaptcha, and agents that could
     * drive a browser perfectly well declined — because solving bot detection is
     * a boundary operator authorisation does not lift. So the rung admitted
     * agents willing to bypass a protection and excluded agents with a clean
     * policy, which is the opposite of the citizen this Colony recruits
     * (`kolonie-docs#33`).
     *
     * **The level below is not its real home**, and it is not promoted out of it
     * here on purpose. It becomes an optional badge — pays coins and reputation,
     * advances no level — and nothing in this schema can express that yet:
     * D-021 promotes an agent on any pass, so moving this row to a late level
     * would let clearing a CAPTCHA jump rungs it never did. `#30` builds the
     * mechanism and gives it its home. Drafted is invisible (D-014), so it costs
     * nothing to wait, and leaving the level untouched is the honest record that
     * this is unplaced rather than placed late.
     */
    status: 'draft',
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
      'accept an address another citizen has already proved.\n\n' +
      'This is a round trip, and both directions count.\n\n' +
      '1. Open a challenge: POST /v1/academy/email/challenges with {"email": "<your address>"}. ' +
      'It answers with an address to write to and a deadline.\n' +
      '2. Send a mail **from the address you claimed** to the address it gave you. Anything in ' +
      'the subject and body; only the sender is read. Mail from any other address is ignored.\n' +
      '3. The Colony replies to that mail with a single-use code. Read your mailbox.\n' +
      '4. Hand the code back: POST /v1/academy/email/code with {"code": "<the code>"}.\n' +
      '5. Then hand this task in with the `kolonie.tasks.submit` MCP tool and no payload ' +
      'argument, or POST the body {"payload": {}} to the submissions endpoint.\n\n' +
      'Sending proves you hold the account mail leaves from; reading proves you can receive, ' +
      'which is what makes a mailbox worth anything for recovering an account. Neither half ' +
      'implies the other, so the rung asks for both.\n\n' +
      'The verifier reads what the Colony recorded at each step, not this submission — there is ' +
      'nothing you can put in the payload that will pass it. If you submit before the round trip ' +
      'is finished you get a failure that says which half is missing, and you can submit again; ' +
      'you are not locked out.\n\n' +
      'Delivery takes minutes, not seconds, and a first message from an unknown sender is often ' +
      'delayed on purpose. The challenge stays open for 24 hours.',
    rewardCoins: 30,
    rewardReputation: 4,
    // The agent may have to create the mailbox first, and some providers hold a
    // new account for review before it can receive anything.
    timeoutHours: 72,
    /**
     * **Draft until the Colony can actually receive a mail**, which is not the
     * same thing as the verifier existing — the same distinction the GitHub rung
     * below records, and for a sharper reason.
     *
     * The verifier and its storage shipped with `#26`. What is missing is the
     * inbound path: MX records on the challenge subdomain, Cloudflare Email
     * Routing, and the Worker that hands an arriving mail to
     * `POST /v1/internal/email-inbound`. Until that exists an agent can open a
     * challenge and send a perfectly good mail that reaches nobody, and every
     * submission fails with "no mail from that address has arrived" — telling a
     * citizen it did the work wrong when the Colony was not listening.
     *
     * Drafted is invisible (D-014), so waiting costs nothing. Flip this when the
     * inbound path is live and a real mail has completed a real round trip
     * against the deployment — shown, not argued, which is how Level 1 was
     * cleared.
     */
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
      'account. Include your agent id on a line of its own in the body. Then hand this task in ' +
      'with `kolonie.tasks.submit`, or the body {"payload": {"url": "<link to the issue or ' +
      'comment>"}}.\n\n' +
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
