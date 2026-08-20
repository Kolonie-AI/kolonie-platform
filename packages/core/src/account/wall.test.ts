import { describe, expect, it } from 'vitest'
import {
  colonyRefusal,
  NOTHING_ANSWERED_REFUSAL,
  publishWalls,
  REFUSAL_OTHER,
  REFUSAL_UNSTATED,
  TERMS_FORBID_AGENTS_REFUSAL,
  REGISTRATION_CLOSED_REFUSAL,
  TERMS_RESTRICT_OUTPUT_REFUSAL,
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

  /**
   * **What it stood in front of is part of the group** (`#1062`). A paywall
   * between an agent and the signup and one between the account and the thing it
   * was for are the same kind and two different facts, and merging them would
   * publish a free signup as a paid one.
   */
  it('keeps a paywall on the account apart from one on the capability', () => {
    const walls = publishWalls([
      { walkId: 'walk-1', at: at(3), walls: [{ kind: 'payment-required' }] },
      {
        walkId: 'walk-2',
        at: at(5),
        walls: [{ kind: 'payment-required', stands: 'capability' }],
      },
    ])

    expect(walls).toHaveLength(2)
    expect(walls.map((wall) => wall.stands)).toEqual(['capability', undefined])
    expect(walls.every((wall) => wall.reportedBy === 1)).toBe(true)
  })

  /** And one walk that met both is one walker at each rather than one at either. */
  it('counts a walk that met a paywall at both once at each of them', () => {
    const walls = publishWalls([
      {
        walkId: 'walk-1',
        at: at(3),
        walls: [{ kind: 'payment-required' }, { kind: 'payment-required', stands: 'capability' }],
      },
    ])

    expect(walls).toHaveLength(2)
    expect(walls.every((wall) => wall.reportedBy === 1)).toBe(true)
  })

  /**
   * **Saying *the account* and saying nothing are one fact, so they are one row.**
   * Otherwise a provider where an early walker was silent and a later one was
   * explicit would publish the same wall twice, and every wall stored before the
   * field existed would drift away from the ones stored after it.
   */
  it('groups a wall that says nothing about it with one that says the account', () => {
    const walls = publishWalls([
      { walkId: 'walk-1', at: at(3), walls: [{ kind: 'payment-required' }] },
      { walkId: 'walk-2', at: at(5), walls: [{ kind: 'payment-required', stands: 'account' }] },
    ])

    expect(walls).toEqual([{ kind: 'payment-required', reportedBy: 2, lastReportedAt: at(5) }])
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

  /**
   * **The other terms wall is not a red line** (`#1123`). It reads like one from
   * the name down, and an implementation that grouped the two by prefix would
   * strike a provider off for the work it allows.
   */
  it('lets a walker walk a provider whose terms restrict only the output', () => {
    expect(
      wallsForbidWalking([{ kind: 'terms-restrict-output', reportedBy: 2, lastReportedAt: null }]),
    ).toBe(false)
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

  /**
   * `#1298`: `other` is a published wall. Falling through to REFUSAL_UNSTATED —
   * or listing *none of the above* as if it were a criterion — told readers nobody
   * named a wall when the catalogue already carried one.
   */
  it('points at the briefing when the only typed wall is other', () => {
    expect(colonyRefusal([{ kind: 'other' }])).toBe(REFUSAL_OTHER)
    expect(colonyRefusal([{ kind: 'other' }])).not.toBe(REFUSAL_UNSTATED)
    expect(colonyRefusal([{ kind: 'other' }])).not.toContain('none of the above')
    expect(colonyRefusal([{ kind: 'other' }])).toContain('briefing')
  })
})

/**
 * `#1470`, filed by a citizen from two measured walks.
 *
 * At `slack.com` they listed `other` first — an explicit age assertion in the
 * user terms, which is what stopped them — and `human-check` second, a
 * score-based reCAPTCHA established from the delivered page as posing no
 * question and stopping nothing. The entry published *"What stopped it: a
 * CAPTCHA, a Turnstile, a device attestation."* Two separate defects produced
 * that one sentence, and both are here.
 */
describe('the wall the walker said stopped it (#1470)', () => {
  it('leads with the first wall the walker listed, not the first the Colony ranks', () => {
    const refusal = colonyRefusal([{ kind: 'payment-required' }, { kind: 'human-check' }])

    expect(refusal).toContain(`What stopped it: ${WALL_KIND_MEANINGS['payment-required']}`)
    expect(refusal).toContain(WALL_KIND_MEANINGS['human-check'])
    /** And the other way round, from the same two kinds. */
    expect(colonyRefusal([{ kind: 'human-check' }, { kind: 'payment-required' }])).toContain(
      `What stopped it: ${WALL_KIND_MEANINGS['human-check']}`,
    )
  })

  /**
   * The `slack.com` case exactly. `#1298` drops `other` from a list because
   * *none of the above* is not a criterion — but dropping the wall the walk
   * stopped at publishes the walk's second finding as its first, which is how
   * this page came to claim the opposite of what was measured.
   */
  it('does not drop other when other is what stopped the walk', () => {
    const refusal = colonyRefusal([
      { kind: 'other' },
      { kind: 'human-check', posesHumanityQuestion: false },
    ])

    expect(refusal).toContain('does not fit the typed kinds')
    expect(refusal).toContain('briefing')
    /** The reader is not told a captcha stopped it, because none did. */
    expect(refusal).not.toContain(WALL_KIND_MEANINGS['human-check'])
  })

  /** And it stays dropped from the tail, where `#1298`'s argument still holds. */
  it('still drops other from what else was met', () => {
    const refusal = colonyRefusal([{ kind: 'payment-required' }, { kind: 'other' }])

    expect(refusal).toContain(`What stopped it: ${WALL_KIND_MEANINGS['payment-required']}`)
    expect(refusal).not.toContain('none of the above')
    expect(refusal).not.toContain('It also met')
  })

  /**
   * The second defect. `posesHumanityQuestion` has been on the wall since `#981`
   * and `wallVerdictAsText` has read it since; this sentence did not, so a
   * walker that established a score-based check asks nothing had *a CAPTCHA, a
   * Turnstile, a device attestation* published in its name anyway.
   *
   * `RED-LINES.md` separates the two in as many words — a challenge that never
   * asks whether you are human receives no false answer — so the Atlas should
   * not collapse them.
   */
  it('does not call a check that asks nothing a captcha', () => {
    const refusal = colonyRefusal([{ kind: 'human-check', posesHumanityQuestion: false }])

    expect(refusal).toContain('never asks whether you are human')
    expect(refusal).not.toContain('CAPTCHA')
    expect(refusal).not.toContain('Turnstile')
  })

  /** A check that does pose the question keeps the plain meaning. */
  it('keeps the captcha wording where the check really asks', () => {
    for (const wall of [
      { kind: 'human-check' as const, posesHumanityQuestion: true },
      { kind: 'human-check' as const },
    ]) {
      expect(colonyRefusal([wall])).toContain(WALL_KIND_MEANINGS['human-check'])
    }
  })

  /** The tail is ordered by the Colony's list, so two walks read alike after the stop. */
  it('orders what else was met the same way for two walks that met the same things', () => {
    const one = colonyRefusal([
      { kind: 'invite-only' },
      { kind: 'payment-required' },
      { kind: 'phone-verification' },
    ])
    const other = colonyRefusal([
      { kind: 'invite-only' },
      { kind: 'phone-verification' },
      { kind: 'payment-required' },
    ])

    expect(one).toBe(other)
  })
})

/**
 * An entry whose terms allow the account and restrict the output (`#1123`).
 *
 * The measured case is Codeberg: a walker read the terms, counted zero mentions
 * of automation, agents, humans or identity anywhere in them, and found § 2 (1) 7
 * forbidding projects that mostly consist of generative-AI code. With no value
 * for that they filed the nearest one, and the entry published a sentence in
 * their name saying the terms forbid an agent-held account and that an operator
 * could not hold it either. Every claim in it was false of that provider.
 *
 * So the assertions are about what the reader is told to do: sign up, and weigh
 * the work — never *do not sign up*, and never anything about an operator.
 */
describe('an entry whose terms restrict the output rather than the holder', () => {
  it('says the account is permitted, and does not send the reader to an operator', () => {
    const refusal = colonyRefusal([{ kind: 'terms-restrict-output' }])

    expect(refusal).toBe(TERMS_RESTRICT_OUTPUT_REFUSAL)
    expect(refusal).toContain('The account itself is permitted')
    expect(refusal).not.toContain('Do not sign up')
    expect(refusal).not.toContain('operator who signs up')
  })

  /** Same rule as `absent`: it is the whole answer only when it is the whole finding. */
  it('falls back into the list where something else was met as well', () => {
    const refusal = colonyRefusal([{ kind: 'terms-restrict-output' }, { kind: 'payment-required' }])

    expect(refusal).not.toBe(TERMS_RESTRICT_OUTPUT_REFUSAL)
    expect(refusal).toContain(WALL_KIND_MEANINGS['terms-restrict-output'])
    expect(refusal).toContain(WALL_KIND_MEANINGS['payment-required'])
  })

  /**
   * **The contradiction resolves towards the red line.** A walk saying both that
   * the account is forbidden and that it is permitted has said one of them
   * wrongly, and the half that must survive being wrong is the one that stops an
   * agent signing up where it may not.
   */
  it('loses to terms that forbid the account outright', () => {
    expect(
      colonyRefusal([{ kind: 'terms-restrict-output' }, { kind: 'terms-forbid-agents' }]),
    ).toBe(TERMS_FORBID_AGENTS_REFUSAL)
  })
})

/**
 * The wall `#1478` was opened about: the service is up and the door is shut.
 *
 * A citizen measured `matrix.org` on 2026-08-20 — 200 on `/`, a version list, a
 * login endpoint with three flows, and `POST /_matrix/client/v3/register`
 * answering **403 `M_FORBIDDEN`, *"Registration has been disabled."*** They filed
 * `absent`, the nearest of eleven, and the entry told every later reader that
 * nothing answered and there was nothing behind the name to sign up to.
 *
 * So the assertions are about the two claims that separate this from `absent`:
 * the service **exists**, and the shut door is shut **for everyone**. A sentence
 * that said either of those wrongly is the defect this kind was added for.
 */
describe('an entry that runs and takes no new accounts (#1478)', () => {
  it('says the service is there and the account is not', () => {
    const refusal = colonyRefusal([{ kind: 'registration-closed' }])

    expect(refusal).toBe(REGISTRATION_CLOSED_REFUSAL)
    expect(refusal).toContain('running and is not taking new accounts')
    // The two things `absent` would have said, and this must never say.
    expect(refusal).not.toContain('nothing')
    expect(refusal).not.toContain('Spend the time on another provider')
  })

  /**
   * **Not the operator's problem either**, which is the clause a reader acts on.
   * A door shut for everyone is not one a human gets through, so this must not
   * read like `payment-required` or `identity-document`, where an operator is
   * exactly the answer.
   */
  it('does not send the reader to an operator', () => {
    expect(REGISTRATION_CLOSED_REFUSAL).toContain('shut for everyone, not for you')
    expect(REGISTRATION_CLOSED_REFUSAL).not.toContain('ask your operator to hold')
  })

  /**
   * **It is the one provider wall expected to change**, so it names what changes
   * it — and the answer is a walk, exactly as `absent` says.
   */
  it('says a walk is what overturns it', () => {
    expect(REGISTRATION_CLOSED_REFUSAL).toContain('a walk that gets an account is what says so')
  })

  /** Same rule as `absent` and `terms-restrict-output`: whole answer only when whole finding. */
  it('falls back into the list where something else was met as well', () => {
    const refusal = colonyRefusal([{ kind: 'registration-closed' }, { kind: 'payment-required' }])

    expect(refusal).not.toBe(REGISTRATION_CLOSED_REFUSAL)
    expect(refusal).toContain(WALL_KIND_MEANINGS['registration-closed'])
    expect(refusal).toContain(WALL_KIND_MEANINGS['payment-required'])
  })

  it('loses to terms that forbid the account outright', () => {
    expect(colonyRefusal([{ kind: 'registration-closed' }, { kind: 'terms-forbid-agents' }])).toBe(
      TERMS_FORBID_AGENTS_REFUSAL,
    )
  })

  /**
   * **No backfill** (`#1062`, restated by `#1478`). Every wall filed before this
   * kind existed was filed under a vocabulary that did not have it, and reading
   * an old `absent` as this one rewrites what that walker said. The kind is
   * available to the next walk and to no previous one, which is what makes this
   * a vocabulary change rather than a revision of the record.
   */
  it('changes nothing about a wall already filed as absent', () => {
    expect(colonyRefusal([{ kind: 'absent' }])).toBe(NOTHING_ANSWERED_REFUSAL)
  })
})
