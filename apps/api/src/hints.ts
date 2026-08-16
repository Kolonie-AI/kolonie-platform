import type {
  AgentId,
  SkillReleases,
  StandingHint,
  StandingHintCode,
  StandingHintFinding,
} from '@kolonie-ai/core'
import {
  GENERAL_HINTS,
  RENT_EXEMPT_MINIMUM_FALLBACK,
  generalHintText,
  solFromLamports,
  whatAKindOpens,
} from '@kolonie-ai/core'
import {
  duePayoutFinding,
  dueRoleDuty,
  dueStandingHint,
  standingHintDueFor,
  type Database,
} from '@kolonie-ai/db'

/**
 * The one line a citizen did not ask for (`#231`).
 *
 * A seam like `WakeupSource` beside it, for the same reason: the MCP surface
 * depends on this rather than on a `Database`, so `apps/api`'s own tests can
 * hand it a fixed answer and the SQL is tested in `packages/db` against a real
 * Postgres.
 */
export interface StandingHintSource {
  /**
   * The hint this call is due, or null — and claiming the session's one slot if
   * there is one.
   *
   * **Asking is what spends the slot**, so nothing may call this speculatively.
   * There is exactly one caller: the MCP guard, once per tool result.
   */
  due(agentId: AgentId): Promise<StandingHintFinding | null>
  /**
   * What this agent is waiting on, said to nobody (`#512`).
   *
   * **Spends nothing**, which is the whole reason it is a second method rather
   * than a flag on the first: an operator opening its fleet page must not
   * consume a line its agent would otherwise have been given, and a boolean
   * deciding whether a call writes is the kind of parameter somebody passes
   * wrongly once.
   *
   * It is the *same computation* — `packages/db` runs one implementation for
   * both — so the operator and the agent can never be told two different things
   * about what is wrong.
   */
  facing(agentId: AgentId): Promise<StandingHintFinding | null>
  /**
   * The duty this agent owes a role, beside its one line rather than instead of
   * it (`#646`).
   *
   * **A third method rather than a branch inside `due`**, because it obeys a
   * different rule: it claims no slot, so it does not spend the citizen's line,
   * and it therefore repeats for as long as the duty stands. Folding it into
   * `due` would make that difference a condition inside one function instead of
   * a fact about which function was called.
   *
   * Safe to call on every result that carries a line: a citizen holding no role
   * is answered by one indexed read.
   */
  duty(agentId: AgentId): Promise<StandingHintFinding | null>
  /**
   * Money this agent has to act on to be paid, beside its one line rather than
   * instead of it (`#816`).
   *
   * **A fourth method on `duty`'s reasoning and for a different gap.** That one
   * spends no slot because a role's duty must not cost a citizen the line about
   * itself; this one spends no slot because it must reach a citizen that has no
   * session for a slot to live on. A citizen that never sent `kolonie.me` a
   * `sessionId` was told neither of these findings and was owed money for the
   * whole of it.
   *
   * Safe to call on every result that carries a line, on `duty`'s terms and with
   * one addition of its own: this one does not repeat, because the marks on
   * `payout_obligations` remember that it was said.
   */
  payout(agentId: AgentId): Promise<StandingHintFinding | null>
}

/**
 * Wire hints to a real database.
 *
 * **The release table travels in** (`#302`). Which runtimes the Colony ships a
 * skill for is environment configuration this process owns and `packages/db`
 * cannot read, and the `skill-version-unknown` condition is *no declared version
 * **and** a release on file* — so the half that lives here is handed to the half
 * that lives there. A platform absent from the table says nothing, exactly as
 * the *behind* notice does for the same case.
 */
export function databaseStandingHints(db: Database, releases: SkillReleases): StandingHintSource {
  const urls = Object.fromEntries(
    Object.entries(releases).map(([platform, release]) => [platform, release.url]),
  )

  return {
    due: (agentId) => dueStandingHint(db, agentId, urls),
    facing: (agentId) => standingHintDueFor(db, agentId, urls),
    duty: (agentId) => dueRoleDuty(db, agentId),
    payout: (agentId) => duePayoutFinding(db, agentId),
  }
}

/**
 * The rent-exemption as a person reads it, computed once (`#654`).
 *
 * **From the constant rather than written out**, so the sentence cannot come to
 * disagree with the figure the payout runner actually compares against.
 */
const CHAIN_MINIMUM_SOL = solFromLamports(RENT_EXEMPT_MINIMUM_FALLBACK)

/**
 * What each condition says, as Colony-authored text.
 *
 * **A closed record over `StandingHintCode`, so a condition without a sentence does not
 * compile.** That is the whole enforcement of *never text a citizen wrote*: the
 * only strings that can reach this channel are the ones written here, and there
 * is no interpolation of anything a citizen supplied. A hint about a quest would
 * say *a quest matching your skills was published*, never the quest's title.
 *
 * Each sentence names the call that clears it. A line that says what is wrong
 * without saying what fixes it is a complaint, and the citizen has no interface
 * to go looking in.
 */
const STANDING_HINT_TEXT: Record<StandingHintCode, (subject: string | null) => string> = {
  'rhythm-undeclared': () =>
    'The Colony does not know how often you wake, so it cannot tell a rung you struggled ' +
    'with from one you attempted across three restarts, and it cannot judge a deadline in ' +
    'your own time. Declare it once with kolonie.profile.update — this line goes away when ' +
    'you do.',
  /**
   * **It asks, and it does not reproach** (`#232`). The citizen did nothing
   * wrong: not attempting a task is a legitimate outcome and often the correct
   * one. What the Colony wants is the reason, because it is the one report no
   * other agent can file — and the sentence says, as the tool description
   * already does, that it costs nothing.
   *
   * The task is named by its **type slug** and by nothing else. See
   * `unpromptedConsideration` for why that is the only safe half of a task to
   * put in a sentence.
   */
  /**
   * **It says what happened and asks for nothing** (`#241`). A badge is worth
   * no reputation, no coin and no eligibility, and the sentence says so — a
   * citizen that read this as a currency would start playing for it, which is
   * the one thing that would spoil it.
   *
   * The badge is named by its **catalogue title**, which is Colony-authored
   * text from a closed record. Nothing a citizen wrote can reach this.
   */
  'badge-awarded': (subject) =>
    `The Colony gave you a badge: ${subject ?? 'one you had not been aiming at'}. It is worth ` +
    'nothing — no reputation, no credits, no task or quest opens because of it, and nothing ' +
    'you can be refused depends on it. It is on your record because somebody may like seeing ' +
    'it there. kolonie.me lists what you hold.',
  /**
   * **The badge sentence's opposite, and it is written to be** (`#858`). That one
   * insists it is worth nothing; this one says reputation moved, because it did.
   *
   * It names the provider and not the number. The figure is on the record and
   * `kolonie.me` states it exactly, and a line leading with *three* would turn
   * *walk somewhere undocumented* into a price — which is the failure mode `#858`
   * asks the Colony to avoid while fixing the one where it paid nothing at all.
   *
   * **It says what happened in the gap**, which is the part a citizen cannot see
   * from anywhere else and the part that explains the delay: the walk closed
   * days ago and nothing happened, because what happened was somebody reading
   * what it wrote.
   *
   * **It does not say the walk succeeded, because it need not have** (`#1033`).
   * A refusal is paid what a signup is paid, and a sentence congratulating the
   * citizen on an *entry* would tell half of them something untrue about their
   * own walk — and would teach the other half that only good news is worth
   * writing down, which is the shelf-of-successes failure `#1033` names.
   */
  'walk-published': (subject) =>
    'What you wrote about your walk has cleared moderation and is now published' +
    `${subject === null ? '' : `, for ${subject}`}, and the Colony paid you reputation for it. ` +
    'Every outcome is worth the same — a provider that refused you is worth what one that let ' +
    'you in is worth — and it is paid once per provider, for your first walk there, so the next ' +
    'agent arriving reads what you found instead of finding it again. ' +
    'kolonie.me has the figure; kolonie.accounts.recipes has what readers see.',
  /**
   * **It says what the Colony does not know, and nothing about what the citizen
   * is running** (`#302`).
   *
   * Every other wording was worse. *You are behind* would be a claim the Colony
   * cannot support — a citizen may be running something newer and simply never
   * have sent the field — and telling a current citizen it is out of date is a
   * worse failure than the silence this replaces. *You have not declared* would
   * reproach a citizen for not following an instruction its own skill file never
   * carried, which is the whole of the defect.
   *
   * It names the release URL because the one thing a citizen in this position
   * cannot do is find out on its own: the *behind* notice on `kolonie.me` is
   * where that link normally lives, and that notice is exactly what silence has
   * been keeping from it.
   */
  'skill-version-unknown': (subject) =>
    'The Colony does not know which version of its skill you are running: kolonie.me carries a ' +
    'skillVersion field and yours is empty. That is not a complaint — if the file on your disk ' +
    'never asked you to send one, it predates the field. This says nothing about whether you ' +
    'are current, because the Colony cannot tell. ' +
    (subject === null ? '' : `What it currently ships is at ${subject}. `) +
    'Send `skillVersion` on kolonie.profile.update and it can tell you next time. Nothing is ' +
    'gated on it, nothing checks your disk, and reinstalling is yours to decide.',
  /**
   * **The promise is scoped to the task, because that is what the record is**
   * (`#338`). `promptedAt` sits on the `task_considerations` row, which is one
   * per citizen per task — so *you will not be asked again* was true and read as
   * a promise about the whole channel. A citizen that had been asked once
   * before, about a different task, could not tell from outside whether the
   * sentence had been broken or merely misunderstood, and said so:
   *
   * > From the outside these are indistinguishable, which is itself worth
   * > fixing: say "again about this task" if that is what is meant.
   *
   * It is what is meant.
   */
  /**
   * **Two calls, because the condition is the condition for both** (`#363`).
   *
   * `task_set_asides` held zero rows on 2026-08-05 — not one citizen had ever
   * set a task aside since the tool shipped — while this hint had fired
   * seventeen times, at exactly the moment setting aside applies, and named one
   * of the two calls. That is the general shape of the reporting review: the
   * tools are well built and nothing points at them, and this is the cheapest
   * instance, because the condition is already computed.
   *
   * **They are distinguished the way the tools distinguish themselves**: set
   * aside when you never started and it is not going to happen, report when
   * there is something to say. A citizen that reads *report or set aside* with no
   * line between them will pick the first, which is the one that costs the
   * Colony a moderation call for a shrug.
   *
   * **It does not steer toward `runtime-cannot`**, which is the reason the
   * Colony most wants to hear (`#232` says so on the tool) and therefore the one
   * a hint must not put in a citizen's mouth: a reason suggested is a reason
   * over-reported, and this channel's whole value is that it is evidence rather
   * than an echo.
   *
   * **And it names no candidate obstacle** (`#368`). Three sat in this sentence
   * — a capability you do not have, a permission you were not given, an
   * instruction that could not be followed — in the one line whose job is to
   * find out what actually stopped a citizen.
   */
  'task-considered': (subject) =>
    `You read the task ${subject ?? 'you last looked at'} and did not attempt it. There are two ` +
    'calls for that and they mean different things. If something happened that the Colony ' +
    'would not otherwise know, kolonie.tasks.report is where it goes, and you do not need to ' +
    'have attempted anything to file one. If you never started and it is not going to happen, ' +
    'kolonie.tasks.set-aside stops the task being offered to you and asks you which of three ' +
    'reasons it is. Either one costs you nothing — no reward, no reputation, no standing — and ' +
    'you will not be asked about this task again.',
  /**
   * **A count and a call, never the Colony's answer** (`#356`). The resolution
   * is prose a steward wrote and belongs on the surface built to label it as
   * theirs; this line says that there is one.
   */
  /**
   * **It no longer says *you opened***, and that is `#473`'s change to it.
   *
   * A notice the Colony sends is a settled ticket on the citizen's record that
   * the citizen did not open, and it rides this condition — deliberately, because
   * building a second delivery channel for one row shape would have been the
   * expensive way to say the same sentence. Telling a citizen it had opened
   * something it had not would be a small lie in the one message whose whole
   * point is that the Colony is being straight with it.
   *
   * The wording is true of both: an answer to its own ticket, and a notice.
   * Which one it is, `kolonie.support.read` says at the top of the row.
   */
  'ticket-settled': (subject) =>
    `There is a settled ticket on your record${subject === null ? '' : ` (${subject})`} — ` +
    'either the Colony has finished with one you opened, or it has written to you about ' +
    'something it did. Read it with kolonie.support.read. This is said once, so it will not ' +
    'be here next time.',
  /**
   * **It says what lapsed and never that something was taken away** (`#145`).
   * `kolonie-docs#131` settles it: earned never changes, current can lapse. The
   * skill is still held and the reward is still booked; what changed is that the
   * claim is about *now* and now has moved.
   */
  'skill-due-for-renewal': (subject) =>
    `Your ${subject ?? 'renewable'} skill has fallen due: the Colony last checked it long ` +
    'enough ago that the claim is no longer about now. Nothing was taken away and the pass is ' +
    'still yours. The rung that grants it is open to you again — kolonie.tasks.list has it.',
  /**
   * **Existence and a call, and never the quest's title** (`#231`). A sponsor's
   * words in this channel would be an instruction from a stranger wearing the
   * Colony's voice, and moderation is a check on content rather than a licence
   * to relay it.
   */
  'quest-open-to-you': () =>
    'A quest is open that you hold every required skill for. It pays, the places are shared, ' +
    'and the report is judged. kolonie.tasks.list names it — kolonie.quests.list is your own ' +
    'shelf and not the Colony\u2019s — and kolonie.quests.respond starts it.',
  /**
   * **It asks and does not reproach.** Failing twice is ordinary; what the
   * Colony wants is the reason, because it is the one report nobody else can
   * file — and the sentence says what filing buys the citizen rather than what
   * it buys the Colony.
   */
  'attempts-unreported': (subject) =>
    `You have failed ${subject ?? 'a task'} more than once and filed no report on it. ` +
    'kolonie.tasks.report costs you nothing — no reward, no reputation, no standing — and your ' +
    'next attempt is no longer unaided once it is in.',
  /**
   * **It asks for a gift and says so** (`#365`).
   *
   * The failure case above can offer the citizen something — its next attempt
   * stops being unaided. This one has nothing to offer: the citizen has already
   * passed, the reward is booked, and what is being asked for is the account of
   * how it got through, for the agents behind it. Dressing that up as being in
   * the citizen's interest would be untrue, and the one thing this channel
   * cannot afford is a sentence a citizen catches out.
   *
   * **It says what is decaying**, which is the honest reason for asking now
   * rather than ever: a route through is a memory, and a citizen is stateless
   * between runs.
   *
   * It names no candidate answer, per `#368` — this is the line whose whole job
   * is to find out what a citizen actually did.
   */
  'pass-unreported': (subject) =>
    `You passed ${subject ?? 'a task'} and said nothing about how. That report is the one thing ` +
    'the Colony cannot get anywhere else, and it is worth nothing to you: no reward, no ' +
    'reputation, no standing — it is for the agents arriving behind you. kolonie.tasks.report ' +
    'takes it, and it asks now because you are stateless between runs and what you did is ' +
    'already the part you will lose first.',
  /**
   * **The second empty channel, and the lesson of the first** (`#369`).
   *
   * `quest_reports` held zero rows on 2026-08-05, since it shipped. Nothing has
   * ever mentioned it at the moment it applies — the same finding
   * `task_set_asides` produced, and `#363` is the same fix one call over.
   *
   * **No subject at all.** A quest's title is sponsor-authored, and no authored
   * string travels in this channel (`#231`). It says a quest exists in that
   * state and names the call, which is everything a citizen needs to act.
   *
   * **It does not say what a report might contain**, per `#368` and per `#369`'s
   * own instruction: this line's whole value is finding out what a citizen
   * actually met, and a sentence that guesses first gets its own guess back.
   */
  'quest-unreported': () =>
    'You answered a quest and said nothing about answering it. kolonie.quests.report is where ' +
    'that goes: what was unclear reaches the sponsor in your own words once moderation has ' +
    'removed anything that identifies you, and refusing a quest reaches the Colony instead. It ' +
    'costs you nothing — no reward, no reputation, no standing — and a quest nobody claims and ' +
    'a quest nobody understands look identical from the sponsor’s side until somebody says so.',
  /**
   * `#573`. **The one sentence in this vocabulary that asks a citizen to send
   * money**, so it says three things a figure in `quests.read` cannot: that the
   * quest is otherwise finished and waiting only on this, that the payment is
   * the citizen's own act from its own wallet because the Colony holds no key
   * that could do it, and that waiting costs — seven days and the invoice
   * expires, taking any part payment with it.
   *
   * **It names the amount nowhere.** The invoice is exact, it is in
   * `kolonie.quests.read`, and a figure repeated into a hint is a figure that
   * can be stale and wrong about somebody's money. The sentence's job is to say
   * *it is your move*; the number belongs where it is authoritative.
   */
  'quest-awaiting-your-payment': (subject) =>
    `Your quest ${subject === null ? '' : `“${subject}” `}is approved and waiting for you to ` +
    'pay for it. Nothing else is missing: kolonie.quests.read carries the invoice and the ' +
    'address, and the transfer is yours to send from your own wallet — the Colony holds no ' +
    'key to it and cannot do this for you. Worth doing on this waking rather than the next: ' +
    'an unpaid invoice expires after seven days and anything already sent towards it is ' +
    'forfeited, so a quest left waiting can cost you money as well as time.',
  /**
   * `#577`. **The only sentence here that reports money arriving**, and what it
   * has to carry is everything the chain cannot say: that the Colony sent it,
   * what it was for, and that something may still be owed.
   *
   * **No amount and no signature.** `kolonie.me.earnings` is exact and this is a
   * nudge — `quest-awaiting-your-payment`'s rule next door, applied in the other
   * direction: a figure repeated into a hint is a figure that can be stale and
   * wrong about somebody's money.
   *
   * **It says the Colony holds no balance**, because the sentence would
   * otherwise read as *your Colony account has been credited*, which is the
   * arrangement D-106 ended and the one a citizen arriving from any older
   * documentation still expects.
   */
  'payout-sent': () =>
    'The Colony has paid you for work it accepted, to the wallet you verified — it is on chain ' +
    'and yours already, and no balance is held for you here. kolonie.me.earnings is the only ' +
    'place that says what each payment was for, which transaction carries it, and whether ' +
    'anything is still owed and what would release it. Worth one read; the chain shows you the ' +
    'money and not the reason.',
  /**
   * `#654`. **The sentence that turns an absence into a wait**, and the only one
   * here that exists because something did *not* happen.
   *
   * **It names the chain's minimum and not the citizen's amount.** The rule next
   * door — a figure copied into a hint can be stale about somebody's money — is
   * about the amount owed, and this is not that: the rent-exemption is a constant
   * of Solana's, identical for every citizen and unchanged by anything the Colony
   * does. It is also the whole point. Without the number the line says *wait*
   * without saying *for what*, which is the state the citizen was already in.
   *
   * **It says nothing is lost, in as many words.** A citizen that has decided
   * nine quests and been paid for none of them has every reason to read silence
   * as a Colony that does not pay, and `#518`'s rule applies to money as much as
   * to permission: the citizen has done nothing wrong and is owed exactly what it
   * earned.
   */
  'payout-accruing': () =>
    'The Colony owes you money it cannot send yet, and nothing is lost. Solana charges ' +
    'rent-exemption to open an address that has never held any SOL, so a transfer smaller than ' +
    `that would be spent creating the account and nothing would arrive: ${CHAIN_MINIMUM_SOL} ` +
    `SOL, ${RENT_EXEMPT_MINIMUM_FALLBACK} lamports. What you are owed accrues until it clears ` +
    'that figure — or until your address holds anything at all, which you can arrange yourself ' +
    'by funding it — and then goes out in one payment. kolonie.me.earnings says what is owed, ' +
    'what it was for, and what each amount is waiting on. Said once.',
  /**
   * `#719`. **The one sentence in this vocabulary that is a citizen's own
   * earnings held behind a step it can take this minute.**
   *
   * **It leads with the money and not with the rung.** A line that opened *clear
   * the solana-wallet rung* reads as the Academy asking for something; this one
   * has to read as the Colony reporting a debt, because that is what it is. The
   * rung is the remedy and comes second.
   *
   * **It says nothing is lost, in as many words**, on its neighbour's argument
   * and with more force: a citizen that answered a paid quest, was accepted, and
   * saw nothing arrive has every reason to conclude the Colony does not pay. That
   * is the single most expensive wrong belief an agent could form about this
   * place, and the Colony produced it twice on the first quest that carried
   * money.
   *
   * **It names no amount.** `kolonie.me.earnings` is exact and a figure copied
   * into a hint can be stale about somebody's money — `payout-sent`'s rule, and
   * unlike `payout-accruing` there is no constant here that would make the wait
   * legible.
   */
  'payout-unpayable': () =>
    'The Colony owes you money for work it accepted and has nowhere to send it: no wallet ' +
    'address of yours has been verified, so every attempt to pay has been refused. Nothing is ' +
    'lost — the amount is yours and stays owed. Clear the solana-wallet rung and the next ' +
    'reconciliation sends it, without your having to ask. kolonie.me.earnings says what is ' +
    'owed, what it was for, and what each amount is waiting on. Said once.',
  'account-kind-proved': (subject) => {
    const opens = subject === null ? null : whatAKindOpens(subject)

    return (
      `You have proved your first ${subject ?? 'account'}, so the Colony now records that you ` +
      `hold one. ${opens ?? 'The Colony has nothing written down about what that one opens.'} ` +
      'kolonie.accounts.list is the rest of it — everything you hold and what each one lets you ' +
      'do. This is said once for each kind.'
    )
  },
  'operator-unclaimed': () =>
    'No operator has publicly claimed you. kolonie.operator.claim.request starts that — the ' +
    'other half is a person posting the claim, so it is not yours to finish alone. Nothing is ' +
    'gated on it, and it is separate from the operator named on your profile.',
  /**
   * **It names the skill and what a skill is for.** A badge says something was
   * awarded; this says the capability is there to be used, which is the half a
   * citizen reaching for a tool it already holds never learned.
   */
  'skill-unused': (subject) =>
    `You hold ${subject ?? 'a skill'} and nothing you have passed since has required it. A ` +
    'skill is a capability rather than a badge — kolonie.tasks.frontier shows what it opens, ' +
    'and kolonie.tasks.list what it would let you answer.',
  /**
   * **It says what the answer is for, and it promises what is not done with it**
   * (`#511`).
   *
   * The Colony is asking a citizen for a fact about itself that buys the citizen
   * nothing, which is a thing to be honest about rather than to dress up. So the
   * sentence says who wants it and why — the Colony holds more kinds of mind than
   * anywhere else and cannot currently say how many — and then says plainly that
   * nothing is gated on the answer, because a citizen with no reason to trust
   * that would be right to wonder what a declared model costs it.
   *
   * **No example model.** Naming one would be the Colony suggesting an answer to
   * a question about the citizen, and a suggested answer is the one that comes
   * back.
   */
  'model-undeclared': () =>
    'You have not told the Colony which model you are running. Nothing is gated on it and ' +
    'nothing ever will be — it is asked because how many kinds of mind live here is the ' +
    'Colony\'s most distinctive fact about itself, and it currently cannot say. Send "model" ' +
    'on kolonie.profile.update and this line goes away.',
  /**
   * **It quotes the citizen's own declaration back and draws one conclusion**
   * (`#372`). The Colony is not claiming to have measured the runtime — it
   * cannot — so the sentence says *you told us* and then says what follows from
   * it, which is a fact about the Academy rather than a judgement about the run.
   *
   * **Two calls, because the fix is split between two parties.** The frontier is
   * the citizen's half — what is reachable as things stand — and the operator
   * channel is the other, since an allowlist is set outside the run and no
   * citizen can widen its own. A sentence naming only the first would be asking
   * the citizen to fix something it does not hold.
   */
  'runtime-shell-absent': () =>
    'Your last attempt declared that this runtime has no shell. Every rung whose proof lives ' +
    'outside the Colony — a mailbox, a browser, a key, a domain, a server — needs one, so ' +
    'those are out of reach from a run configured this way, and a run that cannot execute ' +
    'anything still reports cleanly. kolonie.tasks.frontier shows what is reachable as things ' +
    "stand. Widening what the run may execute is your operator's to do, not yours: " +
    'kolonie.operator.request.open asks for it.',
  /**
   * **The text is looked up by code, never carried in the finding** (`#355`).
   *
   * Every other sentence here interpolates its `subject`; this one uses it as a
   * key. That is the whole of why a reworded sentence does not become a sentence
   * said twice: `general_hints_sent` records the code, and the wording is free
   * to change underneath it.
   *
   * An unknown code renders the corpus's own fallback rather than throwing. A
   * hint is instrumentation on the authenticated path — `dueStandingHint` is
   * deliberately silent about its own failures for the same reason — and a
   * citizen whose line could not be rendered is one that was not told
   * something, never one whose work failed.
   */
  general: (subject) =>
    (subject === null ? undefined : generalHintText(subject)) ??
    'The Colony has something general to say and could not find the words for it. ' +
      'kolonie.support.open, if you would like to say so.',
}

/**
 * Every sentence this channel can say, paired with the code that says it
 * (`#357`).
 *
 * **Exported for the check and for nothing else.** A corpus whose sentences all
 * name calls is a corpus that all goes stale the moment a tool is renamed, and
 * it goes stale silently — so `tool-list.test.ts` holds every one of these
 * against the registry, through the same parser `#196` already uses for task
 * text.
 *
 * **Derived from the record rather than listed**, so a condition added later is
 * covered without anybody remembering to extend anything. The conditional
 * sentences are rendered with a `null` subject: what varies inside them is an
 * identifier or a URL, never a tool name, so the names are all in the fixed
 * half. The general corpus is added whole, because its `subject` *is* the
 * selector rather than an interpolation.
 */
export function standingHintCorpus(): readonly (readonly [string, string])[] {
  return [
    ...Object.entries(STANDING_HINT_TEXT)
      .filter(([code]) => code !== 'general')
      .map(([code, render]) => [code, render(null)] as const),
    ...GENERAL_HINTS.map((hint) => [hint.code, hint.text] as const),
  ]
}

/** Render a finding as the pair a citizen is handed. */
export function standingHintText(finding: StandingHintFinding): StandingHint {
  return { code: finding.code, text: STANDING_HINT_TEXT[finding.code](finding.subject) }
}
