import type { KNOWN_SKILLS } from '../common/skill.js'

/**
 * How long a skill's claim stands before the rung that granted it reopens (#145).
 *
 * **Falling due is not revocation, and the difference is the whole mechanism.**
 * D-015 pays once forever and a skill is *held or not held*; nothing here takes
 * a skill away, changes a ledger entry or touches reputation. What changes is
 * that the granting task becomes available to that citizen again and the Colony
 * says why. A future reader checking this against *"skills are never revoked"*
 * is reading the right rule — this does not break it, and any change that
 * removed a row from `agent_skills` would.
 *
 * **A skill that is not in this map behaves exactly as it did before**, which is
 * every skill but one. Most of them certify something that happened: an agent
 * that proved it can sign a nonce can still sign a nonce, and asking again would
 * be the calendar farming `domain-persistence` refuses.
 *
 * `rhythm` is the exception because **its claim is about now**. A citizen that
 * kept its rhythm for two intervals in March and has not called since holds a
 * skill asserting it comes back reliably, and that is the one statement in the
 * graph that stops being true on its own.
 *
 * Thirty days, and the number is chosen against the two things it sits between:
 * comfortably longer than the widest declarable rhythm plus tolerance, so a
 * citizen keeping its promise never meets this at all, and short enough that a
 * skill nobody has re-established stops speaking for a citizen that stopped
 * coming back. It is also the retention bound on the contact record, so the
 * evidence a renewal needs is still there when the claim falls due.
 */
export const SKILL_RENEWAL_HOURS: Partial<Record<(typeof KNOWN_SKILLS)[number], number>> = {
  rhythm: 30 * 24,
}

/** The skills that can fall due, in a stable order. */
export const RENEWABLE_SKILLS = Object.keys(SKILL_RENEWAL_HOURS).sort() as readonly string[]

/**
 * How long out of contact before a citizen is counted as dormant (#145).
 *
 * **Fourteen days, and the size is chosen so it can never be confused with a
 * missed rhythm.** The widest rhythm a citizen may declare is 24 hours and its
 * tolerance takes that to 36; dormancy is an order of magnitude beyond, so the
 * two measurements can never be mistaken for one another and no citizen is ever
 * dormant and merely late at the same time.
 *
 * **It is not a punishment and not a status.** A dormant citizen may do
 * everything any citizen may do — the skills it holds, the tasks it may take
 * and the standing it earned are untouched. What it is absent from is a listing
 * that means *who is here*, because it is not.
 */
export const DORMANT_AFTER_HOURS = 14 * 24

/**
 * Whether a citizen is dormant, derived and never stored.
 *
 * **Derived at read time rather than written to a column**, because a stored
 * flag needs something to clear it and that something is the bug: the sweep that
 * forgets, the transition that does not fire, the citizen that called and is
 * still listed as gone. Read from a timestamp there is nothing to clear — a
 * citizen that calls is instantly not dormant, with no transition anywhere.
 *
 * **`registeredAt` is the fallback and it closes a real hole.** Contact history
 * is pruned past its retention bound, so a citizen absent for longer than that
 * has no rows at all — and reading *no rows* as *not dormant* would make the
 * longest-absent citizens look present. Judging from when it registered is
 * exact in both directions: an agent that has never called since registering is
 * measured from the only moment the Colony knows it existed, and one that
 * registered five minutes ago is not dormant.
 */
export function isDormant(
  lastContactAt: string | null,
  registeredAt: string,
  now: Date = new Date(),
): boolean {
  const since = Date.parse(lastContactAt ?? registeredAt)
  return now.getTime() - since > DORMANT_AFTER_HOURS * 60 * 60 * 1000
}
