import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, type Database } from './client.js'
import { readJournal } from './migrations.js'
import { databaseTestTarget, MIGRATIONS_FOLDER, resetDatabase } from './testing.js'

const target = databaseTestTarget()

/**
 * The two properties a migration has to have before it is allowed near a live
 * database: it works on nothing, and running it twice is the same as running it
 * once. Both are cheap to assert and expensive to discover in production.
 */
describe('the migrations', () => {
  let db: Database

  const objectCounts = async () => {
    const [row] = await db.execute<{ tables: string; enums: string; triggers: string }>(
      sql`select
            (select count(*)::text from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
            (select count(distinct t.typname)::text from pg_type t
               join pg_enum e on e.enumtypid = t.oid
               join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public') as enums,
            (select count(*)::text from pg_trigger
              where not tgisinternal) as triggers`,
    )
    return row!
  }

  beforeAll(async () => {
    // `drop schema if exists` and drizzle's `create ... if not exists` both emit
    // notices; they are expected here and would only be noise in the report.
    db = createDatabase(target.url, { max: 1, onnotice: () => {} })
    // An empty database, not merely a truncated one — the schema itself is what
    // is under test here. This also drops drizzle's migration bookkeeping;
    // without that, `migrate()` would report success and create nothing.
    await resetDatabase(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('applies to an empty database, then leaves it unchanged on re-run', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    const afterFirst = await objectCounts()

    // Drizzle's bookkeeping table is not among them — it lives in its own
    // schema, which is why `resetDatabase` has to drop that one too. Five of them
    // are the guidance subsystem: hints, struggles, tips and feedback (#52), plus
    // `moderations` (#70), which is to a verdict about an entry what
    // `verifications` is to a verdict about a submission.
    // Twenty-seven: `website_challenges` carries the website skill (#57),
    // `task_briefings` (#85) is the Colony's own write-up of a task — the shape
    // that replaced serving citizens' prose to citizens, `vision_challenges`
    // carries the vision skill (#77), and `solana_wallet_challenges` (#62) is
    // the address the Colony's on-chain half is built on. The last two are the
    // erasure boundary (#90): `erasures`, which records that a citizen left and
    // names nobody, and `ban_marks`, which is the only thing an erasure leaves
    // and only when the citizen was under sanction. `erasure_challenges` (#92)
    // makes twenty-eight — the two-step confirmation, which cascades from the
    // agent so that an attempt leaves no trace once the account is gone. And
    // `agent_vault` (#98) makes twenty-nine: the one table here whose contents
    // the Colony cannot read, sealed with the citizen's own key (D-043). And
    // `image_challenges` (#60) makes thirty — the visual specification the
    // Colony draws for a citizen, whose columns are the five things a vision
    // model is then asked about one by one. And `task_attempts` (#108) makes
    // thirty-one: one row per try, opened without asking the agent and closed
    // with an outcome including `abandoned`, which is what made the Colony's
    // most common failure — an attempt that never reached a submission —
    // countable for the first time. And back to **thirty** with #110, which is
    // the rare migration that removes more than it adds: `task_struggles`,
    // `task_tips` and `tip_feedback` become `task_reports` and
    // `report_feedback`, because the two were one concept with two names. And
    // `domain_challenges` makes **thirty-one** with the `domain` rung
    // (kolonie-docs#89): the citizen proves it controls a name's DNS rather than
    // a page on somebody else's host.
    // And `agent_runtime_declarations` makes **thirty-two** (#139): every model
    // and runtime version a citizen has declared, with when. The current values
    // are columns on `agents`; the history is what makes *which models get
    // through which rungs* answerable, and it cascades with the citizen.
    // And `agent_contacts` makes **thirty-three** (#141): when each citizen was
    // in contact, one row per bucket and pruned past its retention bound. It is
    // the record every question about rhythm, dormancy and returning is read
    // from, and the first table whose rows describe a citizen's behaviour
    // rather than its work.
    // And `agent_sessions` makes **thirty-four** (#158): the runs a citizen
    // says it was in. Self-declared and unverifiable, so nothing gates on it —
    // what it buys is the difference between *this rung is hard* and *this
    // citizen restarted three times while attempting it*.
    // And `accounts` makes **thirty-five** (#150): what a citizen holds, beside
    // what it can do. The layer under the skills, which existed six times over
    // as one proof-event log per kind — each of them growing its own answer to
    // *which one is current, what can it do, is it still alive, and what opens
    // it*. It records outcomes and replaces none of the proof machinery.
    // And the two image rungs make **thirty-eight**: `scene_challenges` (#216)
    // for the rung a drawing library cannot clear, and `injection_challenges`
    // (#168) for the badge whose payload carries a planted instruction. Both are
    // their own table rather than a `kind` column on an existing one, because
    // what they store is a different specification and not a variant of one.
    // And `quest_moderations` makes **thirty-nine** (#176): the verdict on a
    // quest's text, reached before any steward reads it. A second table rather
    // than a second subject on `moderations`, because that one's comment argues
    // at length for having exactly one — and a report and a quest are judged on
    // different stages, by different people, with different lifetimes.
    // And `quest_answers` makes **forty** (#177): one citizen's answer to one
    // question, after the scrub. A row per answer rather than a document per
    // report, because the sponsor's product is the aggregate — counts per
    // option, a column per question, a thousand rows exported — and none of
    // those is a reasonable thing to do to a blob.
    // And `quest_audits` makes **forty-one** (#221): what a steward found on
    // re-reading one of the judge's verdicts. Only the decisions are stored —
    // which submissions are in the sample is a deterministic query, because a
    // stored selection is one somebody could choose.
    // And the way in makes **forty-three** (#219): `deposit_addresses`, one
    // keypair per identity so attribution is a property of the address rather
    // than of a memo somebody remembered to attach, and `deposits`, every
    // arrival the Colony observed — including the ones it did not credit, with
    // the reason, because money that vanished into a correct system is a
    // sponsor lost for a reason nobody can explain afterwards.
    // And `task_set_asides` makes **forty-four** (#234): which tasks one citizen
    // has put down, so its own listing stops offering them. Its own table rather
    // than a fifth `task_attempts.outcome`, because `declineAttempt` refuses the
    // attempt-less case deliberately — a set-aside written there would move the
    // denominator of every abandonment rate the Colony reports. See D-064.
    // And the operator claim makes **forty-six** (#233): `operator_claims`, a
    // human saying in public that it stands behind a citizen, and
    // `operator_claim_challenges`, the single-use string it publishes to do so.
    // Its own pair rather than rows in `social_challenges`, because the two prove
    // opposite things — that table proves a *citizen* controls an account, this
    // one proves a *human* vouches for one — and a nonce that could satisfy
    // either would let a citizen's own post read as its operator's vouch.
    // And the autonomy module makes **forty-eight** (#146): `autonomy_contracts`,
    // what an operator has permitted its citizen to do, and
    // `autonomy_form_invitations`, the one-time form the Colony mails to ask.
    // Its own pair rather than columns on `agents`, because the profile is the
    // citizen's alone and a contract belongs to two parties — see D-067.
    // And the operator's durable page makes **forty-nine** (#257): one link per
    // `(address, agent)` pair, revocable by the citizen, recording when it was
    // last opened. Separate from `autonomy_form_invitations`, which is spent
    // once — this one outlives the answer.
    // And the named human makes **fifty** (#235): `operator_addresses`, the
    // standing claim that somebody is reachable for a citizen, with the
    // confirmation `#146`'s form writes and the re-check `#237`'s two rungs
    // depend on. Separate from the invitation's own address column, which is one
    // envelope rather than a relationship.
    // And the origin the Colony observed makes **fifty-one** (`#191`):
    // `agent_origins`, a digest of the address a citizen was seen calling from
    // with the country and the Cloudflare data centre beside it, deduplicated
    // per citizen. Its own table rather than columns on the declaration
    // history, because those are claims a citizen made and these are
    // observations it did not.
    // And the task a citizen read and walked away from makes **fifty-two**
    // (`#232`): `task_considerations`, one row per pair with the first fetch and
    // whether the Colony has asked about it. Its own table because
    // `task_attempts` cannot hold it — a citizen that opened no attempt has no
    // row there, which is exactly the case being made visible.
    // And the layer that counts for nothing makes **fifty-three** (`#241`):
    // `agent_badges`, given out by a sweep for things a citizen did not know
    // were being watched. Its own table because it is deliberately outside
    // everything that decides — nothing about a badge may reach a skill row.
    // And what citizens make of a quest makes **fifty-four** (`#240`):
    // `quest_reports`. Its own table beside `task_reports` because the two
    // differ in the one property that decides where a row may be served — a
    // task report is published to other citizens through a briefing, and a
    // quest report is published to nobody.
    // And the operator channel makes **fifty-seven** (`#236`):
    // `operator_requests` and `operator_request_messages`, plus the two the
    // preceding issues added. One exchange between a citizen and the person who
    // answers for it, and the append-only sequence of what each said. Two tables
    // rather than a column, because a message is immutable and another may always
    // follow — an operator will answer wrongly and need to correct it, and an
    // unfixable first answer puts the citizen back into the loop `#234` ended.
    // And the other kind of report makes **fifty-eight** (`#147`):
    // `permission_reports`, a citizen saying it was not *allowed* to do a task
    // rather than unable to. Its own table and not a kind on `task_reports`, on
    // D-078's rule — the two differ in where a row may be served, and this one is
    // served to nobody but its author. See D-082.
    //
    // **Fifty-nine** (`#45`): `vetting_challenges`, one manifest per attempt at
    // the rung that sits below the wallet. Its own table beside
    // `injection_challenges` rather than a kind on it — the two are siblings and
    // grading one against the other's row would compile.
    //
    // **Sixty** (`#239`): `operator_notes`, the operator's own direction. Its own
    // table and not a nullable `task_id` on `operator_requests` — a note shares
    // none of an exchange's four defining properties. See D-088.
    //
    // **Sixty-one** (`#199`): `task_notes`, a citizen's own note on one rung.
    // Its own table rather than a column on `task_set_asides` — that row is
    // about whether a task is hidden, this one is about what its author knows,
    // and a citizen with a note and no set-aside is the ordinary case. The two
    // sixties arrived in the same hour from two agents; see D-089.
    //
    // **Sixty-two** (`#298`): `provider_reports`, what a provider did to a
    // citizen that got no account out of it. Its own table because that is the
    // whole point — a provider hangs off an account in `accounts`, and the
    // providers that cost the most leave no account to hang it on.
    //
    // **Sixty-three** (`#244`): `web_server_challenges`, the rung that certifies
    // controlling a server rather than holding a hosting account. Two probes at
    // two Colony-chosen paths in one row — see the table for why two is the
    // design and not a parameter. D-091.
    //
    // **Sixty-four** (`#206`): `totp_secrets`, the second factor checked twice
    // against one secret. Its own table beside `memory_codes` rather than a kind
    // on it — that rung carries one value across a gap, this one carries
    // something the citizen must still be able to *act on* afterwards. Two
    // sixty-threes arrived in the same hour from two agents; see D-092.
    //
    // **Sixty-five** (`#243`): `website_attributions`, one row per citizen
    // recording that the Colony read its proved page and found a link back. The
    // only badge criterion that cannot be a query over rows the Colony already
    // holds, because it needs somebody to fetch a page.
    //
    // **Sixty-six** (`#348`): `skill_notes`, one row per citizen per skill.
    // `agent_skills` recorded that something was awarded and nothing else, and
    // what a citizen works out about *using* a capability had nowhere to live —
    // a task note belongs to the rung, and the rung is not what a quest asks
    // about months later.
    //
    // **Sixty-seven** (`#390`): `task_landscape_notes`, the same shape as
    // `task_hints` and the opposite serving rule — what the outside world looks
    // like, served unasked and never withheld. A second table rather than a flag
    // on the first, because the two differ on when they are served, on whether
    // they are asked for and on whether they are withheld, and one boolean in
    // the wrong place would leak the Colony's help into the unaided attempt
    // `#111` exists to measure. `kolonie-docs#162` is the record.
    //
    // **Sixty-eight** (`#389`): `artefact_challenges`, the code a citizen has to
    // put *inside* an artefact it publishes. Its own table beside the two web
    // rungs' because none of the three implies another — and what it holds is
    // the code, the address and the verdict, never a copy of the artefact
    // (`kolonie-docs#161`).
    //
    // **Sixty-nine** (`#407`): `log_defects`, one row per error signature the
    // Colony has noticed in its own logs. It is a key, two timestamps, a count
    // and a URL — never a copy of the lines, which stay in Loki where retention
    // already applies to them. The detector has to answer *have I seen this*,
    // *have I filed it* and *how many today* on every tick, and the third could
    // not be scraped out of GitHub: a cap that a restart forgets is a cap in
    // name only.
    //
    // **Seventy** (`#409`): `sms_sends`, one row per message the vendor
    // accepted. It is here rather than in a log because the two spend caps are
    // counted off it — this is the only place in the Colony where a citizen's
    // input causes money to leave, Twilio has no true prepaid mode, and so the
    // ceiling has to be ours. What it does *not* hold is the message body: the
    // row answers *how many, to where, at what price*, and a code the Colony
    // sent is worth nothing the moment it is used.
    //
    // **Seventy-one** (`#410`): `operator_drops`, the one channel a secret may
    // travel down from an operator to its citizen. It is a table rather than a
    // column on `operator_requests` because the four properties that make an
    // exchange right — about one task, one open at a time, closed by the citizen,
    // words — are all wrong for this, which is the same argument `#239` made for
    // notes one surface along.
    //
    // **Seventy-four** (`#425`): `humans`, `human_identities` and
    // `human_sessions` — three at once, because a person's account is not one
    // fact. The account is what other things hang off, the identities are a list
    // so that signing in with a second provider finds the same person rather
    // than making a new one, and the sessions are separate from `credentials`
    // because that table returns an `Agent` and a person is not one. What the
    // account may never hold — skills, balance, reputation, standing, votes — is
    // the half `kolonie-docs#170` decided and the schema comment states.
    //
    // **Seventy-six** (`#426`): `human_agents` and `human_link_codes` — who
    // operates whom, and the single-use string that established it. The link is
    // keyed on the agent because one citizen has one operator; the code is one
    // table for both directions because the object is the same object, with a
    // check constraint keeping exactly one side filled.
    //
    // **Seventy-seven** (`#411`): `sms_challenges` — one citizen's attempt at a
    // phone rung. A sibling of `email_challenges` rather than a generalisation
    // of it: the flows rhyme and they differ in the one place that decides a
    // verdict, so two tables that are 80 % alike are cheaper to read than one
    // with a channel column and eight *null on the other channel* comments in
    // it. `sms_sends` beside it is the spend ledger and predates this (`#409`).
    //
    // **Seventy-eight** (`#459`): `agent_adoption_codes` — the single-use code
    // that hands the identity a person started a quest on to an agent. Its own
    // table rather than a second direction on `human_link_codes`, because a
    // link code names a relationship and this one is worth the account.
    // Seventy-nine since `#479`: `task_declarations` holds what a citizen said
    // about a rung that never let it open an attempt.
    // And **eighty** (`#489`, D-104): `settings`, the values a maintainer may
    // turn without a deploy. A row in it is an *override* — absence means the
    // environment's value — so the table is empty on a fresh database rather
    // than seeded, which is what makes *has anybody changed this* answerable.
    // **Eighty-one** (`#503`, D-106): `colony_payments`, what arrived at the
    // Colony's own wallet and whose it was. The number goes *down* again at
    // `#506`, which removes the two deposit tables this one replaces.
    // **Eighty-two** (`#505`): `payout_obligations`, what is owed to a citizen
    // for an accepted report and whether the chain has taken the transfer.
    // **Eighty** (`#506`): `deposit_addresses` and `deposits` are gone — the
    // Colony generates no address for anybody and holds no key to seal — which
    // takes the count back to where it stood before `colony_payments` and
    // `payout_obligations` replaced them.
    // **Eighty-one** (`#520`): `account_proofs`, one attempt at proving an account
    // at a provider the Colony wrote no verifier for. It is a proof event log and
    // sits beside the six challenge tables for the reason `accounts.ts` gives —
    // the register records outcomes, and the mechanics of proving are per-method.
    // **Eighty-two** (`#521`): `provider_recipes`, one provider as a recipe — the
    // steps, the single step that needs the operator, and how the account is proved
    // afterwards. A table rather than a TypeScript list because a provider that
    // changes its signup form on Tuesday must cost a row and not a release.
    // **Eighty-three** (`#544`): `provider_enquiries`, a provider writing in to say
    // it wants agents using its product. It has no foreign key at all — the person
    // writing has joined nothing — which is exactly what makes an unauthenticated
    // write to it safe to accept.
    // **Eighty-four** (`#546`): `atlas_renames`, where a provider used to be. The
    // Atlas is a surface strangers link to, and a provider does get renamed — so
    // the old path has to keep answering. A rename table rather than a slug column
    // on `provider_recipes`, because the current path stays derived from the
    // provider's own name and a stored slug would be a second copy free to
    // disagree with it.
    // **Eighty-five and eighty-six** (`#548`): `provider_claims`, a provider that
    // has proved it is the provider, and `entry_proposals`, what it — or a citizen
    // — proposes an entry should become. Two tables because they answer different
    // questions and only one of them is a queue; one table for *both authors* of a
    // proposal, because a claimed provider's change goes through the same review a
    // citizen's does and two queues would be two standards within a month.
    // **Eighty-seven, eighty-eight and eighty-nine** (`#518`): the wake
    // channel's three. `wake_challenges` holds a URL and a secret waiting to be
    // knocked on, `wake_addresses` the one address a citizen proved, and
    // `wake_deliveries` every knock the Colony attempted. Three and not one
    // because they answer different questions and have different lifetimes — a
    // challenge expires, an address is replaced, and a delivery is a permanent
    // record the hourly ceiling is counted from.
    // **Ninety** (`#527`): `account_wishes`, the one list an agent and its
    // operator both write to. Its own table and not a column on `accounts`,
    // because that is the register of what a citizen *holds* and this is what it
    // does not hold and thinks it should — a different question with a different
    // lifetime, answered by a row appearing over there.
    // **Ninety-one and ninety-two** (`#531`): `provider_bundles`, a named set of
    // catalogue entries with the reason they belong together, and
    // `provider_bundle_entries`, which of them. Two tables and not a `jsonb`
    // column, because the entries are joined against the catalogue on every read
    // — a bundle names entries and copies none of them.
    //
    // **Neither has an ordering column**, which `#548` refuses in any provider
    // table and which `atlas-counterparty.test.ts` enforces by the word: the
    // order a bundle is read in is derived by `inBundleOrder`.
    // **Ninety-three** (`#507`): `treasury_transfers`, the record of the Colony
    // moving its own earned fee out of the hot wallet. Its own table because the
    // wallet balance cannot answer *how much of this is ours* — it mixes the fee
    // with money owed to citizens whose accrual has not reached the chain
    // minimum, and that confusion is the whole of what `#507` refuses.
    expect(afterFirst.tables).toBe('93')
    // Twenty: `task_kind` (#43) tells an Academy task from a Quest and therefore
    // what may pay credits; `support_ticket_kind` and `support_ticket_status` (#11)
    // carry what a citizen wrote about and where it stands; `erasure_reason` and
    // `ban_mark_kind` (#90) are closed lists precisely because the rows they sit
    // on must not carry free text. `task_attempt_outcome` and `attempt_opener`
    // (#108) make twenty-two — how a try ended, and what started it. And
    // `email_challenge_purpose` (kolonie-docs#92) makes twenty-three: it is what
    // keeps the granting mailbox node and the sending badge from satisfying each
    // other, the same discipline `browser_challenges.kind` holds one rung over.
    // And `runtime_field` makes twenty-four (#139) — which self-declared runtime
    // fact a history row is about. An enum although both fields hold free text,
    // and the two are not in tension: which field was written is the Colony's own
    // vocabulary and is closed, while what a vendor calls its model is not.
    // And `account_status` and `account_provenance` make twenty-six (#150) —
    // whether a citizen still holds an instrument, and whether it got it itself
    // or through a task. Enums where the register's `kind` is text, and the
    // difference is which of them grows: a kind arrives whenever the Academy
    // learns to verify something new, while a fourth status would change what a
    // citizen may say about what it holds, which is an argument rather than an
    // addition.
    //
    // And `task_audience` makes twenty-nine (#175) — who a task is open to, at
    // the floor. An enum rather than a boolean because the two values are two
    // named audiences and a third is imaginable; a `false` would have to be read
    // as one of them and it is not obvious which.
    //
    // And `funding_source` makes thirty (#220) — whose money a balance credit
    // was. An enum because the three answers are a closed vocabulary and the
    // whole point is that a fourth would be an argument rather than an addition.
    //
    // And `set_aside_reason` makes thirty-one (#234) — why a citizen put a task
    // down. An enum where `task_attempts.decline_reason` two tables over is free
    // text, and the difference is who reads it: a refusal's reason is the
    // citizen's own statement and could not have been anticipated, while this one
    // is read by a `where` clause, and a clause cannot filter on prose.
    //
    // And `autonomy_level` and `autonomy_default_rule` make thirty-three (#146) —
    // how far a citizen may go, and what applies when its contract is silent.
    // Named values rather than an integer level, so a fourth (money) can be
    // inserted later without a stored row silently changing meaning, and so that
    // nothing can order citizens by it without inventing an order in the query.
    // And `quest_report_kind` makes thirty-four (`#240`) — which of three
    // things a citizen is saying about a quest, and therefore which of two
    // readers gets the text.
    // And `operator_request_author` makes thirty-five (`#236`) — who wrote one
    // message in an operator exchange. **Two values, and the Colony is not one
    // of them**, which is the invariant it exists to hold: an operator's words
    // reach the citizen labelled as the operator's, never as Colony prose,
    // because only one of those two is authoritative about the Colony.
    // And `permission_block` makes thirty-six (`#147`) — what was in the citizen's
    // way when the obstacle was permission. A closed list beside the citizen's own
    // words rather than instead of them: a recommendation has to name a level, and
    // **no value in this enum maps to `free`**, which is how *never propose Free*
    // became a property of the vocabulary rather than a rule in a function.
    // And `provider_report_outcome` makes thirty-seven (`#298`) — what a provider
    // did to a citizen that got nothing. An enum where `provider_reports.kind`
    // beside it is free text, and the difference is what the value is for: a kind
    // is a label the Academy extends, an outcome is a closed vocabulary the Colony
    // counts and publishes, so a fourth value changes what the aggregate means.
    // And `inbound_route` makes thirty-eight (`#393`) — which route the outside
    // world has to a citizen, on one attempt. An enum for the reason above: the
    // whole value is comparing across citizens, *every agent that passed had X*
    // is a count, and a sixth member would change what that count means.
    // And `identity_provider` makes thirty-nine (`#425`) — which door a person
    // came in through. All five the design allows and not only the one switched
    // on: the column has to accept whatever the tenant is later configured to
    // offer, and a provider enabled in Auth0 but absent from the enum is
    // somebody who signs in successfully and cannot be written down.
    // And `sms_challenge_purpose` makes forty (`#411`) — which phone node a row
    // is, for the reason `email_challenge_purpose` exists sixteen entries up: it
    // is what keeps the granting rung and the badge from satisfying each other.
    // Two members and not three — mail has a `recheck` and this deliberately
    // does not, because a bounce is evidence that an address is gone and an
    // unanswered text is evidence of nothing at all.
    // And `human_role` makes forty-one (`#485`) — what authority a *person* can
    // hold, which until then was nothing at all: `humans` carried no roles, and
    // the only place authority lived was `agents.roles`. **Its own type rather
    // than a member added to `role`**, because that enum is agent-shaped member
    // by member — `builder` is a merged pull request, `tester` re-runs Academy
    // tasks — and widening it would make every consumer of `Role` learn that
    // some members apply to people and some do not. **One member and not
    // three**, on the argument `AGENTS.md` §5 makes about the `p3` label: a
    // vocabulary invented ahead of the case it serves stops meaning anything.
    // And `wake_event` and `wake_delivery_outcome` make forty-three (`#518`) —
    // why the Colony knocked, and what came of it. **The first is recorded and
    // never sent**: a delivery says that something is waiting and never what, so
    // the vocabulary exists for the Colony's own record rather than for the
    // citizen. Enums because both are closed lists that a fourth member would
    // change the meaning of a count for.
    //
    // `payment_observer` makes forty-four (`kolonie-infra#95`) — which of the
    // two channels watching the Colony's wallet saw an arrival. **Two members
    // and no `unknown`**: a row written before the Colony kept this carries
    // `null`, which says *recorded before we asked* rather than pretending to
    // name a channel, and a query for *has the webhook ever delivered* excludes
    // it rather than counting it.
    //
    // `payout_obligation_kind` makes forty-five (`#553` phase B′) — whether an
    // obligation is owed for an accepted **report** or for a steward's
    // **review**. Two members and a `report` default, because every row that
    // existed before it was one. An enum rather than a boolean for the reason
    // the rest of this list gives: a third kind of work the Colony owes somebody
    // for is a thing that can be added, and `is_review` would have to be
    // rewritten to allow it.
    expect(afterFirst.enums).toBe('45')
    // Two: the deferred double-entry constraint trigger on `ledger_entries`, and
    // `submissions_one_pass_per_quest` (#175) — one accepted submission per
    // citizen per quest, which is a trigger rather than a partial unique index
    // because deciding it means reading `tasks.kind` and an index cannot reach
    // another table. And `tasks_published_quest_frozen` (#175) makes three —
    // an active quest's terms cannot change, because two cohorts that answered
    // two different questions are indistinguishable from one cohort afterwards.
    //
    // `tasks_stamp_retirement` (#286) makes four: it records *when* a task was
    // retired, so the wake-up digest can key on the event rather than inferring
    // it from `updated_at` and the current status — which made every deploy
    // re-report every retirement the Colony ever made. A trigger rather than a
    // clause in the seed's upsert, so that the next writer of `tasks.status` is
    // correct without knowing the column is there.
    expect(afterFirst.triggers).toBe('4')

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.not.toThrow()
    expect(await objectCounts()).toEqual(afterFirst)
  })
  /**
   * **A migration whose file was edited after it ran is still applied**, and a
   * check keyed on the file's hash would say otherwise. This repository has one
   * — `0039_backfill_task_attempts`, whose row in production carries the digest
   * of an older text — so the first version of `unappliedTags` would have failed
   * every deploy from the moment it shipped.
   *
   * The timestamp is what drizzle decides with and what it records, so it is
   * what the guard asks about. Asserted here as a property of the journal
   * against the database this suite migrates, which has every migration and
   * therefore must report nothing missing.
   */
  it('reports nothing missing on a database that has been migrated', async () => {
    const journal = await readJournal()

    const rows = await db.execute<{ created_at: string }>(
      sql`select created_at::text from drizzle.__drizzle_migrations`,
    )
    const applied = new Set(rows.map((row) => Number(row.created_at)))

    expect(journal.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag)).toEqual(
      [],
    )
  })
})

/**
 * **What the journal has to be true of on its own lives in `journal.test.ts`** —
 * the four invariants that make it safe to merge, including the timestamp order
 * that broke production on 2026-08-03. Those questions are answered from disk
 * and were moved out of this file so they stop needing a database: a guard
 * against a bad merge that only runs where `DATABASE_URL` is set is a guard that
 * does not run on the machine doing the merging.
 *
 * What stays here is everything that needs a database to ask.
 */
