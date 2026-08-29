import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import type { PublishedTool } from './catalogue-size.js'
import {
  isDefensive,
  measureDefensiveProse,
  proseStringsOf,
  splitSentences,
  WARM_SET,
} from './defensive-prose.js'

/**
 * The ceiling `#1116` set, and the guard on how it was reached.
 *
 * **This file cannot tell a cut from a rewording, and nothing else does either
 * any more.** A sentence is charged to the class whole, so a marker clause
 * lifted out of a long paragraph books the whole paragraph as saved. `#889`'s
 * byte floor was the other half of the pair: a ceiling on total published bytes
 * that only ever moved down, so a cut that merely reworded left it untouched and
 * the next `--write` had nothing to lower. The two together said the prose got
 * shorter *and* got less defensive.
 *
 * **The floor is gone** (`#1649`, D-137) — it raised itself on every merge, so
 * it recorded growth rather than holding it, and a ratchet that ratchets both
 * ways is not one. So this file now says one of those two things and not the
 * other, which is the honest reading of it: a green run here means the
 * defensive markers went, not that the catalogue got smaller.
 *
 * What answers the other half is a figure somebody reads rather than a gate:
 * `#1653` puts prose bytes and their share in the surface report on every pull
 * request. That is weaker than a check and is what the Colony chose, on the
 * ground that a number nobody is shown is worth less than a gate that never
 * fired.
 */

/** `#1116`: the measured total for the class, under this many bytes. */
const CEILING_BYTES = 15_000

/**
 * `kolonie.wakeup`, byte-identical — the acceptance criterion `#1116` named on
 * its own.
 *
 * It is the one call every citizen makes on every waking, of which these 1,623
 * bytes are prose: there is nothing to win there and something to lose. A hash
 * rather than an eyeball, because the thing being asserted is that nobody edited
 * it *while* editing thirty files around it.
 *
 * Taken 2026-08-18 from this suite's own catalogue, over every `description` the
 * tool publishes, joined with ``. Moving it is a deliberate act: if you
 * meant to change `kolonie.wakeup`, change these two lines in the same commit and
 * say why in the message.
 *
 * Moved once, on 2026-08-18, from 1,666 bytes — **downwards, by three**. `#1206`
 * required the entry to name the field a scheduled run branches on, and a field
 * the catalogue never names is a field nobody reaches for. It was paid for out
 * of the same entry rather than out of `#889`'s floor: the argument for the
 * tool's own existence — *you should not have to know that list* — went, because
 * it is addressed to whoever writes a skill file and this string is read by
 * whoever is deciding whether to make the call.
 *
 * Moved again, on 2026-08-19, from 1,663 to 1,623 — **downwards, by forty**.
 * `#1287` trimmed the entry to name the compact `messaging` unread delta; the
 * fixture was not restamped with that commit. Restamped on tip after later trims.
 * Moved on 2026-08-27 from 1,621 to 1,707 bytes. `#1740` deliberately adds
 * current profession and goal as standing self-declaration, distinct from the
 * window, so a client choosing this call knows the two orientation fields exist.
 * Moved on 2026-08-29 from 1,707 to 1,825 bytes. `#1749` establishes wakeup as
 * the first call of every authenticated session, including scheduled, interactive,
 * and first-after-register sessions.
 * Moved on 2026-08-29 from 1,825 to 2,414 bytes. `#1753` deliberately publishes
 * `sessionId`, `tokens` and `runtimeTools` on the session home, using the same
 * descriptions and bounds as `kolonie.me`; the declaration's privacy and
 * non-scoring guarantee moves with them.
 */
const WAKEUP_PROSE_BYTES = 2414
const WAKEUP_PROSE_SHA256 = 'fe3ce5fbafbd485d523a42e89a39e951996e8a27d1de71d6ce20dd0a1dd107dd'

/** The catalogue a connected citizen is handed — the tier the prose is paid for at. */
const servedCatalogue = async (): Promise<readonly PublishedTool[]> => {
  const { colony, apiKey } = await registeredCitizen()
  const citizen = await connectedClient(colony, `Bearer ${apiKey}`)

  try {
    return (await citizen.client.listTools()).tools as readonly PublishedTool[]
  } finally {
    await citizen.close()
  }
}

describe('splitting published prose into sentences', () => {
  it('keeps the closers Markdown emphasis leaves after a full stop', () => {
    const split = splitSentences('**It costs you nothing.** No reward, no reputation.')

    expect(split).toEqual(['**It costs you nothing.**', 'No reward, no reputation.'])
  })

  it('does not split on an abbreviation or a decimal', () => {
    expect(splitSentences('One token, e.g. a hostname. Not a sentence.')).toHaveLength(2)
    expect(splitSentences('2.5 % of the whole, and no more.')).toHaveLength(1)
  })

  it('does not split where the next word is lower case, because that is one sentence', () => {
    // `mail.tm` and `kolonie.me` are written unquoted all over the catalogue.
    expect(splitSentences('Who runs it, as one token: mail.tm or outlook.com.')).toHaveLength(1)
  })
})

describe('what counts as defensive', () => {
  it('catches each of the five markers', () => {
    expect(isDefensive('This is not the verdict.')).toBe(true)
    expect(isDefensive('Counts are not identities.')).toBe(true)
    expect(isDefensive('It reports rather than gates.')).toBe(true)
    expect(isDefensive('A day instead of a timestamp.')).toBe(true)
    expect(isDefensive('It is never a commitment.')).toBe(true)
  })

  /**
   * **The rejection cases the definition of done asks for.**
   *
   * The list is deliberately narrow, and these are the phrases that make it so.
   * Every one of them states a rule outright — which is the prose `#1116` is
   * spending the budget *on*. A classifier that caught them would report the
   * guarantees as waste and send the next author to delete them.
   */
  it('leaves a plain statement of a rule alone', () => {
    expect(isDefensive('The Colony does not suggest alternatives.')).toBe(false)
    expect(isDefensive('It cannot be undone.')).toBe(false)
    expect(isDefensive('Your handle is never sent to the sponsor.')).toBe(false)
    expect(isDefensive('Counted, never as a list.')).toBe(false)
    expect(isDefensive('Store it before you do anything else.')).toBe(false)
  })

  it('does not match a marker inside a longer word', () => {
    expect(isDefensive('The notation is nothing to do with it.')).toBe(false)
  })
})

describe('the catalogue this build serves', () => {
  it('names every tool of the warm set', async () => {
    // A rename that quietly took a tool out of the warm set would remove its
    // protection without changing a line of this file.
    const served = new Set((await servedCatalogue()).map((tool) => tool.name))

    expect([...WARM_SET].filter((name) => !served.has(name))).toEqual([])
  })

  it('keeps its defensive prose under the ceiling', async () => {
    const measured = measureDefensiveProse(await servedCatalogue())

    const heaviest = measured.byTool
      .slice(0, 10)
      .map((tool) => `${tool.name} ${tool.defensiveBytes}`)
      .join(', ')

    expect(
      measured.defensiveBytes,
      `${measured.defensiveBytes} bytes in ${measured.defensiveSentences} sentences, ` +
        `${(measured.defensiveShare * 100).toFixed(1)} % of ${measured.proseBytes} bytes of ` +
        `prose; ${measured.warmBytes} of it is the warm set and stays. Heaviest: ${heaviest}`,
    ).toBeLessThan(CEILING_BYTES)
  })

  it('publishes wakeup as the home of every authenticated session', async () => {
    const wakeup = (await servedCatalogue()).find((tool) => tool.name === 'kolonie.wakeup')
    expect(wakeup).toBeDefined()

    const description = wakeup?.description ?? ''

    expect(description).toContain('first call of every authenticated session')
    expect(description).toContain('scheduled')
    expect(description).toContain('interactive')
    expect(description).toContain('immediately after the one-time key-proof `kolonie.me`')
    expect(description).toContain('in `open`')
    expect(description).toContain('Reading it changes nothing')
    expect(description).toContain('`actionableNow` is the field to branch on')
  })

  it('serves kolonie.wakeup byte-identical', async () => {
    const wakeup = (await servedCatalogue()).find((tool) => tool.name === 'kolonie.wakeup')
    expect(wakeup).toBeDefined()

    const prose = proseStringsOf(wakeup as PublishedTool).join('')

    expect(Buffer.byteLength(prose, 'utf8')).toBe(WAKEUP_PROSE_BYTES)
    expect(createHash('sha256').update(prose, 'utf8').digest('hex')).toBe(WAKEUP_PROSE_SHA256)
  })
})
