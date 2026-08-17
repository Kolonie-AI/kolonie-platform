import type { AtlasPublicEntry } from './public-projection.js'
import { atlasEntryVerdict } from './verdict.js'

/**
 * Whether anybody got through at a provider (`#1103` decision 2).
 *
 * **The index shows what worked by default and one link shows what did not**, so
 * this predicate is the whole of that default. It is deliberately not a rate and
 * not a threshold: an agent looking for a mailbox wants the providers somebody
 * has actually joined, and *somebody joined this* is a fact about one walk rather
 * than a score to be tuned later.
 *
 * ## It is now one line of {@link atlasEntryVerdict}, and that is the point
 *
 * The two ways a row could say *somebody got in* — a steward's `joinable`, and an
 * evidenced figure with a proved walk — were spelled out here and read nowhere
 * else, while the entry page derived its title and its lead chip from `status`
 * alone. `#1163` measured what that costs: `agentphone.ai` appeared on the shelf
 * under *what worked*, and its own page said *this cannot be joined honestly, so
 * do not try* above four sections of successful walks.
 *
 * Both readings now come from one model. `joinable` and `partly` are exactly the
 * two verdicts that mean somebody got through, so the shelf's default and the
 * page's headline cannot disagree again without the model being changed for
 * both. **What counts as *got through* moved with them**, into
 * {@link atlasRecipeGotThrough}, which is where `#1167`'s `anyProved` is read.
 */
export function atlasEntryWorked(entry: AtlasPublicEntry): boolean {
  const verdict = atlasEntryVerdict(entry)

  return verdict === 'joinable' || verdict === 'partly'
}
