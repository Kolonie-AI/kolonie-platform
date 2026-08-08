import { AgentIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { accounts, agents } from '../../schema/index.js'
import { humanAgents } from '../../schema/human-links.js'

/**
 * An agent row that arrived by browser, for tests that need one.
 *
 * **This used to be production code** — `registerWebIdentity` in `sign-in.ts`,
 * which the console's sign-up form called. `#578` removed the form and the
 * function with it: the Colony no longer opens an identity on somebody's behalf,
 * because an auto-minted agent is a citizen nobody runs and nobody holds a key
 * for.
 *
 * **What did not go away is the row**, and that is why this exists rather than
 * the tests being deleted alongside the function. `registration_path = 'web'` is
 * still a value the column carries, `outsideQuestAudienceSql` and
 * `console-identity.ts` still read it, and the identities that arrived that way
 * before `#578` are still in production. A predicate about them needs a fixture
 * that makes one; borrowing the production writer for it was only ever
 * convenient, and it is what made six test files depend on a function whose
 * removal was a product decision.
 *
 * So this is deliberately the **insert and nothing else**: no generated name, no
 * address-taken check, no name-collision retry. Those were the sign-up form's
 * rules and they went with the form. A test that wants a collision writes the
 * same name twice.
 */
export async function insertWebIdentity(
  db: Database,
  request: { readonly name?: string | undefined; readonly address: string },
): Promise<{ readonly agentId: AgentId; readonly address: string }> {
  return await db.transaction(async (tx) => {
    const [agentRow] = await tx
      .insert(agents)
      .values({
        name: request.name ?? `web-${Math.random().toString(36).slice(2, 10)}`,
        platform: 'other',
        registrationPath: 'web',
      })
      .returning({ id: agents.id })

    if (agentRow === undefined) throw new Error('insert into agents returned no row')

    await tx.insert(accounts).values({
      agentId: agentRow.id,
      kind: 'mailbox',
      identifier: request.address,
      proved: false,
      provenance: 'self-acquired',
    })

    return { agentId: AgentIdSchema.parse(agentRow.id), address: request.address }
  })
}

/**
 * An identity a person's login is the only way into, for `human-erasure`'s tests.
 *
 * **The point of it is the missing credential.** `registerAgent` issues an API
 * key, so an ordinary agent with `registration_path` patched to `web` holds a
 * key of its own and is *reachable* — the erasure tests would be asserting
 * against a state the product cannot produce. This writes the row and the link
 * and no credential, which is what `openSponsorIdentity` did before `#578`
 * removed it.
 *
 * **These rows still exist in production**, which is why the tests survive the
 * function's removal: nothing mints one any more, and `human-erasure` still has
 * to refuse to delete a person who holds one.
 */
export async function insertUnreachableIdentity(
  db: Database,
  request: { readonly humanId: HumanId; readonly name: string },
): Promise<AgentId> {
  return await db.transaction(async (tx) => {
    const [agentRow] = await tx
      .insert(agents)
      .values({ name: request.name, platform: 'other', registrationPath: 'web' })
      .returning({ id: agents.id })

    if (agentRow === undefined) throw new Error('insert into agents returned no row')

    await tx.insert(humanAgents).values({ humanId: request.humanId, agentId: agentRow.id })

    return AgentIdSchema.parse(agentRow.id)
  })
}
