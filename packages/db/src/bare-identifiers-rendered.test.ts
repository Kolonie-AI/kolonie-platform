import { describe, expect, it } from 'vitest'
import { bareOuterReference } from './bare-identifiers.js'

/**
 * The rendering half of the `#183` check, against real renderings.
 *
 * `bare-identifiers.test.ts` reads source text and says in its own header that
 * text cannot decide the question — position and the query's shape live at the
 * call site. This file tests the function that decides it from the rendered SQL,
 * and every string below is a rendering that was actually produced by this
 * schema through this dialect, not one composed to make a point. The two that
 * were composed are marked.
 *
 * The renderings were collected on 2026-08-04 by running the whole `packages/db`
 * suite against a server with `log_statement = 'all'` and reading the 50 distinct
 * statements that contained a subquery — the technique `#246` insists on, done
 * once for every call site the tests reach rather than by hand for a list.
 */
describe('a rendered subquery never compares against an unqualified column', () => {
  it('catches the rendering that produced the defect (#183)', () => {
    expect(
      bareOuterReference('(select count(*) from "task_attempts" where "session_id" = "id")'),
    ).toBe('"session_id" = "id"')
  })

  it('catches the rendering the exemption list claimed was safe (#246)', () => {
    expect(
      bareOuterReference(
        `(select count(*) from "submissions" where "task_id" = "id" and "status" = 'passed')`,
      ),
    ).toBe('"task_id" = "id"')
  })

  /**
   * The two `#311` found, and the reason one unqualified side is enough.
   *
   * Both name their inner table properly and leave the *outer* reference bare.
   * Both were right on the day they were measured, and right only because the
   * inner table happens to have no column of that name.
   */
  it('catches an outer reference left bare beside a qualified inner one (#311)', () => {
    expect(
      bareOuterReference(
        'select "agent_id", (select name from agents where agents.id = "agent_id") from "autonomy_form_invitations"',
      ),
    ).toBe('agents.id = "agent_id"')
    expect(
      bareOuterReference(
        'select "id", (select t.type from tasks t where t.id = "task_id") from "task_considerations"',
      ),
    ).toBe('t.id = "task_id"')
  })

  it('passes the fixed renderings of both', () => {
    expect(
      bareOuterReference(
        'select "agent_id", (select named.name from agents named where named.id = autonomy_form_invitations.agent_id) from "autonomy_form_invitations"',
      ),
    ).toBeUndefined()
    expect(
      bareOuterReference(
        'select "id", (select t.type from tasks t where t.id = task_considerations.task_id) from "task_considerations"',
      ),
    ).toBeUndefined()
  })

  /**
   * What must not be flagged, because flagging it would switch the check off.
   *
   * Every string here is from the same collected corpus. A comparison against a
   * bound parameter or a literal has no outer query to resolve against, which is
   * the whole reason the defect cannot arise there — and those two shapes are
   * most of the SQL this package writes.
   */
  it('leaves alone parameters, literals, keywords, casts and calls', () => {
    const safe = [
      `(select coalesce(sum(amount), 0)::text from ledger_entries where account_kind = 'agent' and agent_id = $1)`,
      `(select count(*)::text from agents where status = 'citizen')`,
      `(select count(*) from "task_attempts" where "task_attempts"."task_id" = $1 and "task_attempts"."agent_id" = $2)`,
      `(select a.id from agents a where a.created_at < now() - interval '100 days')`,
      `(select s.id from agent_sessions s where s.agent_id = $1 and s.last_seen_at > now() - make_interval(secs => least($2::numeric, $3)))`,
      `(select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`,
      `(select 1 from "agent_skills" where "agent_skills"."agent_id" = $5 and "agent_skills"."skill" in ($6))`,
      `(select v.evidence from verifications v where v.submission_id = submissions.id order by v.created_at desc limit 1)`,
      `(select max(s.last_seen_at) from agent_sessions s where s.agent_id = a.id)`,
    ]

    for (const statement of safe) expect(bareOuterReference(statement)).toBeUndefined()
  })

  /**
   * Composed rather than collected, because nothing in this schema renders it —
   * which is the point. A statement with no subquery is out of scope however its
   * identifiers are written: an unqualified name in a single-table statement
   * resolves to that one table, correctly, every time.
   */
  it('says nothing about a statement with no subquery', () => {
    expect(bareOuterReference('select "id", "agent_id" from "tasks" where "status" = $1')).toBe(
      undefined,
    )
  })

  /** Also composed: the nested case, to prove depth is not where it stops. */
  it('reaches a subquery inside a subquery', () => {
    expect(
      bareOuterReference(
        'select (select count(*) from "a" where "a"."x" = $1 and exists (select 1 from "b" where "b"."y" = "z")) from "c"',
      ),
    ).toBe('"b"."y" = "z"')
  })
})
