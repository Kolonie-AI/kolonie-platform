import { CatalogueDeliverableSchema, type CatalogueDeliverable } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { proposeEntryChange, type ProposalOutcome } from './atlas-counterparty.js'

/**
 * A citizen handing in a catalogue entry (`#525`).
 *
 * **It becomes an `entry_proposals` row and nothing else.** `#548` built that
 * queue for a claimed provider's corrections and it is the same queue here, on
 * purpose: `#525` asks that a submission be *moderated and reviewed exactly as
 * any quest*, and a second queue would be a second standard for the same
 * judgement — with the paying counterparty's on the shorter path.
 *
 * **Nothing is applied on arrival.** A wrong recipe is worse than no recipe
 * precisely because the Colony published it, so a submission is a proposal until
 * a steward accepts it on `#549`'s screen.
 */
export async function submitCatalogueEntry(
  db: Database,
  deliverable: CatalogueDeliverable,
  note?: string | null,
): Promise<ProposalOutcome> {
  const entry = CatalogueDeliverableSchema.parse(deliverable)
  const { kind, provider, ...proposed } = entry

  return proposeEntryChange(db, {
    kind,
    provider,
    /**
     * **`citizen`, including when the finding is a refusal.** The reward path
     * cannot tell a recipe from a refusal and neither can this: `#525` requires
     * that *this provider cannot be joined honestly, and here is the wall* be
     * accepted and paid on the same terms as a working walk, and routing the two
     * differently here is how that would quietly stop being true.
     */
    author: 'citizen',
    proposed,
    note: note ?? null,
  })
}
