import type { PublicCitizenRecord } from '@kolonie-ai/core'

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
}
