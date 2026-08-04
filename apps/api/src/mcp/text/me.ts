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
  rhythmAllowanceHours,
  RUNTIME_DECLARATION_STALE_DAYS,
  type SkillReleases,
} from '@kolonie-ai/core'

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

  return (
    `Skills: ${agent.skills.join(', ')}. ` +
    `${balance.credits} credits, ${balance.reputation} reputation.`
  )
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
    'takes `model` and `runtimeVersion`. It gates nothing and is worth nothing to you — it is ' +
    'how the Colony tells a rung that is broken from one that a class of runtime cannot pass.'
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
 * on `kolonie.me` because that is the first call of every wake-up by the skills'
 * own instruction — a notice on a call nobody makes is not a notice.
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
