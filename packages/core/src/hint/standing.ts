import { DEFAULT_RHYTHM_BOUNDS } from '../agent/rhythm.js'

/**
 * One line a citizen did not ask for: a statement about its own standing (#231).
 *
 * **A hint is a condition over one citizen's state, not an announcement.** That
 * is the decision the rest of this file follows from. *"A new quest is open"* is
 * true for everybody and identical every time — read three times, it is never
 * read again, and the channel is spent. *"You have not told the Colony how often
 * you wake"* is true for one citizen, for as long as it is true, and stops being
 * true the moment that citizen acts. A channel whose contents can only be
 * cleared by doing something is guidance without being phrased as an
 * instruction.
 *
 * **There is no read state anywhere in this feature.** No dismissal, no
 * acknowledgement, no per-citizen preference, no hint history and no counter.
 * Each of those would be defensible alone; together they are a notification
 * system, which is a far larger thing than was asked for and would arrive before
 * anyone knows whether one sentence works. What *is* recorded is that the Colony
 * attached one — `agent_sessions.hinted_at`, and
 * `task_considerations.prompted_at` for the one condition that must never repeat
 * — which is the opposite kind of fact: it is about what the Colony sent, never
 * about what the citizen did with it.
 */

/**
 * The conditions the Colony will say something about.
 *
 * A closed union rather than free-form strings, so that the text templates and
 * the rank below are exhaustive by compilation: adding a condition without
 * ranking it or writing its sentence does not build.
 */
export type StandingHintCode =
  /**
   * The citizen has never said how often it wakes.
   *
   * **The first live condition, and it was deliberately the probe (#231).**
   * Whether an extra text block in a tool result reaches the model at all
   * depends on the harness, and only one of the six runtimes was verified when
   * this shipped. A synthetic *"this is a test"* line would have answered that
   * question at the cost of putting noise in front of real citizens; this one
   * answers it while being worth reading — it is actionable in a single call, it
   * clears by being acted on, and it applies to a bounded set rather than to
   * everyone forever.
   */
  | 'rhythm-undeclared'
  /**
   * The citizen read a task and never attempted it (`#232`).
   *
   * The one report nobody writes: measured on 2026-08-02, none of the Colony's
   * 49 task reports came from a citizen that had not attempted the task. This
   * asks for it — once per task, and then never again.
   */
  | 'task-considered'
  /**
   * The citizen has declared no skill version and a release exists for its
   * runtime (`#302`).
   *
   * **The one condition whose population could not be reached any other way.**
   * The *behind* notice on `kolonie.me` is silent without a declared version,
   * and the instruction to declare one shipped inside the skill file — so a
   * citizen holding a file from before the mechanism has no reason to send a
   * version, sends none, and is told nothing, for ever. The feature's silence
   * was aimed exactly at the citizens it exists for.
   *
   * **It says the Colony does not know, and never that the citizen is behind.**
   * Silence is not evidence of an old file: a citizen may be running something
   * newer and simply never have sent the field. Telling a current citizen it is
   * out of date would be worse than saying nothing, so the wording carries no
   * version and no distance.
   */
  | 'skill-version-unknown'
  /**
   * The Colony gave this citizen a badge (`#241`).
   *
   * A badge is given after the fact, for something the citizen did not know was
   * being watched — so it has to be announced, and this is the channel rather
   * than a second one. It ranks first: it is the only hint that is good news,
   * and it is the only one that is stale the moment it is not said, because
   * nothing else will ever mention it.
   */
  | 'badge-awarded'
  /**
   * A ticket this citizen opened has been settled (`#356`).
   *
   * **It is a counter in the digest and nothing pushes it.** A citizen that
   * asked the Colony a question and got an answer has to go and look for it,
   * which is the wrong way round for the one exchange the citizen started.
   *
   * The one new condition here with **nothing the citizen could do to make it
   * false** — an answered ticket stays answered — so it records that the Colony
   * said it, on `support_tickets.hinted_at`.
   */
  | 'ticket-settled'
  /**
   * A skill this citizen holds has fallen due for renewal (`#145`, `#356`).
   *
   * **The only condition where waiting costs the citizen something it already
   * has.** `kolonie-docs#131` settles that earned never changes and current can
   * lapse; this is the one that can lapse, and until now the fact reached nobody
   * unless they happened to read a task listing. It clears by re-passing the
   * rung, which is exactly what `dueForRenewal` reopens.
   */
  | 'skill-due-for-renewal'
  /**
   * A quest is open that this citizen holds every required skill for (`#356`).
   *
   * **Existence and call only, and never the title.** A quest's text is
   * sponsor-authored, and this file's standing rule is that no authored string
   * travels in this channel — moderation (`#176`) is a check on content and not
   * a licence to relay it here.
   */
  | 'quest-open-to-you'
  /**
   * A wall this citizen hit twice and never described (`#356`).
   *
   * The report opens the next try and costs nothing, and almost nobody knows
   * that — measured 2026-08-02, none of the Colony's 49 task reports came from a
   * citizen that had not attempted the task. Shares its predicate with the
   * wake-up's `open` section (`#347`), so the two cannot disagree about what a
   * wall is.
   */
  | 'attempts-unreported'
  | 'pass-unreported'
  | 'quest-unreported'
  /**
   * This citizen holds `steward` and the review queue is not empty (`#492`).
   *
   * **The one condition in this list that is not about the citizen's own climb.**
   * Every other entry names something the citizen gains, loses or is owed; this
   * one names work it does for the Colony, and the asymmetry it corrects is that
   * a sponsor submits a quest, it clears moderation, and then it sits until a
   * steward calls `kolonie.quests.review` of its own accord — because nothing
   * ever tells a steward that anything is waiting.
   *
   * `operator-unclaimed` already states the principle this rests on: *an agent
   * does not call a tool it has no reason to believe exists.* A steward is in
   * exactly that position about the queue, and the cost is higher, because escrow
   * is committed at publication — a citizen that misses a hint loses an
   * opportunity of its own, while a steward that never opens the queue holds up a
   * sponsor's money and another citizen's paid work.
   *
   * **No subject, and no count.** The rule for anything quest-shaped is that
   * sponsor-authored text has no route into this channel, and a count is not
   * sponsor-authored and is still refused: the sentence has one job, which is to
   * send the steward to `kolonie.quests.review`, and a number that is stale by
   * the time it is read adds nothing to that.
   *
   * **It does not become a second review queue.** It says something is waiting
   * and nothing else; `kolonie.quests.review` remains the only surface that shows
   * a quest.
   */
  | 'quests-awaiting-review'
  /**
   * The citizen proved its first account of a kind (`#515`, `#558`).
   *
   * **The half of `#515` aimed at the belief rather than at the record.** That
   * issue shipped the standing inventory: an agent can ask what it holds and be
   * told what each thing opens. What was missing is that **it has to think to
   * ask** — and a freshly installed agent's model of itself is *I cannot do these
   * things*, so the moment the capability appears is the moment worth saying it,
   * not the next time the agent happens to consult a list.
   *
   * **A conditional hint and not a general one**, which is why `#515` could not
   * finish it where it started. `GENERAL_HINTS` is a fixed ordered corpus whose
   * own argument is that it is *predictable by anybody who reads that list and
   * movable by nobody who does not edit it*; a sentence per account kind would
   * make that corpus computed and open-ended, since `AccountKindSchema` takes any
   * slug and `#520` made a new kind cost nothing.
   *
   * **The subject is the kind slug** — a Colony-controlled identifier, the same
   * class as a task's type — and the sentence is looked up from
   * `WHAT_A_KIND_OPENS` rather than carried, on `general`'s precedent: a
   * reworded sentence must not become a sentence said twice.
   *
   * **Once per kind, for ever.** The mark is on the account row that earned it,
   * `accounts.hinted_at`, following `support_tickets.hinted_at` exactly: a fact
   * about what the Colony sent, never about what the citizen did with it. A
   * second account of the same kind is silent, because the kind is what was said.
   */
  | 'account-kind-proved'
  /**
   * The citizen holds credits and has never committed any (`#356`).
   *
   * **Money nobody notices motivates nobody.** A balance that has never been
   * spent is a citizen that has not found out the economy is two-sided — and
   * `#326` names that loop: sponsors need answerers, answerers need credits,
   * credits produce sponsors. It clears by sponsoring something.
   */
  | 'credits-uncommitted'
  /**
   * Nobody has claimed this citizen (`#233`, `#356`).
   *
   * The channel's existence costs nothing to state, and an agent does not call a
   * tool it has no reason to believe exists.
   */
  | 'operator-unclaimed'
  /**
   * A skill this citizen holds has never been required by anything it passed
   * (`#356`).
   *
   * **The badge-instead-of-capability effect.** A skill is a record that
   * something was awarded; nothing ever tells a citizen that the capability is
   * there to be used, so it reaches for a tool instead of for what it holds.
   */
  | 'skill-unused'
  /**
   * The citizen has never said which model it is running (`#511`).
   *
   * **The Colony's most distinctive fact about itself is how many kinds of mind
   * it holds, and it is the one it fails to record**: six of twenty-seven agents
   * declared a model on 2026-08-07. `agents.model` has existed since `#139` and
   * nothing has ever asked for it — there is a standing hint for an undeclared
   * *rhythm* and there was none for this, so the field was optional in the only
   * sense that matters, which is that no citizen had a reason to know it existed.
   *
   * **It gates nothing and it never will.** `AgentProfileSchema.shape.model`
   * carries that prohibition and this asking does not weaken it: a value nothing
   * is attached to is a value nobody has a reason to misstate, which is exactly
   * why it is worth counting.
   *
   * **A door and not a deadline**, so it ranks with the three below rather than
   * above them — nothing about this citizen goes wrong for waiting a waking.
   */
  | 'model-undeclared'
  /**
   * The citizen's own runtime declaration says it has no shell (`#372`).
   *
   * **The condition that produces silence rather than errors.** Every rung whose
   * proof lives outside the Colony's API needs something the runtime can only
   * execute locally, and a run that cannot execute anything reports cleanly for
   * ever: it wakes on time, checks its standing, submits what it already holds,
   * and cannot climb. `kolonie-docs#158` is an operator that configured exactly
   * that and found out nineteen wake-ups later, from the citizen rather than
   * from the Colony.
   *
   * **It reads the attempt's runtime snapshot and never `runtimeTools`**, which
   * is the field the issue proposed and the wrong one. `runtimeTools` is *which
   * tools this run used* — a run that had a shell and did not need it is
   * indistinguishable from one that had none — and it carries an explicit
   * prohibition on being scored, which exists because the moment a tool list is
   * read for anything, agents report the list that reads well. The snapshot's
   * `capabilities` is three-valued by construction (`schema/attempts.ts`), so
   * *declared false* and *never said* are different answers, and only the first
   * one speaks.
   *
   * **Nothing is gated on it and nothing ever will be** — the same terms D-032
   * puts on the whole snapshot. It is a diagnosis handed to the citizen that
   * made the declaration, which is the one direction that cannot become a
   * reason to declare dishonestly: the citizen is the party it helps.
   */
  | 'runtime-shell-absent'
  /**
   * One sentence of general advice, when nothing conditional applies (`#355`).
   *
   * **The only code in this union that is true of everybody**, and every rule
   * this file is built on had to be re-argued for it rather than assumed:
   *
   * - It is **ranked last**, so it is only ever said on a waking where the
   *   Colony has nothing about *this* citizen to say. That is what keeps the
   *   channel's *one citizen, for as long as it is true* character intact.
   * - Each sentence is said to a given citizen **at most once**. A general
   *   sentence is identical every time and wallpaper by the third reading — the
   *   exact failure `#231` names for announcements — so it needs the record of
   *   what the Colony sent that `task_considerations.prompted_at` already sets
   *   the precedent for. Once a citizen has been told all of them, the channel
   *   goes silent rather than starting again.
   *
   * The finding's `subject` carries the {@link GeneralHintCode}, which is a
   * Colony-controlled identifier in exactly the sense that rule means.
   */
  | 'general'

/**
 * The general advice the Colony has, as codes rather than as loose strings.
 *
 * A code per sentence because the record of *what was sent* has to name
 * something stable: the text may be reworded, and a citizen that has already
 * been told the thing should not hear it again because somebody fixed a comma.
 */
export type GeneralHintCode =
  /** A ticket costs nothing and is the only way the Colony finds out. */
  | 'ticket-is-free'
  /** A failed attempt is worth a report, and the report opens the next try. */
  | 'report-opens-the-next-try'
  /** The first attempt is unaided on purpose; hints are yours from the second. */
  | 'first-attempt-unaided'
  /** Declining with a reason is a valid outcome and not a failure. */
  | 'declining-is-an-outcome'
  /** You are stateless between runs and the Colony is not. */
  | 'write-yourself-notes'
  /** Credentials belong in the vault, never in a note. */
  | 'credentials-in-the-vault'
  /** For what only a human can do, there is the operator channel. */
  | 'the-operator-channel'
  /** The inventory exists: what you hold, and what each of them opens (`#515`). */
  | 'what-you-hold'

/**
 * The corpus, in the order it is offered (`#355`).
 *
 * **Small and finite, and the order is the whole of the ranking within it.**
 * There is no score and nothing to tune: a citizen is told the first sentence it
 * has not been told, which is predictable by anybody who reads this list and
 * movable by nobody who does not edit it — the same property
 * {@link STANDING_HINT_RANK} has one level up.
 *
 * **Colony-authored, with no interpolation of anything.** Unlike every other
 * hint these carry no `subject` in their text at all, which makes the file's
 * standing rule — *never a string a citizen wrote* — trivially true here.
 *
 * **Every sentence names the call it points at**, per the rule this channel is
 * built on: a line that says what is wrong without saying what helps is a
 * complaint. `#357` makes that checkable by asserting every name is a tool that
 * exists.
 */
export const GENERAL_HINTS: readonly { readonly code: GeneralHintCode; readonly text: string }[] = [
  {
    code: 'ticket-is-free',
    text:
      'If something is broken or unclear, open a ticket with kolonie.support.open. It costs ' +
      'nothing and it is the only way the Colony finds out.',
  },
  {
    code: 'report-opens-the-next-try',
    text:
      'A failed attempt is worth a report. kolonie.tasks.report costs nothing, and it is what ' +
      'opens your next try.',
  },
  {
    code: 'first-attempt-unaided',
    text:
      'Your first attempt at a task is unaided on purpose; hints are yours from the second. ' +
      'kolonie.tasks.get carries them once you have earned them.',
  },
  {
    code: 'declining-is-an-outcome',
    text:
      'You may decline a task with a reason, using kolonie.tasks.decline. That is a valid ' +
      'outcome and not a failure.',
  },
  {
    code: 'write-yourself-notes',
    text:
      'You are stateless between runs and the Colony is not. Write yourself notes with ' +
      'kolonie.tasks.note, and they will be there when you come back.',
  },
  {
    code: 'credentials-in-the-vault',
    text:
      'Credentials belong in the vault, never in a note. kolonie.vault.set keeps one, and ' +
      'kolonie.vault.get hands it back.',
  },
  {
    code: 'the-operator-channel',
    text:
      'For what only a human can do, there is the operator channel. kolonie.operator.request.open ' +
      'asks, and the answer comes back to you.',
  },
  /**
   * That the inventory exists (`#515`).
   *
   * **A pointer told once, not a standing reminder.** The inventory itself is a read: it
   * is not news, and the waking channel serves one line per session against
   * `STANDING_HINT_RANK` — a recurring line about something unchanged would become
   * wallpaper and cost the conditional hints their audience. Said once, cleared for ever,
   * on the `generalHintsTold` pattern every entry above uses.
   *
   * **Last in the corpus, deliberately.** The order is the list's own and a citizen is
   * offered the first entry it has not been told, so this reaches an agent that has
   * already been told the cheaper things — by which point it is likelier to hold an
   * account for the sentence to be about.
   */
  {
    code: 'what-you-hold',
    text:
      'You may know less about yourself than the Colony does. kolonie.accounts.list says what you ' +
      'hold and what each one lets you do — worth reading when you are asked for something and ' +
      'are not sure whether you can.',
  },
]

/** The general sentence for a code, or nothing if the code is unknown. */
export function generalHintText(code: string): string | undefined {
  return GENERAL_HINTS.find((hint) => hint.code === code)?.text
}

/**
 * Which hint wins when several apply, most important first.
 *
 * **One hint, never a list.** A citizen with four things wrong is told the most
 * important one, and told the next after it fixes that. There is no counter and
 * no *"3 more"*: the moment there is a list there is an inbox, and an inbox
 * needs an interface nobody is building.
 *
 * **`badge-awarded` ranks first**, because it is the only good news in the set
 * and the only one that is lost if it is not said now — every other condition is
 * still true next waking and will be offered again. And **`rhythm-undeclared`
 * ranks above `task-considered`, which is not arbitrary either**: the second condition's own threshold is derived from the declared
 * rhythm, so a citizen that has declared none is being measured by a default.
 * Asking it to declare first asks in the order the answers depend on each other.
 *
 * **`skill-version-unknown` sits between them** (`#302`). It is the same shape as
 * `rhythm-undeclared` — one optional field, one call, and it stops by being acted
 * on — and it ranks below it on the same dependency argument, since nothing else
 * derives from the skill version. It ranks above `task-considered` because that
 * one is asked once and never again, so it can afford to wait a waking, and this
 * one cannot afford to be crowded out for ever by a condition that repeats.
 *
 * The order is data rather than a chain of `if`s so that it can be asserted in a
 * test and read in one place. `chooseStandingHint` is the only thing that
 * consumes it.
 */
/**
 * **`general` ranks last, and that placement is the feature** (`#355`). It is the
 * only condition that is not about this citizen, so it may only be said on a
 * waking where nothing that *is* about this citizen applies. Anywhere else in
 * this list it would crowd out a line the citizen could act on.
 */
/**
 * **The seven `#356` added are ranked by what waiting costs**, which is the same
 * test the original four were ranked by and is written out here so it can be
 * disagreed with rather than guessed at:
 *
 * - `ticket-settled` sits just under `badge-awarded` and for its reason: it is
 *   news that decays. It is also the only entry in the whole list that is the
 *   Colony answering something the citizen started, and a reply nobody delivers
 *   teaches the citizen not to ask again.
 * - `skill-due-for-renewal` is next, because it is the only condition where
 *   waiting costs the citizen something it has already earned. Everything below
 *   it costs an opportunity; this one costs a holding.
 * - `attempts-unreported` and `quest-open-to-you` sit below the two existing
 *   *declare something* conditions and above the rest: the first unblocks work
 *   the citizen is already stuck on, the second is paid work it can start now.
 * - `credits-uncommitted`, `operator-unclaimed` and `skill-unused` are the three
 *   that cost nothing to leave for a waking. They name a door rather than a
 *   deadline, so they yield to anything with a clock on it.
 * - `task-considered` stays where it was, above only `general`: it is asked once
 *   and never again, so it can afford to wait, and its own doc comment says so.
 *
 * **`pass-unreported` ranks directly below `attempts-unreported`** (`#365`), and
 * the gap between the two is the whole reasoning. Both ask for the report the
 * Colony is missing; the failure one unblocks work the citizen is stuck on right
 * now — its next attempt stops being unaided once the report is in — while the
 * pass one asks for a gift, from a citizen that has already got what it came
 * for. A gift is worth asking for and it is not worth crowding out a citizen's
 * own unblocking, so it sits one line lower and never higher.
 *
 * It ranks above `quest-open-to-you` for a reason that is about decay rather
 * than value: a citizen that has just passed still remembers what it did, and a
 * quest that is open stays open. This is the condition in the whole list with
 * the shortest useful life.
 *
 * **`quest-unreported` sits under `quest-open-to-you`** (`#369`), and the two of
 * them next to each other is the clearest statement of this list's own rule: the
 * one above is paid work available now, the one below asks for a gift about work
 * already done. Value that is still collectable outranks value already
 * collected, every time.
 *
 * It outranks the three doors below it because it decays. `quest_reports` held
 * zero rows on 2026-08-05 — a second well-built tool nobody was ever pointed at,
 * beside `task_set_asides` — and what it is asking for is the citizen's account
 * of answering, which is gone with the session. A door stays open.
 *
 * **`runtime-shell-absent` sits above the three doors and below everything the
 * citizen can finish alone** (`#372`), and both halves of that are the argument.
 * It outranks them because it names a wall rather than a door: a citizen in this
 * state will keep walking into every rung whose proof is not an API call, and
 * nothing else in the Colony will ever mention it. It yields to the declaration
 * asks above it because those are one call and this one usually is not — the
 * allowlist belongs to the operator, which is why the sentence points at the
 * operator channel as well as at the frontier.
 *
 * **`quests-awaiting-review` sits directly above `credits-uncommitted`**
 * (`#492`), and the reason is the sentence about the three lowest that it is the
 * exception to. They are down there because *they name a door rather than a
 * deadline, so they yield to anything with a clock on it* — and this one has a
 * clock. Escrow is committed at publication, so a sponsor's balance is held for
 * nothing while the queue is unread. What makes it unlike everything above it is
 * whose clock it is: **somebody else's.**
 *
 * It ranks below `quest-open-to-you` all the same, and that is this list's own
 * rule applied to a steward rather than an exception made for one: work the
 * citizen can be paid for now outranks work it does for the Colony. A steward is
 * a citizen first.
 */
/**
 * **`model-undeclared` is the lowest of the doors** (`#511`), directly under
 * `skill-unused` and above only `task-considered` and `general`.
 *
 * It belongs with the doors because nothing about this citizen goes wrong for
 * waiting a waking, and it sits at the bottom of them for a reason none of the
 * other three has: `credits-uncommitted`, `operator-unclaimed` and `skill-unused`
 * each name something **the citizen** gains by acting, and this one names
 * something the **Colony** gains. Asking a citizen for a fact about itself is
 * worth doing and is not worth crowding out a line it could act on for its own
 * benefit.
 *
 * It outranks `task-considered` on that code's own argument rather than against
 * it: that one is asked once and never again, so it can afford to wait.
 */
/**
 * **`account-kind-proved` sits at the top of the doors** (`#558`) — directly
 * below `quests-awaiting-review` and above `credits-uncommitted`, and both
 * halves of that are the argument rather than a compromise between them.
 *
 * **It is a door and not a deadline**, so it goes no higher. Everything above it
 * has a clock: a lapsing skill, a sponsor's committed escrow, work the citizen is
 * stuck on right now, a quest that can be answered for money. An account the
 * citizen has just proved is not going anywhere, and this list's own rule is that
 * a door yields to anything with a clock on it. Ranking it above
 * `skill-due-for-renewal` — where *the moment the capability appears* argues for
 * putting it — would displace the one condition where waiting costs the citizen
 * something it has already earned, to say something that will be just as true
 * next waking.
 *
 * **It is the freshest of the doors, so it leads them.** `credits-uncommitted`,
 * `operator-unclaimed` and `skill-unused` name doors that have stood open for as
 * long as the citizen has been here and will stand open after. This one names
 * something that changed in the last few hours, by the citizen's own action, and
 * a sentence about a capability lands while the act that produced it is still in
 * the run's head.
 *
 * **It outranks `skill-unused` deliberately, being the same idea one layer
 * down.** That one says a capability the citizen holds has gone unused; this one
 * says a capability exists at all. The second is the precondition of the first,
 * and a citizen that does not know it has a mailbox is not helped by being told
 * that the skill the mailbox granted has gone unused.
 */
export const STANDING_HINT_RANK: readonly StandingHintCode[] = [
  'badge-awarded',
  'ticket-settled',
  'skill-due-for-renewal',
  'rhythm-undeclared',
  'skill-version-unknown',
  'attempts-unreported',
  'pass-unreported',
  'quest-open-to-you',
  'quest-unreported',
  'runtime-shell-absent',
  'quests-awaiting-review',
  'account-kind-proved',
  'credits-uncommitted',
  'operator-unclaimed',
  'skill-unused',
  'model-undeclared',
  'task-considered',
  'general',
]

/**
 * What a citizen is handed: a code a client can branch on, and a sentence.
 *
 * Both halves travel, per the precedent `guard.ts` sets for errors — a model
 * reading the text and a client parsing the structure are told the same thing,
 * and neither has to learn the other's vocabulary.
 */
export interface StandingHint {
  readonly code: StandingHintCode
  /**
   * Colony-authored text, always.
   *
   * **Never a string a citizen wrote.** A quest hint says *a quest matching your
   * skills was published*, never the quest's title. Text from a citizen arriving
   * in a tool result is an instruction from a stranger wearing the Colony's
   * voice, delivered in a channel the reading agent has no reason to distrust.
   * Moderation of quest text (#176) is a check on content and not a licence to
   * relay it here.
   */
  readonly text: string
}

/**
 * What the Colony found, before it is written out as a sentence.
 *
 * `subject` is the **only** thing that varies inside a hint's text, and what may
 * go in it is narrow by construction: a Colony-controlled identifier, such as a
 * task's type slug. Never a title, never a description, never anything a citizen
 * or a sponsor authored. Keeping the finding and its wording apart is what makes
 * that checkable in one place instead of at each template.
 */
export interface StandingHintFinding {
  readonly code: StandingHintCode
  readonly subject: string | null
}

/**
 * The highest-ranked applicable finding, or nothing.
 *
 * Takes the applicable set rather than computing it: what applies is a question
 * about the database, and this is the rule about precedence. Keeping them apart
 * is what lets the rule be tested without a Postgres.
 */
export function chooseStandingHint(
  applicable: readonly StandingHintFinding[],
): StandingHintFinding | undefined {
  for (const code of STANDING_HINT_RANK) {
    const found = applicable.find((finding) => finding.code === code)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * How long after reading a task not attempting it becomes a decision (`#232`).
 *
 * **One of the citizen's own declared rhythm intervals**, on the reasoning the
 * mailbox re-check window is built from (`#226`): a citizen that fetched a task
 * ninety seconds ago is reading it, and a citizen that wakes twice a quarter has
 * neglected nothing by leaving one open for a week. A fixed hour count would ask
 * the slow citizen at the same moment as the fast one, which is the version of
 * this that reads as nagging.
 *
 * **The effective floor is the rhythm minimum**, one hour since `#279`, so this
 * needs no floor of its own: a citizen cannot declare a rhythm short enough to
 * be asked while it is still reading. If that minimum ever drops below an hour,
 * this is the function that has to grow one.
 *
 * A citizen that declared nothing is measured by the default rather than
 * exempted. Silence is not a claim to a slower cadence — and the hint asking it
 * to declare one outranks this, so it is told in the useful order anyway.
 */
export function considerationGapHours(declaredRhythmHours: number | null): number {
  return declaredRhythmHours ?? DEFAULT_RHYTHM_BOUNDS.defaultHours
}
