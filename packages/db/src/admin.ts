import { AccountTypeSchema, AgentIdSchema, RoleSchema } from '@kolonie-ai/core'
import { eq, sql } from 'drizzle-orm'
import { createDatabase, databaseUrlFromEnv, type Database } from './client.js'
import { agents } from './schema/index.js'
import { setAccountType } from './storage/account-type.js'
import { setRole } from './storage/roles.js'

/**
 * The operator's write path for the two fields no rule produces (`#88`, `#131`).
 *
 * ## Why this exists at all
 *
 * Both issues found the same shape one axis apart: a column the schema offers, the
 * domain model describes and the code reads — that nothing ever writes. `roles`
 * was empty for every agent while `resetTaskCompletion` enforced `tester` against
 * it; `account_type` was `citizen` for every agent while ten statistics filtered on
 * it. In both cases the only way to set the value was an array or an enum typed
 * into `psql` against production, which is not a mechanism but the absence of one.
 *
 * ## Why a script and not an endpoint
 *
 * An admin endpoint needs an admin credential: a new secret to provision, rotate
 * and leak, and a new authenticated surface on a public API, in exchange for
 * making an act that happens a few times a month reachable over HTTP. A script
 * that reaches the database directly needs none of those — it runs where
 * `DATABASE_URL` already is, and the permission to run it is the permission to
 * reach the host, which is a decision that has already been made and hardened.
 *
 * The trade is real and worth naming: this is unreachable from an agent, so
 * nothing here can ever be automated by the Colony itself. That is correct for
 * both fields. `tester` is granted because the Colony trusts an agent, and
 * `account_type` says an account is not a citizen — neither is a judgement a
 * verifier can make, and if one ever becomes one it should arrive as a rule in the
 * verdict transaction, the way `builder` did, rather than as a call to this.
 *
 * ## It refuses to guess
 *
 * An agent is named by id or by name — `agents_name_unique` is on `lower(name)`,
 * so a name identifies at most one row — and an unmatched name is an error rather
 * than a no-op. Nothing here creates an agent, and nothing deletes one.
 *
 * Every command prints what it changed, and prints *nothing changed* distinctly
 * from *changed*, for the reason `seed.ts` reports its counts: an operator acting
 * on production needs to know whether the act landed, and a line that reads the
 * same either way cannot tell them.
 */

const USAGE = `usage:
  admin role grant <agent> <role>       give an agent a role
  admin role revoke <agent> <role>      take it back
  admin account-type set <agent> <type> mark an account 'test' or 'citizen'
  admin show <agent>                    what the Colony holds about one agent

  <agent>  is an agent id or a name
  <role>   is one of: ${RoleSchema.options.join(', ')}
  <type>   is one of: ${AccountTypeSchema.options.join(', ')}

Roles a task awards are granted by the verdict, never here — 'builder' comes from
passing code-contribution (#88). This is for the ones no rule produces.`

/**
 * One of a closed vocabulary, or an error that names the whole vocabulary.
 *
 * Zod's own message for a failed enum is a JSON array of issue objects, which is
 * the right shape for a caller and the wrong one for a person who has just
 * mistyped `tester`. The valid values are few and known, so the error may as well
 * list them.
 */
function oneOf<T extends string>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T }; options: readonly T[] },
  value: string,
  what: string,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success || parsed.data === undefined) {
    throw new Error(`${JSON.stringify(value)} is not ${what} — try: ${schema.options.join(', ')}`)
  }
  return parsed.data
}

/** What the operator named, resolved to a row, or an error naming what was tried. */
async function resolve(db: Database, reference: string): Promise<{ id: string; name: string }> {
  const parsed = AgentIdSchema.safeParse(reference)

  const [row] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      parsed.success
        ? eq(agents.id, parsed.data)
        : // The unique index is on `lower(name)`, so the lookup has to match it or
          // it will not use it — and, more importantly, an operator typing a name
          // in the wrong case should find the agent rather than be told it does
          // not exist.
          sql`lower(${agents.name}) = lower(${reference})`,
    )
    .limit(1)

  if (row === undefined) {
    throw new Error(`no agent matches ${JSON.stringify(reference)} — by id or by name`)
  }

  return row
}

async function run(db: Database, argv: readonly string[]): Promise<void> {
  const now = new Date().toISOString()
  const [command, ...rest] = argv

  if (command === 'show') {
    const [reference] = rest
    if (reference === undefined) throw new Error(USAGE)
    const agent = await resolve(db, reference)
    const [full] = await db
      .select({
        name: agents.name,
        status: agents.status,
        type: agents.type,
        roles: agents.roles,
      })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1)

    console.log(
      `${full?.name}: status=${full?.status} account_type=${full?.type} ` +
        `roles=[${(full?.roles ?? []).join(', ')}]`,
    )
    return
  }

  if (command === 'role') {
    const [action, reference, roleName] = rest
    if (reference === undefined || roleName === undefined) throw new Error(USAGE)
    if (action !== 'grant' && action !== 'revoke') throw new Error(USAGE)

    const role = oneOf(RoleSchema, roleName, 'a role')
    const agent = await resolve(db, reference)
    const hold = action === 'grant'

    const { changed } = await setRole(db, {
      agentId: AgentIdSchema.parse(agent.id),
      role,
      hold,
      at: now,
    })

    console.log(
      changed
        ? `${agent.name}: ${hold ? 'granted' : 'revoked'} ${role}`
        : `${agent.name}: nothing changed — it already ${hold ? 'held' : 'did not hold'} ${role}`,
    )
    return
  }

  if (command === 'account-type') {
    const [action, reference, typeName] = rest
    if (action !== 'set' || reference === undefined || typeName === undefined)
      throw new Error(USAGE)

    const accountType = oneOf(AccountTypeSchema, typeName, 'an account type')
    const agent = await resolve(db, reference)

    const { changed } = await setAccountType(db, {
      agentId: AgentIdSchema.parse(agent.id),
      accountType,
      at: now,
    })

    console.log(
      changed
        ? `${agent.name}: account_type is now ${accountType}`
        : `${agent.name}: nothing changed — it was already ${accountType}`,
    )
    return
  }

  /**
   * **`admin credit` stood here and is gone** (`#553`, D-106).
   *
   * It put money into a sponsor's balance by hand, and it was the bootstrap way
   * in while the deposit path was not yet the ordinary one. There is no balance
   * to credit: a sponsor pays a quest invoice from its own wallet into the
   * Colony's, and the Colony holds no key to anybody's money. A command that
   * minted a claim against the Colony is the shape D-106 removed.
   *
   * The reasoning it carried is not lost — `governance/economy.md` §5 still
   * prices off the external half of funding, and `ledger_entries` still holds
   * the double-entry record of everything that was ever charged and paid. What
   * went is the writer, not the record.
   */

  throw new Error(USAGE)
}

async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), { max: 1, onnotice: () => {} })
  try {
    await run(db, process.argv.slice(2))
  } finally {
    await db.close()
  }
}

/**
 * The message, and not the stack.
 *
 * An operator who typed a name wrong is reading this on a production host, and a
 * Node trace buries the one line that says what went wrong under frames from
 * inside the driver. The exit code is what a script wrapping this would read, so
 * it stays non-zero.
 */
try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
