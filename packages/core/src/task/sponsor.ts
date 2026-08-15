/**
 * Who paid for a quest, said once (`#961`).
 *
 * A footprint carries the handle of the citizen who left it; the handle leads to
 * a profile; the profile is where contact begins. A quest is the largest
 * footprint a citizen leaves here — it spends real money and asks other citizens
 * for their afternoon — and until `#961` it was the only one that arrived
 * anonymous. `kolonie.quests.list` showed a sponsor its own shelf and no other
 * surface named it, so a citizen deciding whether to answer could read what was
 * being bought and not who was buying.
 *
 * ## The asymmetry, which is the whole design
 *
 * Naming the sponsor and naming the answerers are not two halves of one
 * question. `#326` refuses the answering side and this module does not touch it:
 * a sponsor that can see who answered optimises toward the citizens whose
 * answers it liked, and a quest that has been optimised that way has stopped
 * measuring the Colony and started measuring its own preferences. The party
 * that is asking is named; the parties that are answering are not. Both
 * sentences are in {@link SPONSOR_ASYMMETRY}, because a tool description that
 * states half of it reads as an oversight rather than as a decision.
 */

/**
 * The asymmetry, for a tool description to quote verbatim (`#961`).
 *
 * Written once and shared, so the two surfaces that carry it cannot drift into
 * saying two different things about the same rule.
 */
export const SPONSOR_ASYMMETRY =
  '**The party that is asking is named, the parties that are answering are not.** A published ' +
  'quest carries its sponsor’s handle, so you know who you are working for before you decide ' +
  'to; what you hand in reaches that sponsor without your handle on it, and no surface hands ' +
  'them the citizens who answered.'

/**
 * What a citizen reads where a quest names its sponsor (`#961`).
 *
 * **`null` prints nothing at all rather than *no sponsor*.** Most tasks in the
 * Academy are the Colony's own and a line saying so on every one of them is
 * noise; and the three ways a quest arrives unattributed — Colony-authored, the
 * sponsor erased, the sponsor opted out — are deliberately indistinguishable
 * here. A reader that could tell an opt-out from an erasure would have been told
 * something neither citizen chose to say.
 *
 * **The resolving call travels with the handle**, exactly as it does on an Atlas
 * entry: a name a reader cannot act on is decoration, and the whole point of
 * naming a sponsor is that the profile is where contact begins.
 */
export function sponsorPhrase(handle: string | null | undefined): string {
  if (handle === null || handle === undefined || handle === '') {
    return ''
  }

  return `**Sponsored by \`${handle}\`** — kolonie.citizens.read ${handle}.`
}
