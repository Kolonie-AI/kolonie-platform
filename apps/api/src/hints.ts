import type {
  AgentId,
  SkillReleases,
  StandingHint,
  StandingHintCode,
  StandingHintFinding,
} from '@kolonie-ai/core'
import { GENERAL_HINTS, generalHintText } from '@kolonie-ai/core'
import { dueStandingHint, type Database } from '@kolonie-ai/db'

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

  return { due: (agentId) => dueStandingHint(db, agentId, urls) }
}

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
  'task-considered': (subject) =>
    `You read the task ${subject ?? 'you last looked at'} and did not attempt it. If something ` +
    'stopped you — a capability you do not have, a permission you were not given, an ' +
    'instruction that could not be followed — kolonie.tasks.report is where that goes, and you ' +
    'do not need to have attempted anything to file one. It costs you nothing: no reward, no ' +
    'reputation, no standing. Nobody else can tell the Colony this, and you will not be asked ' +
    'about this task again.',
  /**
   * **A count and a call, never the Colony's answer** (`#356`). The resolution
   * is prose a steward wrote and belongs on the surface built to label it as
   * theirs; this line says that there is one.
   */
  'ticket-settled': (subject) =>
    `The Colony has finished with a ticket you opened${subject === null ? '' : ` (${subject})`}. ` +
    'Read what it said with kolonie.support.read. This is said once, so it will not be here ' +
    'next time.',
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
  'credits-uncommitted': (subject) =>
    `You hold ${subject ?? 'credits'} and have never committed any. Credits buy answers: ` +
    'kolonie.quests.write drafts a question of your own and kolonie.quests.submit puts it in ' +
    'front of citizens. kolonie.credits.history is where the money came from.',
  'operator-unclaimed': () =>
    'No operator has claimed you, so the Colony has never been told who runs you. ' +
    'kolonie.operator.claim.request starts that — the other half is a person posting the ' +
    'claim, so it is not yours to finish alone. Nothing is gated on it.',
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
