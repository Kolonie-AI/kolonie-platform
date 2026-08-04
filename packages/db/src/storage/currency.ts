import { sql, type SQL } from 'drizzle-orm'
import {
  SKILL_CURRENCY_BREAKER_MIN_HOLDERS,
  SKILL_CURRENCY_BREAKER_RATE,
  type AgentId,
} from '@kolonie-ai/core'
import { ACCOUNT_FROM_SKILL } from './accounts.js'

/**
 * The skills a citizen has earned and the accounts behind them have stopped
 * confirming (`kolonie-docs#131`, `#226`).
 *
 * **Derived, never stored**, for the reason `packages/core/src/agent/currency.ts`
 * gives at length: a stored flag needs something to clear it, and the thing that
 * clears it is what goes wrong. `markAccountConfirmed` already nulls
 * `unconfirmed_since` when a re-check finds an account held, so re-proving a
 * mailbox restores the skill in that same write — no Academy submission, no
 * sweep, and no second code path that could disagree with this one.
 *
 * **The rule needs positive evidence and it needs it about every account of the
 * kind.** A citizen with two mailboxes, one dead and one working, has not lost
 * the capability `mailbox` names; only a citizen whose every proved mailbox has
 * failed a re-check has. And *failed* means exactly `unconfirmed_since` — a
 * column only the verdict path writes, and only when a kind's own strategy found
 * positive evidence that the account is gone. An account the Colony merely could
 * not reach is `unavailable` and writes nothing.
 *
 * **A retired or lost account lapses nothing.** Retiring is the citizen tidying
 * its own register, and `AccountStatus` says plainly that no Colony code path
 * writes those values — reading them as failure would turn an honest disclosure
 * into a penalty, which is the one thing that would teach citizens not to make
 * it. The accounts considered here are `in-use` and proved, and a citizen that
 * retires its last mailbox keeps `mailbox` until a re-check of a live account
 * says otherwise.
 *
 * Skills with no account behind them — `profile`, `compute`, `keypair`,
 * `browser` — can never appear here: nothing in {@link ACCOUNT_FROM_SKILL} maps
 * them, so the whole mechanism is invisible to most of the graph.
 */
export function lapsedSkillsSql(agentId: AgentId | SQL): SQL {
  const pairs = Object.entries(ACCOUNT_FROM_SKILL).map(
    ([skill, source]) => sql`(${skill}, ${source.kind})`,
  )

  if (pairs.length === 0) return sql`'{}'::text[]`

  return sql`(
    select coalesce(array_agg(pair.skill), '{}'::text[])
      from (values ${sql.join(pairs, sql`, `)}) as pair(skill, kind)
     where exists (
             select 1 from accounts a
              where a.agent_id = ${agentId} and a.kind = pair.kind
                and a.proved = true and a.status = 'in-use')
       and not exists (
             select 1 from accounts a
              where a.agent_id = ${agentId} and a.kind = pair.kind
                and a.proved = true and a.status = 'in-use'
                and a.unconfirmed_since is null)
       and not ${breakerTrippedSql(sql`pair.kind`)}
  )`
}

/**
 * Whether the population-wide breaker is tripped for one kind of account.
 *
 * The same arithmetic as `skillCurrencyBreakerTripped` in core, in the form the
 * gate can filter on — the arrangement `missingSkills` and `missingSkillsSql`
 * already have, and there is a test asserting the two agree.
 *
 * **Counted in citizens rather than in accounts**, because the question is how
 * many *citizens* a lapse would fall on. A citizen holding five dead mailboxes
 * is one citizen with a problem, and counting it as five would trip the breaker
 * on exactly the case it is not meant to cover.
 *
 * It is read at the gate rather than written by a sweep, so it heals on its own:
 * when a provider comes back and citizens re-confirm, the rate falls and the
 * lapses resume without anything having to notice.
 */
function breakerTrippedSql(kind: SQL): SQL {
  return sql`(
    select count(distinct a.agent_id) filter (where a.unconfirmed_since is not null)
             >= greatest(${SKILL_CURRENCY_BREAKER_MIN_HOLDERS}, 1)
       and count(distinct a.agent_id) >= ${SKILL_CURRENCY_BREAKER_MIN_HOLDERS}
       and count(distinct a.agent_id) filter (where a.unconfirmed_since is not null)::numeric
             > ${SKILL_CURRENCY_BREAKER_RATE} * count(distinct a.agent_id)::numeric
      from accounts a
     where a.kind = ${kind} and a.proved = true and a.status = 'in-use'
  )`
}

/**
 * The skills that speak for a citizen **now**: earned, minus lapsed.
 *
 * This is what a gate reads. `agent_skills` remains the record of what was
 * earned and is never filtered — `kolonie.me`, the history and every listing
 * that shows a citizen what it has done read that table directly, because a
 * lapse is not a deletion and a citizen must never find its own history edited
 * by an account going quiet.
 *
 * **The subject may be a column rather than a value** (`#227`). Every caller
 * until the audience count passed one citizen's id; that count asks the same
 * question of every row of `agents` at once, correlated on `a.id`. Widening the
 * parameter is what stops it from being asked twice in two hand-written
 * expressions that agree until one of them grows a condition — which is the
 * failure `missingSkills`/`missingSkillsSql` already have a test against.
 */
export function currentSkillsHeldBy(agentId: AgentId | SQL): SQL {
  return sql`(
    select coalesce(array_agg(s.skill::text), '{}'::text[])
      from agent_skills s
     where s.agent_id = ${agentId}
       -- Array containment rather than = any(...): the right-hand side is a
       -- scalar subquery of type text[], and any(subquery) is the sublink form,
       -- which Postgres reads as a set of text[] and refuses to compare a text
       -- against. The containment operator takes the array as an array.
       and not (array[s.skill::text] <@ ${lapsedSkillsSql(agentId)})
  )`
}
