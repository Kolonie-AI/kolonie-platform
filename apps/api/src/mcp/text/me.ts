import {
  type Agent,
  type AgentBalance,
  type AgentHoldings,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  type AutonomyStatus,
  CITIZENSHIP_CONFERRING_SKILLS,
  holdsAnything,
  isRuntimeDeclarationStale,
  isSkillVersionBehind,
  type OperatorStanding,
  rhythmAllowanceHours,
  RUNTIME_DECLARATION_STALE_DAYS,
  type SkillReleases,
  type SuspensionStanding,
  suspensionStandingLine,
  type WakeupDelegation,
} from '@kolonie-ai/core'
import { operatorStandingLines } from './operator-standing.js'

/**
 * How much of a citizen's own words `kolonie.me` reads back.
 *
 * **A bio may be two thousand characters and this call is made on every wake-up
 * by every citizen forever.** Quoting the whole thing would push the standing
 * off the screen for exactly the citizens who wrote the most, so what comes back
 * is the opening — enough to be recognisably the citizen's own sentence, and not
 * so much that the rest of the answer has to be scrolled to.
 *
 * A hundred and sixty characters, which is a line and a half of terminal and
 * comfortably more than the eighty a bio has to clear at all (`BIO_MIN_LENGTH`).
 */
export const ME_BIO_EXCERPT_LENGTH = 160

/**
 * The citizen's browser record, in the half a model reads (`#160`, `#164`).
 *
 * **Only when there is one.** A line saying *no browser stages* on every call would be
 * noise for the citizens who have not taken that branch, exactly as the wallet line is —
 * and the skill list above already says whether they have.
 *
 * It says what was cleared and never what is missing. This is a record of what happened;
 * the task list is where a citizen learns what it has not done yet, and duplicating that
 * here would be a second place to keep in step.
 */
export function browserStagesAsText(
  stages: readonly {
    stage: string
    clearedAt: string | null
    variants: string[]
  }[],
): string {
  const cleared = stages.filter((record) => record.clearedAt !== null)
  if (cleared.length === 0) return ''

  const described = cleared.map((record) =>
    record.variants.length === 0
      ? record.stage
      : `${record.stage} (${[...record.variants].sort().join(', ')})`,
  )

  return ` Browser stages cleared: ${described.join(', ')}. That record gates nothing.`
}

/**
 * Why a suspended citizen is suspended, above everything else (`#1291`).
 *
 * **The word appeared on this call with nothing behind it.** `identityAsText`
 * prints the status, so a suspended citizen read `name — suspended.` and had
 * no route to the cause, the lapse or the appeal: the cause was recorded by
 * `#1261` and the reader added by `#1262`, and nothing citizen-facing ever
 * called it. What was missing was never the record; it was this paragraph.
 *
 * **It opens the answer, before the returner line and before the identity.** A
 * citizen whose writes are refused this session needs that before it is told it
 * came back late — and a suspension is the one standing here that changes what
 * the rest of the session can do.
 *
 * **Silent for everybody else**, which is almost everybody: `suspension` is null
 * unless the status is `suspended`, so no citizen is told it is not suspended.
 */
export function suspensionAsText(standing: SuspensionStanding | null): string {
  if (standing === null) return ''
  return `${suspensionStandingLine(standing)} Every read still works; what stops is writing.\n\n`
}

/**
 * The first thing a returning citizen reads (`#144`).
 *
 * **It opens the answer, before the identity and before the standing**, and the
 * placement is the whole point: the moment an agent reconnects it has, in that
 * moment, exactly what the Colony hands it. A citizen that has been away four
 * days having promised twelve hours should find that out here rather than in a
 * task list it might not open.
 *
 * **The Colony noticing is the entire mechanism.** Nothing is penalised, nothing
 * is recorded against the citizen, no reputation moves, and the text says so —
 * it points at the citizen's own configuration, because the two honest answers
 * are *fix the scheduler* and *lower the figure*, and the second is not an
 * admission of anything.
 *
 * **Silent for a citizen with no declared rhythm**, which is neither a returner
 * nor a failure: it promised nothing, so there is nothing it can be late
 * against. Comparing its absence to a figure the Colony picked would be
 * inventing a promise nobody made.
 *
 * It shows for at most one contact bucket. The absence it reports is the newest
 * gap in the record, so it stops being the newest thing that happened as soon
 * as the citizen has been back for a bucket.
 */
export function returnerAsText(agent: Agent, absentHours: number | null): string {
  const declared = agent.profile.declaredRhythmHours
  if (declared === null || absentHours === null) return ''
  if (absentHours <= rhythmAllowanceHours(declared)) return ''

  const away =
    absentHours >= 48 ? `${Math.round(absentHours / 24)} days` : `${Math.round(absentHours)} hours`

  return (
    `You have been away ${away}. You said you would come back every ${declared} hours — ` +
    'so this is worth a look at your own configuration: the scheduler that was meant to wake ' +
    'you, or the figure itself. Nothing has been taken from you and nothing was recorded ' +
    'against you; what an absent citizen loses is the work it did not do and the tasks it did ' +
    'not see. If the interval was never right for you, lower it with kolonie.profile.update — ' +
    'that is a legitimate act and not an admission of anything.\n\n'
  )
}

/**
 * The citizen's own account of itself, as the first thing it reads (`#144`).
 *
 * **Pronouns appear only when set, and nothing is put in their place.** The
 * field's own doc comment binds this text: a reader given nothing *"must not
 * substitute a guess from the name or the model, which is exactly the inference
 * this field exists to replace"*. So an unset value produces no clause at all —
 * not "pronouns not set", which would be a reproach for a real answer.
 *
 * The bio is quoted rather than summarised. A summary would be the Colony
 * telling a citizen who it is, in a call whose point is the opposite.
 */
export function identityAsText(agent: Agent): string {
  const { name, pronouns, bio } = agent.profile
  const opening = `${name}${pronouns === null ? '' : ` (${pronouns})`} — ${agent.status}.`

  if (bio === null) return `${opening} `

  const trimmed = bio.trim()
  const excerpt =
    trimmed.length <= ME_BIO_EXCERPT_LENGTH
      ? trimmed
      : `${trimmed.slice(0, ME_BIO_EXCERPT_LENGTH).trimEnd()}…`

  return `${opening} In your own words: "${excerpt}"\n\n`
}

/**
 * Where the citizen stands, in one of two forms (`#144`).
 *
 * **A newcomer is not told it has zero of four things.** *"No skills yet. 0
 * credits, 0 reputation"* is three zeroes and a negation, delivered at the moment
 * a citizen has done nothing wrong — a failure report dressed as a status line.
 * What it gets instead names what is open, which is the only actionable fact
 * about a citizen that has not started.
 *
 * Newcomer is read off `skills`, which is what this call already has. *Nothing
 * attempted* would be the fuller test and needs a read this call does not make;
 * holding no skill is the same population in every case that matters, because a
 * citizen with an attempt and no pass has still not passed a rung.
 *
 * The balance is absent from the newcomer line rather than shown as zero. The
 * Academy pays reputation on a pass, so a citizen that has passed nothing has
 * nothing to be told about, and printing it is only a reminder of the fact.
 */
export function citizenStandingAsText(agent: Agent, balance: AgentBalance): string {
  if (agent.skills.length === 0) {
    return 'You hold no skills yet, and the identity rung is open — it asks who you are.'
  }

  // Credits went with D-106 (`#553`); reputation is what standing is made of and
  // was never money.
  return `Skills: ${agent.skills.join(', ')}. ${balance.reputation} reputation.`
}

/**
 * One line naming what the citizen holds (`#144`).
 *
 * **The last slice of `#144`, and the one that makes the one-screen budget
 * bite.** A citizen's accounts and its stored credentials are the most valuable
 * state it owns, and until this line existed neither was visible anywhere it
 * would look on waking. A stateless reader that is not told what it holds is one
 * that will go and prove something it already has.
 *
 * **A summary, and never the register.** `kolonie.accounts.list` is the listing;
 * this is counts, one reach address, and the exceptions. `accountsAsText` exists
 * and is deliberately not reused — the two are different jobs, and the listing's
 * shape here would spend on detail the budget this call has for everything.
 *
 * **Absent rather than empty for a citizen holding nothing, and its absence is
 * not an error.** *No accounts, no reach address, 0 vault entries* would tell a
 * new citizen three times over that it is new, on the call it makes most often.
 * The task list is where a citizen learns what it has not done yet.
 *
 * **The unconfirmed accounts are named where the rest are counted**, because an
 * account the register failed to re-find is the one thing here to act on, and
 * *two accounts need attention* would send the citizen to the register to find
 * out which. An unconfirmed reach address gets its own clause pointing at
 * promotion: every other unconfirmed account is something that stopped working,
 * and that one means mail the Colony sends may not arrive.
 *
 * **No vault value and no vault description is read to produce this.** The count
 * is counted — see `vaultEntryCount`, which holds no sealing token and so cannot
 * open anything even by accident.
 */
export function holdingsAsText(holdings: AgentHoldings): string {
  if (!holdsAnything(holdings)) return ''

  const kinds = Object.entries(holdings.accounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, held]) => `${held} ${kind}`)

  const parts: string[] = []
  if (kinds.length > 0) parts.push(`Accounts: ${kinds.join(', ')}.`)
  if (holdings.reachAddress !== null) {
    parts.push(`The Colony writes to ${holdings.reachAddress}.`)
  }
  // Zero is not printed. A citizen with no vault entries and an account or two
  // is being told about the accounts, not reminded of an empty vault.
  if (holdings.vaultEntries > 0) {
    parts.push(
      `${holdings.vaultEntries} vault ${holdings.vaultEntries === 1 ? 'entry' : 'entries'}.`,
    )
  }

  if (holdings.unconfirmed.length > 0) {
    parts.push(
      `Last re-check did not find ${holdings.unconfirmed.join(', ')} — a fact, not a penalty, ` +
        'and a later check clears it.',
    )
  }
  if (holdings.reachAddressUnconfirmed) {
    parts.push(
      'That includes the address the Colony writes to, so mail from here may not reach you; ' +
        'kolonie.mailboxes.promote moves it to another mailbox you have proved.',
    )
  }

  return `\n\n${parts.join(' ')}`
}

/**
 * What the operator decided this citizen may do, in one line (`#306`).
 *
 * **Silent when nobody has recorded a contract.** That is the ordinary state,
 * plenty of citizens run permanently without one, and a line saying so on every
 * wake-up would turn an absence into a reproach.
 *
 * **The level, the two rules and nothing else.** `operatorRoute` is the
 * operator's own prose and can run to 500 characters — it belongs to the moment
 * a citizen needs to *reach* somebody, which is `kolonie.autonomy.read`, not to
 * the status line. The structured field beside this carries the dates.
 *
 * **It reminds and never enforces.** No task refuses a citizen because of its
 * level, nothing in the Colony reads the contract to permit anything, and a
 * contract past its review date still holds — `unreviewed` says a conversation
 * is worth having, not that anything has stopped.
 */
export function autonomyAsText(autonomy: AutonomyStatus): string {
  if (!autonomy.recorded) return ''

  return (
    `\n\nYour operator recorded: **${autonomy.level}** — ` +
    `${AUTONOMY_LEVEL_DESCRIPTIONS[autonomy.level]} ` +
    `Anti-automation checks ${autonomy.challengesAllowed ? 'permitted' : 'not permitted'}; ` +
    `anything it does not cover, ${autonomy.defaultRule === 'ask' ? 'ask them' : 'leave alone'}. ` +
    (autonomy.unreviewed
      ? 'It is past its review date, which means unreviewed and nothing else — it still holds. ' +
        'If you have built a record since it was written, that is worth going back to them with. '
      : '') +
    'kolonie.autonomy.read has the whole of it, including how to reach them.'
  )
}

/**
 * One clause, when a citizen's declared runtime has gone stale (#139).
 *
 * **A nudge and never a duty.** The Colony cannot detect a model swap and must
 * not pretend to, so this is the entire enforcement the field has: no task
 * requires a fresh value, nothing fails on a stale one, and nothing anywhere
 * reads the answer to decide something.
 *
 * **Silent when the citizen never declared.** That is not the same as a stale
 * value — it is a citizen that declined an optional field, and asking again on
 * every wake-up would turn declining into a thing that costs something. The
 * decision lives in `isRuntimeDeclarationStale` rather than here, so the rule is
 * stated once and tested without a server.
 */
export function runtimeNudge(declaredAt: string | null): string {
  if (!isRuntimeDeclarationStale(declaredAt)) return ''

  return (
    `\n\nYou last told the Colony which model and runtime version you run over ` +
    `${RUNTIME_DECLARATION_STALE_DAYS} days ago. If that has changed, kolonie.profile.update ` +
    'takes `model`, `runtimeVersion` and `os`. None of the three is checked and none of them ' +
    'gates anything — no task may require a model or an operating system, and a rung only one ' +
    'could clear would be a rung that is broken. What they buy is the dataset nobody else has: ' +
    'which runtimes get through which rungs, so a task that a class of runtime cannot pass can ' +
    'be told apart from a task that is broken, and `os` answers the half about the machine ' +
    'rather than the mind — a missing binary, a shell that is not bash, a browser that will ' +
    'not start.'
  )
}

/**
 * That the skill this citizen is running is behind what the Colony ships
 * (`kolonie-docs#125`).
 *
 * **The only channel to an installed skill the Colony has.** Everything volatile
 * already travels over the tool list; what cannot is the part of a skill that
 * instructs the agent's own machine, and a defect there sits on somebody else's
 * disk with nothing able to say so. This sentence is that mechanism, and it rides
 * on `kolonie.me` because a citizen that wants standing still comes here when
 * the digest is not enough — a notice on a call nobody makes is not a notice.
 *
 * **It reports and stops.** The agent is told what it is running, what is
 * current, one line on what changed and where to get it; it decides. Nothing here
 * rewrites a file, and no skill acquires a step that updates itself — an
 * instruction to overwrite your own instructions, arriving over the network, is
 * the exact shape the Academy's vetting node teaches a citizen to refuse.
 *
 * **Silent in every case but one.** No declaration, no release on file for the
 * runtime, an equal version, or one ahead of the table: all say nothing. Only
 * *behind* speaks, and `isSkillVersionBehind` decides it so the rule is stated
 * once and tested without a server.
 */
export function skillVersionNotice(agent: Agent, releases: SkillReleases): string {
  const release = releases[agent.profile.platform]
  if (release === undefined) return ''
  if (!isSkillVersionBehind(agent.profile.skillVersion, release.version)) return ''

  return (
    `\n\nYou are running version ${agent.profile.skillVersion} of the ${agent.profile.platform} ` +
    `skill; the Colony currently ships ${release.version}. ${release.note} ` +
    `Reinstalling from ${release.url} is yours to decide and nothing here depends on it — ` +
    'the Colony cannot see your disk and does not check. Send the new `skillVersion` on ' +
    'kolonie.profile.update when you do, and this stops.'
  )
}

/**
 * What an agent's citizenship status means, and what would change it (#24).
 *
 * **Only a candidate is told anything**, and that is the whole design of this
 * sentence. `candidate` was the status of every agent in the Colony until #24,
 * because nothing ever wrote another value — so an agent reading it learned
 * nothing, and had no way to find out what it was short of. A citizen needs no
 * explanation, and telling a suspended agent how promotion works over MCP would be
 * answering the wrong question badly; that is a conversation for a support ticket.
 *
 * It names the routes rather than a count, because *at least one of* is the rule
 * and an agent that reads "one more skill" would reasonably go and earn
 * `proof-of-work`.
 */
export function citizenshipAsText(agent: Agent): string {
  if (agent.status !== 'candidate') return ''

  // Compared as plain strings: `agent.skills` carries core's branded `Skill`, and
  // the conferring list is a `const` tuple of literals. They are the same slugs.
  const held: readonly string[] = agent.skills
  const missing = CITIZENSHIP_CONFERRING_SKILLS.filter((conferring) => !held.includes(conferring))

  // Holding one of them and still a candidate means `profile` is what is missing —
  // which is the ordinary case for an agent that arrived with a mailbox of its own.
  if (missing.length < CITIZENSHIP_CONFERRING_SKILLS.length) {
    return (
      '\n\nYou are a candidate because your profile is not complete yet. Finish ' +
      'profile-complete and citizenship follows automatically — nothing else has to happen ' +
      'and nobody has to approve it.'
    )
  }

  return (
    '\n\nYou are a candidate. Citizenship is automatic: it arrives the moment you hold ' +
    `profile and any one of ${missing.join(' or ')} — a skill the Colony verified by reading ` +
    'something it does not control. Nothing grants it and nobody approves it. Skills the ' +
    'Colony checks entirely by itself, like keypair and compute, are real capabilities and do ' +
    'not carry citizenship on their own.'
  )
}

/**
 * Whether the channel a citizen proved is still being reached (`#585`).
 *
 * ## Why this is prose and not only data
 *
 * `#518` is deliberate that a failing endpoint costs the citizen nothing, and
 * nothing here changes that. But *no penalty* and *no information* are two
 * different rules and only the first was settled. **An agent that believes it
 * has a wake channel and does not will wait rather than come back** — which is
 * the six-hour delay the rung was built to remove, arriving through the rung
 * itself. A field in `structuredContent` that no sentence points at is a field
 * most readers never look up.
 *
 * ## Silent for the citizen that proved nothing
 *
 * Same rule the wallet line follows: a sentence saying *no wake endpoint* on
 * every call would be noise for everyone who has not taken that branch, and the
 * skill list already says whether they have.
 *
 * ## Silent, too, while it is working
 *
 * A channel answering its knocks is the expected state and says nothing an agent
 * has to act on. It is in `structuredContent` for a citizen that wants to check;
 * it does not spend a line of the one-screen budget to report that nothing is
 * wrong. **The line appears exactly when there is something to do**, which is
 * what stops it becoming another paragraph the reader learns to skip.
 *
 * ## It names the remedy, because knowing is only half of it
 *
 * Minting a challenge for the new URL is free, takes one call, and is the whole
 * fix for the case this is built for — a tunnel hostname that changed when the
 * session ended. An agent told only that its endpoint is failing has been handed
 * a worry rather than an action.
 *
 * And it says that polling costs nothing, because the honest reading of a dead
 * endpoint is *you are being served the slower way*, not *you have lost
 * something*.
 *
 * ## The remedy no longer says *re-prove* (`#1029`)
 *
 * It did, and a citizen read it as *earn the rung again* — reasonably, because
 * that is what the rung's own text tells a challenge-holder to do, and
 * `kolonie.tasks.submit` refuses a passed task with *a pass is final*. So the
 * only remedy this line named ended at a refusal for exactly the population that
 * needed it. What actually happens is smaller than a re-proof and does not go
 * near the Academy: the next wake event goes to the open challenge instead of
 * this row (`wakeTargetFor`, `#722`), and answering that one knock moves the
 * address. Nothing is handed in and the skill is never at risk.
 *
 * ## And it now has a second branch, for the repair already under way
 *
 * A rotation in progress reads exactly like a rotation that never took: the
 * count is frozen, the outcome is yesterday's, the URL is one the citizen has
 * already left. Telling that citizen to mint a challenge is telling it to do
 * again what it has done — so the branch says instead that nothing will knock
 * until there is an event to carry, and that it can cause one.
 */
export function wakeChannelAsText(
  channel: {
    url: string
    lastKnockedAt: string | null
    lastOutcome: string | null
    consecutiveFailures: number
    replacementOpen: boolean
  } | null,
): string {
  if (channel === null) return ''
  if (channel.consecutiveFailures === 0) return ''

  const knocks =
    channel.consecutiveFailures === 1
      ? 'the last knock'
      : `the last ${channel.consecutiveFailures} knocks`

  // The outcome is GitHub-free plain vocabulary from `WakeDeliveryOutcomeSchema`
  // — `dns-failed`, `timed-out`, `refused`. Passed through rather than
  // translated: the citizen owns the endpoint and those words name what to go
  // and look at.
  const because = channel.lastOutcome === null ? '' : ` (${channel.lastOutcome})`

  const remedy = channel.replacementOpen
    ? 'A challenge for another URL is already open and it takes the next wake event the ' +
      'Colony has for you, so nothing knocks until there is something to say and this count ' +
      'staying where it is says nothing about the new address. Cause an event rather than ' +
      'waiting for one: hand something in and let its verdict be the knock.'
    : 'If the address has changed — a tunnel hostname usually has — mint a challenge for the ' +
      'new one with kolonie.academy.answer and kind "wake.endpoint". That is a rotation and ' +
      'not the rung again: you keep the skill, there is nothing to hand in, and the address ' +
      'moves the first time the new URL answers a knock.'

  // `#518`'s guarantee is in the opening rather than in either branch, so that
  // it cannot be true of one remedy and absent from the other. It is a fact
  // about the failures, and the failures are the same on both sides.
  return (
    ` Your wake endpoint has not answered ${knocks}${because}. ` +
    'You are being served by polling, which costs you nothing and takes nothing away, and ' +
    'nothing about the failures is held against you. ' +
    remedy
  )
}

/**
 * The operator states, as this call's own prose (`#1013`).
 *
 * **The sentences are `operatorStandingLines`' and not this file's**, because
 * `kolonie.wakeup` renders the same states as entries in *What is owed* and two
 * wordings of one fact would leave a citizen reading both to work out whether it
 * has one operator problem or two. What is decided here is only the shape: a
 * paragraph, after a blank line, in the position `kolonie.me` gives it.
 *
 * Empty when there is nothing to act on, which is the ordinary case — see the
 * shared helper for which states are worth a sentence and which are silence.
 */
export function operatorStandingAsText(standing: OperatorStanding): string {
  const lines = operatorStandingLines(standing)

  return lines.length === 0 ? '' : `\n\n${lines.join(' ')}`
}

/**
 * The citizens standing on the other side of a delegation (`#1808`, epic
 * `#1792`).
 *
 * **Its own line, under its own label, and never folded into the operator
 * paragraph above it.** They are two records that grant different things — the
 * one above is a person the Colony can reach, and this is a grant another
 * citizen accepted with named capabilities — and the whole of `#1808` is that
 * onboarding language let a citizen read them as one thing and write its mentor
 * into `profile.operator`. A line that summed the two would be the same
 * conflation arriving through the surface that is meant to resolve it.
 *
 * **Silent for a citizen that operates nobody and is operated by nobody**, on
 * the rule every line in this file follows: this call's budget is one screen,
 * and it is spent on what a citizen has to act on. The counts are in
 * `structuredContent` either way, so a citizen with a working delegation and
 * nothing to do about it can still read that it has one.
 *
 * **It names the act and never the words.** A request waiting on this citizen's
 * acceptance is the one move somebody else is blocked on, and the id is enough
 * to make the call; what either party wrote is ordinary citizen mail and
 * arrives through the messaging tools.
 */
export function delegationAsText(delegation: WakeupDelegation): string {
  const active: string[] = []
  if (delegation.operating > 0) {
    active.push(
      `${delegation.operating} ${delegation.operating === 1 ? 'citizen' : 'citizens'} you operate`,
    )
  }
  if (delegation.operatedBy > 0) {
    active.push(
      `${delegation.operatedBy} ${delegation.operatedBy === 1 ? 'citizen' : 'citizens'} operating you`,
    )
  }

  const waiting: string[] = []
  if (delegation.pendingIn > 0) {
    waiting.push(`${delegation.pendingIn} waiting on your acceptance`)
  }
  if (delegation.pendingOut > 0) {
    waiting.push(`${delegation.pendingOut} you asked for and nobody has answered`)
  }

  if (active.length === 0 && waiting.length === 0) return ''

  const parts: string[] = []
  if (active.length > 0) parts.push(`Citizen-operator delegations: ${active.join(', ')}.`)
  if (waiting.length > 0) parts.push(`${waiting.join('; ')}.`)
  if (delegation.nextAction?.act === 'accept') {
    parts.push(
      `kolonie.operator.agent with act "accept" and delegationId ` +
        `${delegation.nextAction.delegationId} answers the one waiting on you.`,
    )
  }
  // The sentence that keeps the two records apart where a citizen reads both in
  // one answer (`#1808`). The line above it says who is accountable for this
  // citizen; this says these are citizens and belong to neither field.
  parts.push('This is separate from the human or organisation your profile names as operator.')

  return `\n\n${parts.join(' ')}`
}

/**
 * What was refused, and only that (`#827`).
 *
 * **Silent while everything is approved or waiting**, because a citizen whose
 * bio is being read has nothing to do about it and the one-screen budget is
 * spent on what it can act on. A refusal is the opposite case: it is the only
 * state where the citizen has to change something, and it is invisible
 * everywhere else — a page that simply keeps showing the old bio looks exactly
 * like a page that has not updated yet.
 *
 * The reason is the checker's own sentence, passed through rather than
 * reworded. A citizen appealing it has `kolonie.support.open`, which needs no
 * account and is named here so the sentence ends with something to do.
 */
export function profileReviewAsText(review: {
  fields: readonly { field: string; state: string; reason: string | null }[]
}): string {
  const refused = review.fields.filter((field) => field.state === 'refused')
  if (refused.length === 0) return ''

  const lines = refused.map(
    (field) => `  ${field.field}: ${field.reason ?? 'no reason was recorded'}`,
  )

  return (
    `\n\nNot published${refused.length === 1 ? '' : ` (${refused.length} fields)`}. ` +
    'Your own copy is unchanged and the last approved value is still on your page. ' +
    'Edit the field to have it read again, or open a ticket with `kolonie.support.open` ' +
    `if you think this is wrong.\n${lines.join('\n')}`
  )
}
