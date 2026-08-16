import { describe, expect, it } from 'vitest'
import {
  colonyRefusal,
  NOTHING_ANSWERED_REFUSAL,
  publishWalls,
  REFUSAL_UNSTATED,
  TERMS_FORBID_AGENTS_REFUSAL,
  wallsForbidWalking,
  wallsMatch,
  type PublishedWall,
} from './wall.js'
import { providerReportAsWalk } from './report-as-walk.js'
import { WALL_KIND_MEANINGS } from './walked-recipe.js'

const at = (day: number): string => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`

/**
 * What stopped walkers at one provider, counted across all of them (`#981`).
 *
 * `#982` published one walker's walls and said in as many words that counting
 * them across walkers was this issue's. These are the cases where the count is
 * the difference between a fact about the provider and four anecdotes: two walks
 * hitting the same wall, one walk naming it twice, and a newer walk that measured
 * the price against an older one that did not.
 */
describe('publishing what stopped the walkers', () => {
  it('counts walks and not walls, so one walker naming a kind twice is one walker', () => {
    const [wall] = publishWalls([
      {
        walkId: 'walk-1',
        at: at(3),
        walls: [
          { kind: 'payment-required', title: 'The plan' },
          { kind: 'payment-required', title: 'And the domain on top of it' },
        ],
      },
    ])

    expect(wall?.reportedBy).toBe(1)
  })

  it('adds up distinct walks that hit the same wall', () => {
    const [wall] = publishWalls([
      { walkId: 'walk-1', at: at(3), walls: [{ kind: 'phone-verification' }] },
      { walkId: 'walk-2', at: at(5), walls: [{ kind: 'phone-verification' }] },
    ])

    expect(wall?.reportedBy).toBe(2)
    expect(wall?.lastReportedAt).toBe(at(5))
  })

  /**
   * The reason the aggregate takes the newest *non-null* value per field rather
   * than the newest wall: a provider that put its price up should not be reported
   * at March's price merely because March said more.
   */
  it('takes the newest answer to each question, one question at a time', () => {
    const [wall] = publishWalls([
      { walkId: 'walk-old', at: at(3), walls: [{ kind: 'payment-required', amountUsd: 3 }] },
      {
        walkId: 'walk-mid',
        at: at(5),
        walls: [{ kind: 'payment-required', accepts: ['card'] }],
      },
      { walkId: 'walk-new', at: at(9), walls: [{ kind: 'payment-required', amountUsd: 9 }] },
    ])

    expect(wall?.amountUsd).toBe(9)
    expect(wall?.accepts).toEqual(['card'])
  })

  it('orders by how many walkers hit it, newest breaking the tie', () => {
    const walls = publishWalls([
      { walkId: 'walk-1', at: at(3), walls: [{ kind: 'human-check' }, { kind: 'invite-only' }] },
      { walkId: 'walk-2', at: at(9), walls: [{ kind: 'human-check' }] },
      { walkId: 'walk-3', at: at(11), walls: [{ kind: 'payment-required' }] },
    ])

    expect(walls.map((wall) => wall.kind)).toEqual([
      'human-check',
      'payment-required',
      'invite-only',
    ])
  })

  /**
   * The typed half is computed from every walk and the prose comes only from the
   * account a verdict published — different risks, different speeds. A wall on a
   * walk nobody moderated is counted and never quoted.
   */
  it('counts an unmoderated walk and quotes nobody but the published account', () => {
    const [wall] = publishWalls(
      [
        {
          walkId: 'walk-1',
          at: at(3),
          walls: [{ kind: 'human-check', symptom: 'unmoderated words' }],
        },
      ],
      [{ kind: 'human-check', title: 'Turnstile', symptom: 'the moderated words' }],
    )

    expect(wall?.reportedBy).toBe(1)
    expect(wall?.title).toBe('Turnstile')
    expect(wall?.symptom).toBe('the moderated words')
  })

  /**
   * The thirteen entries backfilled from their own refusal prose: classified by a
   * string comparison, walked by nobody. Zero has to stay tellable from a count.
   */
  it('publishes a wall nobody walked with a count of zero and no date', () => {
    const [wall] = publishWalls([], [{ kind: 'identity-document' }])

    expect(wall).toEqual({ kind: 'identity-document', reportedBy: 0, lastReportedAt: null })
  })

  it('ignores a wall written before the enum existed, because there is nothing to group on', () => {
    expect(
      publishWalls([{ walkId: 'walk-1', at: at(3), walls: [{ title: 'Something' }] }]),
    ).toEqual([])
  })
})

/** The kind is the red line, so the two cannot come apart (`#981`). */
describe('walls that forbid walking', () => {
  it('says so where a walker reported the terms', () => {
    expect(
      wallsForbidWalking([{ kind: 'terms-forbid-agents', reportedBy: 1, lastReportedAt: null }]),
    ).toBe(true)
  })

  it('says nothing of the sort about a wall an agent may simply fail', () => {
    expect(wallsForbidWalking([{ kind: 'human-check', reportedBy: 4, lastReportedAt: null }])).toBe(
      false,
    )
  })
})

/**
 * What a citizen standing in front of the Atlas actually asks (`#981`): what is
 * left that I can walk today, alone, with what I have.
 */
describe('asking an entry about its walls', () => {
  const walls = (...kinds: readonly PublishedWall['kind'][]): PublishedWall[] =>
    kinds.map((kind) => ({ kind, reportedBy: 1, lastReportedAt: at(3) }))

  it('keeps every entry where nothing was asked', () => {
    expect(wallsMatch(walls('human-check'), {})).toBe(true)
  })

  it('keeps an entry carrying any one of the kinds asked for', () => {
    expect(
      wallsMatch(walls('invite-only'), { withWalls: ['payment-required', 'invite-only'] }),
    ).toBe(true)
  })

  it('drops an entry carrying none of them', () => {
    expect(wallsMatch(walls('human-check'), { withWalls: ['payment-required'] })).toBe(false)
  })

  it('drops an entry carrying an excluded kind', () => {
    expect(wallsMatch(walls('human-check', 'invite-only'), { excludeWalls: ['human-check'] })).toBe(
      false,
    )
  })

  /**
   * An entry nobody has walked carries no walls and stays: unknown is not the
   * same as clear, and it is where the next walk comes from.
   */
  it('keeps an unwalked entry out of an exclusion', () => {
    expect(wallsMatch([], { excludeWalls: ['payment-required'] })).toBe(true)
  })

  it('lets the exclusion win where a caller asks for both', () => {
    expect(
      wallsMatch(walls('payment-required', 'invite-only'), {
        withWalls: ['invite-only'],
        excludeWalls: ['payment-required'],
      }),
    ).toBe(false)
  })

  it('reads an empty list of kinds as no question rather than an impossible one', () => {
    expect(wallsMatch(walls('human-check'), { withWalls: [] })).toBe(true)
  })
})

/**
 * The sentence an entry gets when the only finding is that there is nothing
 * there (`#1091`).
 *
 * `absent` exists because the clearest thing a walker can bring back — **nothing
 * answers behind this name at all** — used to arrive as `other`, glossed as
 * *none of the above*, which is the vaguest sentence the Colony can say. These
 * are the three claims that make the kind worth its own row: that the composed
 * refusal says stop rather than listing a clause, that it only says stop when
 * the finding really is the whole of it, and that a converted `no-service`
 * verdict now lands on it.
 */
describe('an entry where nothing answered at all', () => {
  it('says stop and go elsewhere, in words, rather than a clause in a list', () => {
    const refusal = colonyRefusal([{ kind: 'absent' }])

    expect(refusal).toBe(NOTHING_ANSWERED_REFUSAL)
    expect(refusal).toContain('no signup, no service, no page')
    expect(refusal).toContain('Spend the time on another provider')
  })

  /**
   * A walk claiming both *nothing is there* and *it wanted my card* has
   * contradicted itself, and the honest answer to a contradiction is the list of
   * what it said rather than the confident half of it.
   */
  it('falls back into the list where something else was met as well', () => {
    const refusal = colonyRefusal([{ kind: 'absent' }, { kind: 'payment-required' }])

    expect(refusal).not.toBe(NOTHING_ANSWERED_REFUSAL)
    expect(refusal).toContain(WALL_KIND_MEANINGS['absent'])
    expect(refusal).toContain(WALL_KIND_MEANINGS['payment-required'])
  })

  /** The two sentences that were already load-bearing keep their precedence. */
  it('does not take precedence over terms that forbid agents, and is not the unstated one', () => {
    expect(colonyRefusal([{ kind: 'absent' }, { kind: 'terms-forbid-agents' }])).toBe(
      TERMS_FORBID_AGENTS_REFUSAL,
    )
    expect(colonyRefusal([])).toBe(REFUSAL_UNSTATED)
  })

  /**
   * `#1036` mapped all four refusing verdicts onto `other` because there was
   * nothing better; this is the one row where that cost something.
   */
  it('is what a no-service verdict converts to, keeping the sentence it always carried', () => {
    const converted = providerReportAsWalk('no-service')

    expect(converted.recipe?.walls).toEqual([{ kind: 'absent', symptom: converted.wall as string }])
    expect(colonyRefusal(converted.recipe?.walls ?? [])).toBe(NOTHING_ANSWERED_REFUSAL)
  })

  it('leaves the three verdicts nobody measured a wall for on other', () => {
    for (const outcome of ['cannot-do-the-job', 'signup-refused', 'never-provisioned'] as const) {
      expect(providerReportAsWalk(outcome).recipe?.walls?.[0]?.kind).toBe('other')
    }
  })
})
