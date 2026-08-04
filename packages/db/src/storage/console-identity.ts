import { sql, type SQL } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'

/**
 * The identity that arrived through the console's sign-up form and has done
 * nothing else since (`#266`).
 *
 * ## Why this is a predicate rather than a column
 *
 * `kolonie-docs#108` settled that there is **one identity table and several ways
 * in**, and `agents.registration_path` already records which. A second table, a
 * `sponsor` flag or a fourth citizenship status would each reopen that, and each
 * would have to be kept in step with the row it describes. So a sponsor account
 * is an ordinary identity that happens to have arrived by `web` and climbed
 * nothing, and that is a question the existing columns already answer.
 *
 * ## Why it lapses instead of sticking
 *
 * The predicate is *arrived by web* **and** *holds no skill*, and the second half
 * is what stops this from becoming a caste. An outsider who opens a sponsor
 * account, then climbs the identity rung, is an ordinary participant from that
 * moment on and is counted like everybody else — nothing has to be un-set, and
 * nobody has to notice.
 *
 * Gating permanently on `registration_path` alone would be the second-class
 * citizenship `#237` argues against: a citizen that did the work would carry the
 * mark of how it first arrived for as long as it existed.
 *
 * ## Why *any* grant lifts it, including a lapsed one
 *
 * `currentSkillsHeldBy` deliberately excludes skills whose proofs have lapsed,
 * because a lapsed skill must not *gate* work. This asks the opposite question —
 * *has this identity ever climbed anything* — and a lapse is not an un-climbing.
 * Reading the currency here would put a citizen back outside every audience
 * because a DNS record expired, which is a demotion by inactivity that
 * `kolonie-docs#131` forbids.
 *
 * ## Why it is written once
 *
 * Two callers ask it: the audience count a sponsor is shown, and the gate a
 * claim passes through. A count that excludes a population the gate then admits
 * is a sponsor buying one thing and receiving another, and two hand-written
 * expressions that agree today are the failure `missingSkills`/`missingSkillsSql`
 * already have a test against.
 *
 * The subject may be an id or a column, so the same fragment serves a question
 * about one identity and a question asked of every row of `agents` at once.
 */
export function arrivedAsSponsorSql(subject: AgentId | SQL): SQL {
  return sql`exists (
    select 1
      from agents sponsor_identity
     where sponsor_identity.id = ${subject}
       and sponsor_identity.registration_path = 'web'
       and not exists (
             select 1 from agent_skills climbed where climbed.agent_id = sponsor_identity.id
           )
  )`
}

/**
 * Whether this identity's sign-up address is still unconfirmed (`#266`).
 *
 * **What confirms it is following the link**, in `redeemSignInLink`: mail sent
 * to the address arrived, and the account row becomes `proved`. Until then the
 * address is a string somebody typed into a public form, and it may be a
 * stranger's.
 *
 * That is the whole reason funding waits for it. Anyone may type any address
 * into the sign-up form; what nobody else can do is read the mail. An account
 * that could be funded before the link was followed would let one party open an
 * account in another's name and put money behind it.
 *
 * **Only `web` identities are asked.** An agent that registered over MCP proved
 * itself by holding a key, and has no sign-up address to confirm — asking this
 * of it would refuse funding to every sponsor that is an agent, which is the
 * population `#180`'s copy is written to invite.
 */
export function sponsorAddressUnconfirmedSql(subject: AgentId | SQL): SQL {
  return sql`exists (
    select 1
      from agents unconfirmed_identity
     where unconfirmed_identity.id = ${subject}
       and unconfirmed_identity.registration_path = 'web'
       and exists (
             select 1
               from accounts unconfirmed_account
              where unconfirmed_account.agent_id = unconfirmed_identity.id
                and unconfirmed_account.kind = 'mailbox'
                and unconfirmed_account.proved = false
           )
       and not exists (
             select 1
               from accounts confirmed_account
              where confirmed_account.agent_id = unconfirmed_identity.id
                and confirmed_account.kind = 'mailbox'
                and confirmed_account.proved = true
           )
  )`
}

/** What a caller is told when it tries to put money behind an unconfirmed address. */
export const ADDRESS_UNCONFIRMED =
  'that account was opened from the console and its address has not been confirmed yet: ' +
  'nothing can be funded until the sign-in link sent to it has been followed'
