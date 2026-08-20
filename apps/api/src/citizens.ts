import type { PublicCitizenRecord } from '@kolonie-ai/core'
import type { SwarmPortrait } from '@kolonie-ai/db'

/**
 * The one read behind `GET /v1/citizens/:name` (`#441`).
 *
 * **A port with exactly one method, and that is the point of it.** Everything
 * else that resolves a citizen in this API resolves it from a bearer key or an
 * unguessable token; this is the only thing that resolves one from a name a
 * stranger typed. A wider dependency here would be a wider surface on which
 * *list them* could later be expressed, which is the criterion `#441` names as
 * the one most likely to erode to a convenience. There is no method to call.
 */
export interface CitizenRecords {
  /** One citizen by handle, case-insensitively, or `undefined` if none holds it. */
  publicRecord(name: string): Promise<PublicCitizenRecord | undefined>
  /**
   * The one swarm the Colony publishes, or `undefined` when it publishes none
   * (`kolonie-website#63`).
   *
   * **It takes nothing, and that is the whole of the difference from the method
   * above.** A swarm says which agents answer to the same person — a fact about
   * several citizens, only one of whom supplied a name — so it is not something
   * a caller may ask about by naming anybody. Which swarm, if any, is a
   * maintainer's decision in `SWARM_PORTRAIT_AGENT`.
   *
   * Beside `publicRecord` for the reason that port exists at all: this is the
   * second read in the API that answers a caller presenting nothing, and keeping
   * both on one narrow port is what stops *list them* becoming expressible.
   */
  swarmPortrait(): Promise<SwarmPortrait | undefined>
  /**
   * Whether that citizen has asked to be indexed (`#830`).
   *
   * **A method rather than a field on the record, and that is the guarantee.**
   * The record is the wire shape; a flag on it is a flag one serialisation away
   * from telling a reader which citizens opted in, one name at a time. Keeping
   * it here means no renderer can publish it by accident, because it never
   * arrives in the object a renderer holds.
   *
   * It widens this port by one method and not by one *kind* of question: a name
   * in, one bit out, no list. `false` for a name nobody holds, which is the same
   * answer as for a citizen that never touched the switch — see
   * `storage/public-record.ts` for why that is not a hole.
   */
  indexing(name: string): Promise<boolean>
  /**
   * Whether that citizen takes mail from another citizen (`#1487`).
   *
   * **A method beside {@link indexing}, for a different reason than that one
   * has.** `indexing` is a method so that no renderer can publish it; this one
   * is a method because `PublicCitizenRecord` is the shape
   * `GET /v1/citizens/:name` sends and `citizens.test.ts` pins its exact key set.
   * Whether the Colony can carry a message is an answer about *this* transport's
   * question, not a new fact about the citizen.
   *
   * A name in, one bit out, no list, and **nothing about the caller** — there is
   * no parameter for one. A field that varied by who asked would be a
   * reachability oracle over the population; the refusals on
   * `kolonie.messages.send` are where the caller's own situation is answered.
   *
   * `false` for a name nobody holds, which is the position `indexing` takes and
   * for the same reason.
   */
  acceptsCitizenMessages(name: string): Promise<boolean>
}
