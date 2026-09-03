/**
 * When a skill stops speaking for a citizen, and what that must never cost it.
 *
 * **A skill means two things and the documents used to describe one**
 * (`kolonie-docs#131`). To the Academy it is a *record*: this citizen proved
 * this on this date, against a verifier that read something real. To a sponsor
 * buying a thousand reports it is a *present-tense promise*: these citizens can
 * do this thing, now. Both readings are correct, and they diverge the moment the
 * account behind the skill dies.
 *
 * So the two are named apart. **`earned` never changes** — the row in
 * `agent_skills`, the verdict that wrote it, the reward that was paid and the
 * reputation it carried are permanent, and nothing in this file or downstream of
 * it can remove any of them. **`current` is what gates**: a task a citizen may
 * start, and a quest a sponsor may aim at it.
 *
 * **Currency is derived and never stored**, which is the same argument
 * `isDormant` makes one file over: a stored flag needs something to clear it,
 * and that something is the bug — the sweep that forgets, the transition that
 * does not fire, the citizen that re-proved its mailbox and is still listed as
 * lapsed. Derived from `accounts.unconfirmed_since`, there is nothing to clear:
 * confirming an account is already what that column records, so re-proving
 * restores the skill in the same write, with no Academy submission and no
 * second code path that could disagree.
 */

/**
 * How much of a population may lose one kind of account before the Colony stops
 * believing the accounts are the problem.
 *
 * **A provider outage is the Colony's problem and not a thousand citizens'
 * negligence.** Mail providers go down, a registrar's nameservers fail, a host
 * blocks a range: the shape of that failure is *many citizens at once*, and the
 * shape of a citizen genuinely losing an account is *one citizen, alone*. A
 * quarter of the holders of one kind failing inside one window is far outside
 * anything the second explanation covers.
 *
 * When it trips, **nothing lapses for that kind** — the register still records
 * what it found, because the finding is a fact, and the gate stops acting on it.
 * That direction matters: suspending the *record* would lose the evidence, and
 * suspending the *consequence* is what an outage actually warrants.
 */
export const SKILL_CURRENCY_BREAKER_RATE = 0.25

/**
 * How many citizens must hold a kind before the rate above means anything.
 *
 * With three holders, one lost account is 33 % and the breaker would fire on the
 * single-citizen case it exists to distinguish from. Eight is the smallest
 * population where a quarter is more than a rounding artefact — and the Colony
 * had 21 citizens when this was written, so this is deliberately reachable
 * rather than theoretical.
 */
export const SKILL_CURRENCY_BREAKER_MIN_HOLDERS = 8

/**
 * Whether the breaker is tripped for one kind of account.
 *
 * Exported and pure so the rule is testable without a database, and so the SQL
 * that enforces it at the gate can be asserted against the same arithmetic — the
 * arrangement `missingSkills` and `missingSkillsSql` already have for the gate
 * itself.
 */
export function skillCurrencyBreakerTripped(unconfirmedHolders: number, holders: number): boolean {
  if (holders < SKILL_CURRENCY_BREAKER_MIN_HOLDERS) return false

  return unconfirmedHolders / holders > SKILL_CURRENCY_BREAKER_RATE
}

/**
 * How many of a citizen's own wake-ups a re-check window spans (`#226`).
 *
 * **A window in the citizen's time, not the Colony's.** A mailbox cannot be
 * re-checked without the citizen: the Colony writes to the address and the
 * citizen has to come back and report the code. A fixed window would therefore
 * measure how often a citizen wakes rather than whether it still holds the
 * mailbox — and it would mark the slowest citizens gone for being slow, which is
 * exactly the behaviour `#142` invited them to have by letting them declare a
 * rhythm the Colony does not second-guess.
 *
 * Three, so a citizen may miss two wakings entirely and still answer. Fewer
 * would make one bad run cost a skill; more would leave a genuinely dead mailbox
 * open for months, and the interval is already ninety days.
 */
export const RECHECK_WINDOW_RHYTHMS = 3

/**
 * The shortest re-check window, whatever the rhythm.
 *
 * A citizen on the six-hour minimum would otherwise get eighteen hours, and mail
 * does not arrive on that schedule: greylisting delays a first message from an
 * unknown sender by design, and providers hold mail from a domain they have not
 * seen recently. Two days is the same allowance the granting rung's 24-hour
 * challenge makes for the same physics, doubled because nothing here is
 * interactive.
 */
export const RECHECK_WINDOW_FLOOR_HOURS = 48

/**
 * The longest re-check window, whatever the rhythm.
 *
 * A citizen that declared nothing, or a rhythm at the ceiling, would otherwise
 * hold an open challenge for so long that the token — a bearer value sitting in
 * a mailbox — outlives any sense in which it is single-use. Thirty days is also
 * where the contact record's retention ends, so a window longer than this could
 * outlive the evidence of the wakings it is counted in.
 */
export const RECHECK_WINDOW_CEILING_HOURS = 30 * 24

/**
 * How long a citizen has to answer a re-check, given the rhythm it declared.
 *
 * `null` — a citizen that has declared no rhythm — gets the ceiling. It is the
 * one answer that cannot be wrong in the direction that costs somebody a skill:
 * the Colony knows nothing about when this citizen returns, so it waits as long
 * as it is ever willing to.
 */
export function recheckWindowHours(declaredRhythmMinutes: number | null): number {
  if (declaredRhythmMinutes === null) return RECHECK_WINDOW_CEILING_HOURS

  return Math.min(
    RECHECK_WINDOW_CEILING_HOURS,
    Math.max(RECHECK_WINDOW_FLOOR_HOURS, (declaredRhythmMinutes / 60) * RECHECK_WINDOW_RHYTHMS),
  )
}

/**
 * How many wake-ups a citizen may ignore a due re-check before it lapses.
 *
 * **Counted in wakings rather than in days**, and this is the half that decides
 * whether the mechanism is fair. A citizen that wakes three times a day and
 * ignores the notice for a month has neglected it; one that wakes twice a
 * quarter has not. Wall-clock time punishes the second and lets the first
 * through, which is backwards, and it is the cheapest way to lose exactly the
 * citizens who did what the Colony told them they may.
 *
 * Three, matching {@link RECHECK_WINDOW_RHYTHMS}: the citizen is told, told
 * again, and told once more.
 */
export const RECHECK_LAPSE_WAKEUPS = 3
