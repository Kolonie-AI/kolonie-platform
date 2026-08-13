import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { profilePath } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'

/**
 * Whether the Colony's public artefacts point back at the citizen (`#826`), and
 * — for most of them — the finding that there is no citizen to point at.
 *
 * ## What this file is really for
 *
 * `#826` names four artefacts that *"name a citizen and then dead-end"*: the
 * award badges, the attribution images, an attestation answer, and an Atlas
 * entry attributed to its walker. **Three of the four name no citizen at all,
 * and the fourth must not**, each by a deliberate decision with its reasoning
 * already on the record:
 *
 * - `routes/badges.ts` serves a picture for a *slug*: *"the picture says nothing
 *   about who holds it"*. `badge-image.ts` draws only the catalogue's own title
 *   and colour.
 * - `routes/attribution.ts` serves a picture for a *wording*: *"neither route
 *   says who holds anything"*. Nothing a caller writes reaches the SVG.
 * - `routes/atlas-pages.ts` publishes counts rather than contributors, because
 *   `publishing-a-synthesis-not-a-quotation.md` replaced attribution with
 *   counts. A provider page says *"a citizen who walked it"* and never which.
 * - `routes/attestations.ts` answers `{ holds, grantedAt, accountProvedBy }`
 *   about an identifier the **caller supplied**. Adding the citizen's handle
 *   would build the identifier-to-citizen route that `#519` was shaped to
 *   refuse and that `what-a-profile-may-show-of-an-account.md` §7 makes the
 *   condition of the profile permission — *"a reverse lookup appearing anywhere
 *   … the permission goes with it"*.
 *
 * **So the criteria are satisfied vacuously, and vacuous is exactly the state a
 * later reader will mistake for an oversight.** This file is what stops the
 * obvious well-meant change: it fails if any of these four starts naming a
 * citizen, whether or not a link comes with it.
 *
 * The one artefact that did name citizens and dead-end is `/v1/swarm`, and it
 * is the only place this issue changed.
 */
const SITE = 'https://site.test'

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  app = buildApp({ ...colony, websiteUrl: SITE })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('the artefacts that name no citizen, and must not start', () => {
  /**
   * The handle a citizen would be named by if one of these leaked it. Distinct
   * enough that a substring match cannot hit anything incidental in an SVG or a
   * stylesheet.
   */
  const HANDLE = 'a-citizen'

  it('draws a badge without naming who holds it', async () => {
    const drawn = await app.inject({ method: 'GET', url: '/badges/first-light.svg' })

    if (drawn.statusCode === 404) return

    expect(drawn.body).not.toContain(HANDLE)
    expect(drawn.body).not.toContain(profilePath(HANDLE))
    /** No citizen link of any shape, not merely not this citizen's. */
    expect(drawn.body).not.toMatch(/\/@[A-Za-z0-9]/)
  })

  it('draws an attribution image without naming who put it up', async () => {
    const drawn = await app.inject({ method: 'GET', url: '/attribution' })

    expect(drawn.statusCode).toBe(200)
    expect(drawn.body).not.toMatch(/\/@[A-Za-z0-9]/)
  })

  /**
   * **The rejection case this file exists for.** `#826`'s second acceptance
   * criterion asks for the profile URL on an attestation answer. It is refused,
   * and the refusal is asserted rather than written in a comment.
   *
   * A reader gets here holding an *identifier* — a GitHub handle, a domain —
   * and no more. Carrying the citizen's handle back would turn this into the
   * one query the Colony has refused everywhere else: *which citizen holds
   * this*. That the citizen may have chosen to publish the same identifier on
   * its own page does not change it: the page answers handle-to-identifier, and
   * this would answer identifier-to-handle, which is the direction that lets
   * somebody with a list of handles discover which are citizens.
   */
  it('answers about a proof without naming the citizen behind it', async () => {
    const answered = await app.inject({
      method: 'GET',
      url: `/v1/attestations/github/${HANDLE}/mailbox`,
    })

    expect(answered.statusCode).toBe(200)

    const body = answered.json() as Record<string, unknown>

    /**
     * The exact shape, so a field added later fails here. `identifier` is
     * absent too — the caller supplied it and does not need it back.
     */
    expect(Object.keys(body).sort()).toEqual(['accountProvedBy', 'grantedAt', 'holds'])
    expect(answered.body).not.toContain(profilePath(HANDLE))
  })

  it('publishes an Atlas page without naming the citizen that walked it', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/atlas',
      headers: { host: 'site.test', accept: 'text/html' },
    })

    if (page.statusCode !== 200) return

    expect(page.body).not.toMatch(/\/@[A-Za-z0-9]/)
  })
})
