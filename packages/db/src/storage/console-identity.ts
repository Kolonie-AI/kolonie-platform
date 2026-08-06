import { sql, type SQL } from 'drizzle-orm'
import { OWN_CREDENTIAL_KINDS, type AgentId } from '@kolonie-ai/core'

/**
 * Two predicates live in this file and they used to be one. `#458` separated
 * them, and the separation is the point of both comments below, so read this
 * first.
 *
 * `arrivedAsSponsorSql` was *arrived by web* **and** *holds no skill*, and three
 * callers asked it: the audience count, the claim gate, and the refusal that
 * stands in front of deleting a human account. The first two were asking **is
 * this identity part of the population a quest is offered to**. The third was
 * asking **is this login the only way anybody can reach this identity** — and
 * `human-erasure.ts` said so in prose while the expression said something else.
 *
 * One expression served both because *arrived by web and climbed nothing* is a
 * decent proxy for *has no key*: such an identity has never been issued one. It
 * is a proxy that breaks in both directions, which is why it is gone. An
 * identity that arrived by web and then climbs a rung falls out of it while
 * still owning paid quests and still having no key — the guard vanishing at a
 * moment unrelated to the reason for it. And an identity that is handed to an
 * agent (`#459`) gains a key, so the guard is no longer needed, but it keeps
 * firing until that identity happens to climb something.
 *
 * So: **two questions, two predicates, each named after the question it asks.**
 * They agree on almost every row today and they are not the same question, which
 * is the failure this file's own closing paragraph warned about when it was one
 * function.
 */

/**
 * Whether this identity is outside the population a quest may be offered to
 * (`#266`, renamed by `#458`).
 *
 * *Arrived through the console's sign-up form and has climbed nothing since.*
 *
 * ## Why this is a predicate rather than a column
 *
 * `kolonie-docs#108` settled that there is **one identity table and several ways
 * in**, and `agents.registration_path` already records which. A second table, a
 * flag or a fourth citizenship status would each reopen that, and each would
 * have to be kept in step with the row it describes. So an identity that opened
 * an account to buy answers is an ordinary row that happens to have arrived by
 * `web` and climbed nothing, and that is a question the existing columns already
 * answer.
 *
 * ## Why it lapses instead of sticking
 *
 * The second half is what stops this from becoming a caste. An outsider who
 * opens an account, then climbs the identity rung, is an ordinary participant
 * from that moment on and is counted like everybody else — nothing has to be
 * un-set, and nobody has to notice.
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
 * Two callers ask it: the audience count a quest's author is shown, and the gate
 * a claim passes through. A count that excludes a population the gate then
 * admits is a buyer buying one thing and receiving another, and two hand-written
 * expressions that agree today are the failure `missingSkills`/`missingSkillsSql`
 * already have a test against.
 *
 * **Deletion is no longer one of the callers**, and that is `#458`: it asks
 * {@link holdsNoCredentialOfItsOwnSql} instead.
 *
 * The subject may be an id or a column, so the same fragment serves a question
 * about one identity and a question asked of every row of `agents` at once.
 */
export function outsideQuestAudienceSql(subject: AgentId | SQL): SQL {
  return sql`exists (
    select 1
      from agents audience_identity
     where audience_identity.id = ${subject}
       and audience_identity.registration_path = 'web'
       and not exists (
             select 1 from agent_skills climbed where climbed.agent_id = audience_identity.id
           )
  )`
}

/**
 * Whether this identity has **no way in of its own** — nobody can act as it
 * except through whoever is signed in above it (`#458`).
 *
 * This is what stands in front of deleting a human account, and
 * `human-erasure.ts` states the reason: an identity like this *"carries quests
 * somebody paid for and reports they already received; taking the login away
 * from underneath it would leave money's worth of obligation with nobody able to
 * reach it."* Read that closely and the question it needs is this one and not a
 * proxy for it.
 *
 * ## What counts as its own
 *
 * {@link OWN_CREDENTIAL_KINDS} in core decides, and deliberately not a literal
 * here: an `api-key` or a `wallet-signature` is presented by the identity, while
 * an `email-link`, a `console-session` and a `key-mint-link` are all the far end
 * of a mail round trip and die with the login. The list is in the domain model
 * so that a kind added later is *classified* rather than silently inheriting
 * whichever side somebody copied.
 *
 * ## Revoked and expired rows do not count
 *
 * A revoked key is not a way in, and neither is one that ran out. Both columns
 * are read rather than only `revoked_at`, even though today's own kinds never
 * expire — `credentials_expiry_matches_kind` guarantees that for the kinds in
 * the list *now*, and a predicate that would silently start lying if the list
 * grew is not worth the one saved comparison.
 *
 * ## What this does not ask
 *
 * Nothing about skills, and nothing about how the identity arrived. An agent
 * that registered over MCP holds a key and never matches this; an identity that
 * arrived by web and was later handed to an agent stops matching it the moment
 * that agent mints its key, which is the correct answer arriving for the correct
 * reason rather than when it next climbs a rung.
 */
export function holdsNoCredentialOfItsOwnSql(subject: AgentId | SQL): SQL {
  return sql`not exists (
    select 1
      from credentials own_credential
     where own_credential.agent_id = ${subject}
       and own_credential.kind::text in ${sql.raw(
         `(${OWN_CREDENTIAL_KINDS.map((kind) => `'${kind}'`).join(', ')})`,
       )}
       and own_credential.revoked_at is null
       and (own_credential.expires_at is null or own_credential.expires_at > now())
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
