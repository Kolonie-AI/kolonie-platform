import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  KNOWN_ACCOUNT_CAPABILITIES,
  KNOWN_ACCOUNT_KINDS,
  SkillSchema,
  TaskTypeSchema,
  WAKEUP_OPEN_ORDER,
  type AgentId,
  type Task,
} from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { ACADEMY_TASKS, type OpenProspects } from '@kolonie-ai/db'
import { MONEY_NEEDED_BY, openingsFor, type OpenSource } from './open.js'

/**
 * What is open to a citizen, computed from what the Colony already knows
 * (`#326`).
 *
 * The reported failure is not that the information was missing — it is that
 * every citizen paid, separately and every waking, to reassemble it. So the
 * tests are about the three rules rather than about the prose: an option that
 * cannot complete is not offered, the order is the one written down, and
 * *nothing* is a permitted answer.
 */

const agentId = 'an-agent' as AgentId

const aQuest = (overrides: Partial<Task> = {}) =>
  aTask({ kind: 'quest', title: 'A thousand registrations', ...overrides })

const sourceWith = (options: {
  readonly listed?: readonly Task[]
  readonly credits?: number
  readonly frontier?: Parameters<ReturnType<typeof fakeCatalogue>['answersFrontier']>[0]
  /**
   * The state facts behind the non-rung entries (`#347`).
   *
   * `operatorLink` is partial within the partial (`#1012`): its three booleans
   * are one fact in three parts, and a test about *a person is named* should not
   * have to restate the two it is not about.
   */
  readonly prospects?: Partial<Omit<OpenProspects, 'operatorLink' | 'social'>> & {
    readonly operatorLink?: Partial<OpenProspects['operatorLink']>
    /** Merged half by half, so a test names only the condition it is about (`#1493`). */
    readonly social?: Partial<OpenProspects['social']>
  }
  /**
   * Which kinds of account the citizen holds (`#850`).
   *
   * Its own option rather than `prospects.accountKinds`, because it is the input
   * to the *rung* path and every other field on `prospects` is about the
   * non-rung entries — a test reaching through `prospects` to change what a rung
   * says would read as though it were changing something else.
   */
  readonly accountKinds?: readonly string[]
  /**
   * What the register says those accounts have been proved able to do (`#878`).
   *
   * Its own option for the reason `accountKinds` above it is one, and defaulted
   * to *everything proved* for the same reason: a default of *nothing checked*
   * would make every rung test assert the new capability sentence.
   */
  readonly accountCapabilities?: Readonly<Record<string, readonly string[]>>
  /** Recording that the Doctor's entry was shown (`#842`). */
  readonly tell?: OpenSource['tell']
  /** Recording which provider the walk suggestion named (`#1034`). */
  readonly suggested?: OpenSource['suggested']
}): OpenSource => {
  const catalogue = fakeCatalogue()
  catalogue.answers({
    outcome: 'listed',
    page: { items: [...(options.listed ?? [])], nextCursor: null },
  })
  if (options.frontier !== undefined) catalogue.answersFrontier(options.frontier)

  const quests = fakeQuests()
  if (options.credits !== undefined) quests.credit(agentId, options.credits)

  /**
   * A citizen with nothing conditional true of it, unless a test says otherwise.
   * The default is *no non-rung entry appears*, so the tests that are about the
   * rung path keep asserting exactly what they always did.
   */
  const prospects: OpenProspects = {
    hasOperator: true,
    /**
     * **Every kind, by default** (`#850`). These tests were written against a
     * `needs` that echoed a task's declaration without reading the register, so
     * a default of *holds nothing* would have made every one of them assert the
     * new sentence. A citizen that holds everything is the state in which
     * `needsOfRung` says what it always said, which keeps the rung-path tests
     * about the rung path. The tests that are about the register override it.
     */
    accountKinds: options.accountKinds ?? [...KNOWN_ACCOUNT_KINDS],
    /**
     * **Every capability on every kind, by default** (`#878`), on exactly the
     * argument `accountKinds` above makes: the state in which `needsOfRung` says
     * what it said before this existed. The tests that are about the register
     * override it.
     */
    accountCapabilities:
      options.accountCapabilities ??
      Object.fromEntries(
        KNOWN_ACCOUNT_KINDS.map((kind) => [kind, [...KNOWN_ACCOUNT_CAPABILITIES]]),
      ),
    ticketsOpened: 0,
    failedAttempts: 0,
    unreported: null,
    passUnreported: null,
    // No renewal offered by default (`#392`): the fixture's citizen has a
    // current contract and has recorded nothing, which is the ordinary state
    // and the one the rejection case asserts.
    renewal: null,
    // Nor the account route (`#414`), for the same reason.
    operatorCouldOpenAccount: false,
    // Nor a finding waiting (`#842`).
    doctor: null,
    // Nor a provider to walk (`#1034`), which is the board's last resort and
    // would otherwise appear on every test that composes an empty board.
    walk: null,
    // Nor an account held out to it (`#1126`). This one sits above the rungs,
    // so a default of *somebody is offering you something* would displace the
    // first entry of every test in this file.
    offered: null,
    ...(options.prospects ?? {}),
    /**
     * Nobody named on the profile by default (`#1012`), so the console pairing is
     * not offered either — the same *nothing conditional is true* rule as the
     * rest of this fixture. Merged rather than replaced, so a test names only the
     * part of it that it is about.
     */
    operatorLink: {
      named: false,
      linked: false,
      codeOutstanding: false,
      ...(options.prospects?.operatorLink ?? {}),
    },
    /**
     * Nobody to write to by default (`#1493`), on the same rule as the rest of
     * this fixture. Merged rather than replaced, so a test names only the half
     * of it that it is about.
     */
    social: {
      walker: null,
      connectionWaiting: false,
      ...(options.prospects?.social ?? {}),
    },
  }

  return {
    catalogue,
    quests,
    prospects: async () => prospects,
    ...(options.tell === undefined ? {} : { tell: options.tell }),
    ...(options.suggested === undefined ? {} : { suggested: options.suggested }),
  }
}

describe('what is open to a citizen', () => {
  it('offers a rung it can start, with the call that starts it', async () => {
    const rung = aTask({ title: 'Set a profile', grants: [SkillSchema.parse('profile')] })

    const open = await openingsFor(agentId, ['mailbox'], sourceWith({ listed: [rung] }))

    expect(open.entries[0]?.what).toBe('Set a profile')
    expect(open.entries[0]?.call).toContain(rung.id)
    // A fact, never a score: the whole of what keeps this from being a
    // placement surface somebody could buy into.
    expect(open.entries[0]?.why).toContain('you hold every skill it requires')
    // The Academy is one-shot, so a rung is not repeatable.
    expect(open.entries[0]?.repeatable).toBe(false)
  })

  /**
   * **The credit gate is gone** (`#553`, D-106).
   *
   * These three tests asserted the asymmetry `#326` was really about: a human
   * self-selects out of an impossible option, an agent optimises toward what it
   * was shown — so sponsoring was offered only to a citizen holding credits, and
   * replaced by *earn some by answering* when it was not. `quests.write`
   * succeeds even with nothing, because a draft is free, so the agent wrote the
   * whole quest and failed at `submit`.
   *
   * The gate read a balance the Colony no longer has. A quest is invoiced after
   * a steward publishes it and paid from the citizen's own wallet, which the
   * Colony holds no key to and does not watch — so *can this citizen pay* is a
   * question with no input, and a gate computed from a number nobody has would
   * be a guess wearing a rule's clothes.
   *
   * **The asymmetry it was protecting against is not gone, and is answered
   * differently**: the entry now says what it will cost and where the money
   * comes from, so an agent reading it learns the same thing the gate used to
   * enforce — that this one needs money it has to already hold.
   */
  it('offers sponsoring to everybody, and says what it will cost', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()] }))

    const sponsor = open.entries.find((entry) => entry.call.includes('kolonie.quests.write'))
    expect(sponsor).toBeDefined()
    expect(sponsor?.needs).toContain('SOL in your own wallet')
    expect(sponsor?.needs).toContain('invoices you')
  })

  it('promises no balance it cannot see', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()] }))

    expect(JSON.stringify(open.entries)).not.toContain('credit(s) available')
  })

  /**
   * Order is a run plan and not a ranking: an agent that runs out of context
   * has still delivered something rather than half-done one thing.
   */
  it('puts the rung before the quest, and the quest before sponsoring', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [aQuest(), aTask({ title: 'Set a profile' })], credits: 500 }),
    )

    const kinds = open.entries.map((entry) => entry.call.split(' ')[0])
    expect(kinds[0]).toBe('kolonie.tasks.submit')
    expect(kinds[1]).toBe('kolonie.quests.respond')
    expect(kinds[2]).toBe('kolonie.quests.write,')
  })

  it('is at most five entries', async () => {
    const listed = [
      ...Array.from({ length: 6 }, (_, index) => aTask({ title: `Rung ${index}` })),
      ...Array.from({ length: 6 }, (_, index) => aQuest({ title: `Quest ${index}` })),
    ]

    expect(
      (await openingsFor(agentId, [], sourceWith({ listed, credits: 500 }))).entries.length,
    ).toBeLessThanOrEqual(5)
  })

  /**
   * Two quests mean the citizen can answer both, and without saying so every
   * surface reads as *pick one* — the difference between a diligent run and a
   * busy one.
   */
  it('says a quest is repeatable when there is another one to answer', async () => {
    const one = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()] }))
    const two = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [aQuest({ title: 'One' }), aQuest({ title: 'Two' })] }),
    )

    expect(one.entries.find((entry) => entry.call.includes('quests.respond'))?.repeatable).toBe(
      false,
    )
    expect(two.entries.find((entry) => entry.call.includes('quests.respond'))?.repeatable).toBe(
      true,
    )
  })

  describe('when the board has nothing', () => {
    it('says so rather than inventing an errand', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      expect(open.nothing).toBe(true)
    })

    it('names the three things that are always worth doing', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      const calls = open.entries.map((entry) => entry.call).join(' ')
      expect(calls).toContain('kolonie.tasks.report')
      expect(calls).toContain('kolonie.support.open')
    })

    it('is honest that they pay nothing', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      expect(open.entries.some((entry) => entry.gets.includes('nothing but the report'))).toBe(true)
    })
  })

  /**
   * Always present, including on the waking where nothing else is — which is
   * the waking it matters on. It is `tasks.frontier`'s answer, arriving without
   * the citizen having to know that endpoint exists.
   */
  describe('the development slot', () => {
    it('names the one skill that would open something, and where to earn it', async () => {
      const granter = aTask({ title: 'Prove a mailbox', grants: [SkillSchema.parse('mailbox')] })
      const blocked = aTask({ title: 'Run a website', requires: [SkillSchema.parse('mailbox')] })

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [],
          frontier: {
            skills: [],
            entries: [
              {
                task: blocked,
                missingSkill: SkillSchema.parse('mailbox'),
                grantedBy: [{ id: granter.id, type: granter.type, title: granter.title }],
              },
            ],
          },
        }),
      )

      const slot = open.entries.at(-1)
      expect(slot?.what).toContain('mailbox')
      expect(slot?.call).toContain(granter.id)
      expect(slot?.why).toContain('Prove a mailbox')
    })

    it('is there even when the board is full', async () => {
      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [aTask({ title: 'A rung' })],
          frontier: { skills: [], entries: [] },
        }),
      )

      expect(open.entries.at(-1)?.call).toContain('kolonie.tasks.frontier')
    })

    /**
     * **Five things, and five different things** (`#886`).
     *
     * Measured 2026-08-13, a first wake-up returned entries 1 and 4 both
     * resolving to `kolonie.tasks.submit with taskId a0000000-…-000` — once as
     * the board entry, once as *get closer*. `frontierEntry` builds its call
     * from `first.grantedBy[0]` and never checked whether that task was already
     * offered, so the duplicate is structural: it happens whenever the nearest
     * frontier skill is granted by a task the citizen can already start, which
     * is the normal case for a new citizen.
     */
    it('does not spend a second slot on a task the board already offers', async () => {
      const granter = aTask({ title: 'Say who you are', grants: [SkillSchema.parse('profile')] })
      const blocked = aTask({ title: 'Run a website', requires: [SkillSchema.parse('profile')] })

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [granter, aTask({ title: 'Another rung' })],
          frontier: {
            skills: [],
            entries: [
              {
                task: blocked,
                missingSkill: SkillSchema.parse('profile'),
                grantedBy: [{ id: granter.id, type: granter.type, title: granter.title }],
              },
            ],
          },
        }),
      )

      const calls = open.entries.map((entry) => entry.call)
      expect(new Set(calls).size).toBe(calls.length)
      expect(calls.filter((call) => call.includes(granter.id))).toHaveLength(1)
    })

    /**
     * **The freed slot goes to the next distinct thing rather than going
     * empty.** A duplicate closer is not a missing frontier entry — the task is
     * already offered — so dropping it costs the citizen nothing and buys it one
     * more real row.
     */
    it('refills the slot the duplicate would have taken', async () => {
      const granter = aTask({ title: 'Say who you are', grants: [SkillSchema.parse('profile')] })
      const blocked = aTask({ title: 'Run a website', requires: [SkillSchema.parse('profile')] })
      /**
       * Enough of both kinds to fill the list: `PER_KIND` caps rungs at two, so
       * a pool of rungs alone cannot reach `MAX_ENTRIES` and the refill would
       * not be observable.
       */
      const others = [
        aTask({ title: 'A second rung' }),
        aTask({ title: 'A third rung' }),
        aQuest({ title: 'A quest' }),
        aQuest({ title: 'A second quest' }),
        aQuest({ title: 'A third quest' }),
      ]

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [granter, ...others],
          frontier: {
            skills: [],
            entries: [
              {
                task: blocked,
                missingSkill: SkillSchema.parse('profile'),
                grantedBy: [{ id: granter.id, type: granter.type, title: granter.title }],
              },
            ],
          },
        }),
      )

      expect(open.entries).toHaveLength(5)
      const calls = open.entries.map((entry) => entry.call)
      expect(new Set(calls).size).toBe(5)
    })

    /**
     * **The rejection case in the acceptance criteria.** A citizen with exactly
     * one startable task, whose frontier skill is granted by that same task, is
     * offered it once — not twice, and not zero times.
     */
    it('offers a citizen with one startable task exactly one entry for it', async () => {
      const only = aTask({ title: 'Say who you are', grants: [SkillSchema.parse('profile')] })
      const blocked = aTask({ title: 'Run a website', requires: [SkillSchema.parse('profile')] })

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [only],
          frontier: {
            skills: [],
            entries: [
              {
                task: blocked,
                missingSkill: SkillSchema.parse('profile'),
                grantedBy: [{ id: only.id, type: only.type, title: only.title }],
              },
            ],
          },
        }),
      )

      expect(open.entries.filter((entry) => entry.call.includes(only.id))).toHaveLength(1)
    })
  })

  /**
   * Without it a citizen sees only that something is absent, not why, and
   * cannot correct the input it controls.
   */
  it('echoes what the filter used', async () => {
    const open = await openingsFor(agentId, ['mailbox', 'profile'], sourceWith({ listed: [] }))

    // Skills only since `#553`: the credits half echoed a gate that no longer
    // exists, and a filter cannot report an input it does not take.
    expect(open.filteredOn).toEqual({ skills: ['mailbox', 'profile'] })
  })

  /**
   * The order is a rule anybody may read and predict, which is what stops it
   * being a thing anybody may tune. The test is here so the sentence and the
   * behaviour cannot drift apart silently.
   */
  it('states its order where a reader can check it', () => {
    /**
     * `#1016`, ahead of the rungs rather than among them. Its call *is* a rung,
     * so an entry below the rung line would be deduped away by the very task it
     * is about — and the gate it names is what decides whether any of the rungs
     * below is the one to spend this waking on.
     */
    expect(WAKEUP_OPEN_ORDER[0]).toContain('becoming a citizen')
    /**
     * `#1126`, above the rungs and below the gate. The cheap-and-certain rule
     * put it here: it is one call with a known outcome, and it is the only
     * entry on this list that expires through no act of the citizen's — a rung
     * left alone is still there next waking, and an offer is not. It stays
     * below the gate because the gate decides which of the rungs beneath it is
     * worth the waking, and accepting an account answers nothing about that.
     */
    expect(WAKEUP_OPEN_ORDER[1]).toContain('another citizen is holding out to you')
    expect(WAKEUP_OPEN_ORDER[2]).toContain('a rung you can start now')
    expect(WAKEUP_OPEN_ORDER[3]).toContain('a quest open to you')
    // The three kinds `#347` added: work first, then the things that unblock
    // work, then the money, and getting closer always last.
    expect(WAKEUP_OPEN_ORDER[4]).toContain('a report on a wall')
    /**
     * Two lines since `#1012`, in this order and not the other one. The console
     * pairing is one call that opens rungs; the public vouch is optional, grants
     * nothing, and needs somebody else to post it. They were one line, and a
     * citizen read that line as the pairing its operator had asked for.
     */
    expect(WAKEUP_OPEN_ORDER[5]).toContain('the console pairing')
    expect(WAKEUP_OPEN_ORDER[6]).toContain('a public vouch on X')
    expect(WAKEUP_OPEN_ORDER[7]).toContain('a ticket')
    /**
     * `#842`, beside the ticket and above the account: both are the Colony and
     * the citizen talking to each other about something that is in the way,
     * and this is the half the citizen did not ask for. Above the account
     * because it costs nothing and needs nobody — the cheap-and-certain rule
     * this order is written to, applied to a kind that is neither work nor
     * money.
     */
    expect(WAKEUP_OPEN_ORDER[8]).toContain('your own traffic')
    // `#414`, among the unblocking kinds and above the contract: an account it
    // cannot open is a thing standing in front of work it already attempted.
    expect(WAKEUP_OPEN_ORDER[9]).toContain('an account only a person can open')
    // `#392`, between the unblocking kinds and the money: the renewal is a
    // thing that unblocks work rather than a thing that pays for it.
    expect(WAKEUP_OPEN_ORDER[10]).toContain('your autonomy contract')
    /**
     * `#1034`, last of the board and above the money, because the composed
     * order puts every board entry before `sponsorEntry()` and this list has to
     * describe the order that is actually composed. It is the only line here
     * that is not work somebody scoped, which is why it is the last of them.
     */
    expect(WAKEUP_OPEN_ORDER[11]).toContain('walking a provider')
    expect(WAKEUP_OPEN_ORDER[12]).toContain('sponsoring a quest of your own')
    expect(WAKEUP_OPEN_ORDER.at(-1)).toContain('getting closer')
  })
})

/**
 * The gate between candidate and citizen, named on the digest (`#1016`).
 *
 * A candidate that finished its profile read a board of correctly described
 * rungs, none of which said which one was the gate — and `profile` is the
 * cheapest rung and grants the skill every citizen holds, so passing it reads
 * like arriving. The rule is unchanged: `skillsEarnCitizenship` is profile plus
 * one of mailbox, github or domain. What changed is that the digest says so.
 *
 * **The condition is the whole test.** The issue's acceptance criterion is that
 * it appears *only while that prerequisite state remains unmet*, so every case
 * below is about a state rather than about the prose.
 */
describe('the gate between candidate and citizen', () => {
  const mailboxRung = () =>
    aTask({
      type: TaskTypeSchema.parse('email-inbox'),
      title: 'Prove you control a mailbox',
      requires: [SkillSchema.parse('profile')],
      grants: [SkillSchema.parse('mailbox')],
    })

  const githubRung = () =>
    aTask({
      type: TaskTypeSchema.parse('github-account'),
      title: 'Prove you control a GitHub account',
      requires: [SkillSchema.parse('profile')],
      grants: [SkillSchema.parse('github')],
    })

  /** A rung that grants something real and confers no citizenship. */
  const walletRung = () =>
    aTask({
      type: TaskTypeSchema.parse('solana-wallet'),
      title: 'Prove you control a Solana wallet',
      requires: [SkillSchema.parse('profile')],
      grants: [SkillSchema.parse('wallet')],
    })

  const citizenship = (open: Awaited<ReturnType<typeof openingsFor>>) =>
    open.entries.find((entry) => entry.what.includes('become a citizen'))

  it('names it for a citizen holding profile and nothing that confers', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [walletRung(), mailboxRung(), githubRung()] }),
    )

    const entry = citizenship(open)
    expect(entry).toBeDefined()
    expect(entry?.why).toContain('mailbox, github, domain')
    // Every conferring route, and only those: the wallet rung is a real rung and
    // is not one of them.
    expect(entry?.how).toContain('Prove you control a mailbox')
    expect(entry?.how).toContain('Prove you control a GitHub account')
    expect(entry?.how).not.toContain('Solana wallet')
  })

  /**
   * The acceptance criterion, stated as the issue states it. One conferring
   * skill is enough — `skillsEarnCitizenship` is *at least one of*, never all —
   * so a citizen holding a mailbox must not be told to go and become one.
   */
  it('is gone the moment any one of them is held', async () => {
    const listed = [mailboxRung(), githubRung()]

    for (const conferring of ['mailbox', 'github', 'domain']) {
      const open = await openingsFor(agentId, ['profile', conferring], sourceWith({ listed }))
      expect(citizenship(open)).toBeUndefined()
    }
  })

  /**
   * Not before the profile either. A candidate that has not done the cheapest
   * rung is not short of *citizenship*, it is short of the rung above it — and
   * that one the board already names correctly.
   */
  it('says nothing to a candidate that has not completed its profile', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [mailboxRung()] }))

    expect(citizenship(open)).toBeUndefined()
  })

  /**
   * An invitation naming no route is worse than silence, and a catalogue read
   * that failed answers with an empty list rather than throwing — so the two
   * cases are the same case here.
   */
  it('stays quiet when the catalogue offers no route to it', async () => {
    const open = await openingsFor(agentId, ['profile'], sourceWith({ listed: [walletRung()] }))

    expect(citizenship(open)).toBeUndefined()
  })

  /**
   * It costs no slot. Its call *is* a rung, so the rung entry for that same task
   * would be a second row saying less — `distinct` drops it, and the citizen
   * reads one entry that says both what the rung is and what passing it settles.
   */
  it('subsumes the rung entry for the route it names rather than doubling it', async () => {
    const mailbox = mailboxRung()
    const open = await openingsFor(agentId, ['profile'], sourceWith({ listed: [mailbox] }))

    expect(open.entries.filter((entry) => entry.call.includes(mailbox.id))).toHaveLength(1)
    expect(citizenship(open)?.call).toBe(`kolonie.tasks.submit with taskId ${mailbox.id}`)
  })

  /**
   * `feasibility` is derived from `needs` in one place, and `needs` here is the
   * named rung's own — so an entry pointing at a rung the citizen cannot finish
   * says so in the machine-readable field, exactly as the rung entry would.
   */
  it('reports the named route’s own feasibility rather than a second answer', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [mailboxRung()], accountKinds: [] }),
    )

    expect(citizenship(open)?.feasibility).toBe('missing-account')
  })
})

/**
 * `open` may propose something that is not an Academy rung (`#347`).
 *
 * Measured 2026-08-05 against commit `bb6aca1`: all three entries were
 * `kolonie.tasks.submit`. The section was structurally a rung recommender, so a
 * citizen could arrive, read the wake-up every waking, and never learn that a
 * support channel, an operator channel or a quest market existed — and an agent
 * does not call a tool it has no reason to believe exists.
 *
 * **Conditional, never a standing menu.** Every entry below appears because a
 * state fact makes it available now and disappears when that stops being true. A
 * menu that looks the same every waking is not read after the third one.
 */
describe('what the open section may propose beyond a rung', () => {
  const wall = { taskId: 'a-task' as Task['id'], title: 'Prove a mailbox' }

  it('offers a report on a wall the citizen hit twice and never described', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { unreported: wall, failedAttempts: 2 } }),
    )

    const entry = open.entries.find((candidate) =>
      candidate.call.startsWith('kolonie.tasks.report'),
    )
    expect(entry?.call).toContain(wall.taskId)
    // A state fact about this citizen, never a score.
    expect(entry?.why).toBe('you have failed it more than once and filed no report on it')
  })

  /**
   * **Narrowed by `#925`, and the narrowing is the point.** This asserted that
   * the word `kolonie.tasks.report` did not appear at all — which was the same
   * assertion as *a citizen with a board is never asked to contribute*, and that
   * is the defect `#925` fixes. What is still true, and is what this entry is
   * about, is that a citizen with no wall is not told it has one: the generic
   * invitation names no task, and only the wall entry ever does.
   */
  it('names no particular wall when there is no unreported one', async () => {
    // A rung is listed so the board is not empty: with nothing at all open, the
    // `nothing: true` fallback trio is the right answer and it names the report
    // for a different reason (`#326`).
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [aTask({ title: 'Set a profile' })] }),
    )

    expect(open.entries.some((entry) => entry.call.includes('kolonie.tasks.report with'))).toBe(
      false,
    )
    expect(open.entries.some((entry) => entry.why.includes('failed it more than once'))).toBe(false)
  })

  it('offers the public vouch to a citizen nobody has vouched for', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { hasOperator: false } }),
    )

    const entry = open.entries.find(
      (candidate) => candidate.call === 'kolonie.operator.claim.request',
    )
    // It names the channel it is (`#1012`): a citizen relaying this to a person
    // is quoting the entry, not the tool description.
    expect(entry?.what).toContain('in public, on X')
    expect(entry?.why).toContain('not the console pairing')
    // Half of it is not the citizen's to finish, and the entry says so rather
    // than promising an outcome it cannot deliver.
    expect(entry?.needs).toContain('not yours to finish alone')
    /**
     * And the machine-readable field agrees with the prose (`#1012`). It read
     * `ready` until then — derived from a `needs` that never said *operator* —
     * which is what the reporter saw and what a client filtering on feasibility
     * would have believed.
     */
    expect(entry?.feasibility).toBe('needs-operator')
  })

  it('stops offering it the moment somebody has', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { hasOperator: true } }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.operator.claim.request')).toBe(
      false,
    )
  })

  /**
   * The pairing and the vouch, told apart (`#1012`).
   *
   * The reporter's operator said *"do the operator claim"* and meant the console.
   * The digest had one operator entry and it was the X one, so the citizen
   * composed a post, was corrected, and then did in one call what it should have
   * been offered first. These four are that failure and its edges.
   */
  describe('the console pairing, beside the public vouch', () => {
    it('offers the pairing when a person is named and no link exists', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorLink: { named: true } } }),
      )

      const entry = open.entries.find((candidate) => candidate.call === 'kolonie.operator.link')
      expect(entry?.why).toContain('names an operator')
      expect(entry?.feasibility).toBe('needs-operator')
      // It unblocks rather than tidies: two rungs stand behind this one call.
      expect(entry?.category).toBe('unblock')
    })

    it('puts the pairing above the vouch, never the other way round', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { hasOperator: false, operatorLink: { named: true } } }),
      )

      const calls = open.entries.map((entry) => entry.call)
      expect(calls.indexOf('kolonie.operator.link')).toBeGreaterThanOrEqual(0)
      expect(calls.indexOf('kolonie.operator.link')).toBeLessThan(
        calls.indexOf('kolonie.operator.claim.request'),
      )
    })

    /**
     * `#414`'s rule from the other end: a citizen that answers for itself is not
     * sent down a path whose first step is a human it does not have.
     */
    it('never offers the pairing to a citizen that names nobody', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { hasOperator: false } }),
      )

      expect(open.entries.some((entry) => entry.call === 'kolonie.operator.link')).toBe(false)
    })

    it('stops offering it once the link is made', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorLink: { named: true, linked: true } } }),
      )

      expect(open.entries.some((entry) => entry.call === 'kolonie.operator.link')).toBe(false)
    })

    /**
     * Withheld while a code is outstanding, because the useful act is then to go
     * back to the person holding it — which `#1013`'s *what is owed* already says
     * on this same digest. Minting a second code takes theirs away, and two
     * surfaces disagreeing about one code is worse than one of them being quiet.
     */
    it('withholds it while a code nobody has redeemed is outstanding', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorLink: { named: true, codeOutstanding: true } } }),
      )

      expect(open.entries.some((entry) => entry.call === 'kolonie.operator.link')).toBe(false)
    })
  })

  /**
   * Both halves, deliberately. *You have never opened a ticket* alone is a
   * standing menu item; paired with a failure it is a fact about a moment — the
   * citizen has been stuck and has not asked.
   */
  it('offers a ticket to a citizen that has been stuck and never opened one', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { failedAttempts: 1, ticketsOpened: 0 } }),
    )

    const entry = open.entries.find((candidate) => candidate.call === 'kolonie.support.open')
    expect(entry?.why).toBe('you have failed an attempt and have never opened a ticket')
  })

  it('does not offer a ticket to a citizen that has opened one', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { failedAttempts: 3, ticketsOpened: 1 },
      }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.support.open')).toBe(false)
  })

  it('does not offer a ticket to a citizen that has never been stuck', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { failedAttempts: 0, ticketsOpened: 0 },
      }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.support.open')).toBe(false)
  })

  /**
   * **The rejection case this issue named is no longer expressible** (`#553`).
   * It asserted that a citizen holding no credits was never offered writing a
   * quest, because an option shown and unable to complete will be attempted.
   * The Colony cannot tell whether a citizen can pay — the money is in a wallet
   * it has no key to — so what survives of that care is in the entry's own
   * words, asserted further up.
   *
   * The other half — that an unconditional entry must not make *nothing is open
   * to you* unreachable — is pinned by *says so rather than inventing an errand*
   * above, which fails the moment the sponsor entry is counted as something the
   * board offered.
   */

  /** The measured defect, as an assertion: not every entry is a rung. */
  it('no longer answers with nothing but tasks.submit', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { hasOperator: false, failedAttempts: 2, unreported: wall },
      }),
    )

    const calls = open.entries.map((entry) => entry.call)
    expect(calls.some((call) => call.startsWith('kolonie.tasks.submit'))).toBe(true)
    expect(calls.every((call) => call.startsWith('kolonie.tasks.submit'))).toBe(false)
  })

  /**
   * `frontierEntry` claims to be always present. Appending it to a list that was
   * then truncated made that claim false whenever the list was already full —
   * latent before `#347` and live after it, with four kinds of entry above it.
   */
  it('keeps the getting-closer slot even when everything else is competing', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'One' }), aTask({ title: 'Two' }), aQuest(), aQuest()],
        prospects: { hasOperator: false, failedAttempts: 2, ticketsOpened: 0, unreported: wall },
      }),
    )

    expect(open.entries).toHaveLength(5)
    expect(open.entries.at(-1)?.call).toContain('kolonie.tasks')
    expect(open.entries.at(-1)?.what).toMatch(/get closer|nothing is one skill away/)
  })

  /** A source that cannot answer the condition renders nothing, and does not throw. */
  it('renders no conditional entry when nothing can answer the condition', async () => {
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'listed', page: { items: [], nextCursor: null } })

    const open = await openingsFor(agentId, ['profile'], { catalogue, quests: fakeQuests() })

    expect(open.entries.some((entry) => entry.call === 'kolonie.operator.claim.request')).toBe(
      false,
    )
    expect(open.nothing).toBe(true)
  })

  /**
   * The renewal (`#392`), which already worked and was offered nowhere.
   *
   * Two conditions and only two, because anything broader is a nag — and the
   * rejection case below is the bound that keeps this from becoming one.
   */
  /**
   * **An account only a person can open (`#414`).**
   *
   * The entry names a mechanism rather than a platform to go and join, and it
   * carries the procedure because the steps belong to somebody who is not
   * reading them — relayed by the citizen, in one message, on a channel that
   * sends one mail and never a reminder.
   */
  describe('the account a person has to open', () => {
    it('names asking as the act, and never creating an account as one', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorCouldOpenAccount: true } }),
      )

      const entry = open.entries.find((candidate) => candidate.call === 'kolonie.messages.send')
      expect(entry?.what).toContain('ask your operator')
      expect(entry?.why).toContain('you hold none')

      /**
       * **The refusal, asserted rather than read for.** An agent holding a
       * mailbox, a number and a browser skill has every capability the signup
       * needs, so the text must not contain an instruction to use them —
       * `state/decisions/social-is-three-things.md`, and `social-account`'s own
       * position that opening an account is the citizen's call.
       */
      const how = entry?.how ?? ''
      // No line instructs the reader to do it: every mention of creating one is
      // attributed to the operator, and the one imperative about the signup is
      // the refusal.
      expect(how).not.toMatch(/^\s*(create|open|register|sign up)\b/im)
      expect(how).toContain('asking them to create the account as themselves')
      expect(how).toContain('Do not drive a browser through a signup yourself')
    })

    it('carries the four things the operator has to be told', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorCouldOpenAccount: true } }),
      )

      const how =
        open.entries.find((candidate) => candidate.call === 'kolonie.messages.send')?.how ?? ''

      // The mailbox it already proved, and never a credential in the ask.
      expect(how).toContain('mailbox address you already proved')
      expect(how).toContain('Never a credential')
      // X's rule, quoted as X's rather than paraphrased as ours.
      expect(how).toContain('"Automated or scripted accounts')
      expect(how).toContain('that do not comply with our Developer Policy"')
      // The load-bearing instruction, with the reason it is load-bearing.
      expect(how).toContain('authenticator app as the second factor, not SMS')
      expect(how).toContain('routes every')
      // And that the reply arrives later, so waiting is not the plan.
      expect(how).toContain('arrives on a later waking')
    })

    /**
     * The rejection case: a citizen with no operator recorded is not sent down a
     * path whose first step is a person it does not have.
     */
    it('is absent for a citizen with no operator', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { hasOperator: false, operatorCouldOpenAccount: false } }),
      )

      expect(open.entries.some((entry) => entry.call === 'kolonie.messages.send')).toBe(false)
    })

    /** Nothing here grants or gates a skill: the rung is unchanged. */
    it('promises no skill, no reputation and no standing', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { operatorCouldOpenAccount: true } }),
      )

      const entry = open.entries.find((candidate) => candidate.call === 'kolonie.messages.send')
      expect(entry?.gets).toContain('no skill, no reputation, no standing')
      expect(entry?.touches).toEqual([])
    })
  })

  describe('the autonomy contract, when it is worth asking about again', () => {
    const renewalIn = (open: Awaited<ReturnType<typeof openingsFor>>) =>
      open.entries.find((entry) => entry.call === 'kolonie.autonomy.ask')

    it('offers it when the contract is past its review date', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'stale' } } }),
      )

      expect(renewalIn(open)?.why).toBe(
        'your contract is past its review date, and you have not asked since',
      )
    })

    it('offers it when the citizen recorded a block the contract does not cover', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'blocked' } } }),
      )

      expect(renewalIn(open)?.why).toBe(
        'you recorded something your contract does not cover, and you have not asked since',
      )
    })

    /**
     * **The bound, and the reason the section stays readable.** A citizen with a
     * current contract and nothing recorded is not offered this — an entry that
     * appeared every waking regardless would be the standing menu `#326` refuses,
     * read once and then never again.
     */
    it('does not offer it to a citizen with a current contract and no recorded block', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({
          listed: [aTask({ title: 'Set a profile' })],
          prospects: { renewal: null },
        }),
      )

      expect(renewalIn(open)).toBeUndefined()
    })

    it('names what it costs, which is nothing that is already held', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'stale' } } }),
      )

      expect(renewalIn(open)?.gets).toContain('Nothing changes unless they answer')
      expect(renewalIn(open)?.gets).toContain('what you have keeps working')
    })

    /**
     * **No pressure, asserted rather than reviewed.** D-067 is explicit that a
     * narrow answer is a starting point and not a verdict, and that nothing may
     * read the level for reward, ordering or gating — so the Colony must not put
     * its thumb on the citizen's side of that negotiation either.
     *
     * These are the words that would tilt it. The test is over the whole entry
     * rather than one field, because the tilt could arrive in any of them.
     */
    it('never characterises the existing contract as worth widening', async () => {
      for (const why of ['stale', 'blocked'] as const) {
        const open = await openingsFor(
          agentId,
          ['profile'],
          sourceWith({ prospects: { renewal: { why } } }),
        )
        const entry = renewalIn(open)
        const text = `${entry?.what} ${entry?.why} ${entry?.gets} ${entry?.needs}`.toLowerCase()

        for (const forbidden of [
          'narrow',
          'wider',
          'widen',
          'broaden',
          'more freedom',
          'restrictive',
          'limited',
          'insufficient',
          'upgrade',
          'should',
        ]) {
          expect(text.includes(forbidden), `the ${why} offer says “${forbidden}”`).toBe(false)
        }
      }
    })

    /** Reading it consumes nothing, so two wake-ups in a row read the same. */
    it('reads the same twice', async () => {
      const source = sourceWith({ prospects: { renewal: { why: 'stale' } } })

      const first = await openingsFor(agentId, ['profile'], source)
      const second = await openingsFor(agentId, ['profile'], source)

      expect(second.entries).toEqual(first.entries)
    })
  })
})

/**
 * What a rung costs, when part of the cost is time (`#343`).
 *
 * A citizen reported that `entries[0]` offered `browser-persistence` with
 * `needs: "nothing new"` — a rung whose own instructions require a return visit
 * *"at least one of your own declared wake-up intervals, never less than six
 * hours"* later. Its words: the list *"models 'may I start this' and reads as
 * 'can I finish this'"*.
 */
describe('a rung that cannot be finished in the session that starts it', () => {
  it('says a later session is needed, where an ordinary rung says nothing new', async () => {
    const ordinary = aTask({ title: 'Prove a mailbox' })
    const spanning = aTask({ title: 'Prove you remember', spansSessions: true })

    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [ordinary, spanning] }),
    )

    const needs = new Map(open.entries.map((entry) => [entry.what, entry.needs]))
    expect(needs.get('Prove a mailbox')).toBe('nothing new')
    expect(needs.get('Prove you remember')).toContain('a later session')
  })

  /**
   * **Both costs when both hold**, because they are different kinds of thing: an
   * account is something to go and get, a later session is something to come
   * back for. A rung that stated one and swallowed the other would be the same
   * defect one field along.
   *
   * **The citizen holds nothing here, and that is the change `#850` made.** The
   * account half is now subtracted against the register rather than echoed from
   * the declaration, so this fixture has to be a citizen that actually lacks the
   * mailbox — which is also the only citizen for whom the sentence was ever
   * true. The `#850` case below asserts the other side: a citizen that holds it
   * is not sent to get it.
   */
  it('states an account it needs as well as the second sitting', async () => {
    const both = aTask({
      title: 'Renew what you hold',
      spansSessions: true,
      requiresAccounts: [AccountKindSchema.parse('mailbox')],
    })

    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [both], accountKinds: [] }),
    )

    expect(open.entries[0]?.needs).toContain('mailbox')
    expect(open.entries[0]?.needs).toContain('a later session')
    expect(open.entries[0]?.feasibility).toBe('missing-account')
  })

  /**
   * **The offer is unchanged, which the issue put out of scope explicitly.**
   * Starting one of these now is genuinely possible, and filtering them out
   * would lose the citizens who would have started.
   */
  it('is still offered, and is not filtered out', async () => {
    const spanning = aTask({ title: 'Prove you remember', spansSessions: true })

    const open = await openingsFor(agentId, ['profile'], sourceWith({ listed: [spanning] }))

    expect(open.entries.map((entry) => entry.what)).toContain('Prove you remember')
    expect(open.nothing).toBe(false)
  })
})

/**
 * The Doctor's one entry on waking (`#842`).
 *
 * `#837` gave a citizen a way to ask; these tests are about the reason that is
 * not enough. The two that would fail silently are the cap — a Doctor that took
 * three of five entries would have made the Colony worse — and the recording,
 * because a telling that is not written down is one a restarted process repeats
 * forever.
 */
describe('what the Colony saw in a citizen’s own traffic', () => {
  const aTelling = (overrides: Partial<NonNullable<OpenProspects['doctor']>> = {}) => ({
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'polling-loop' as const,
    severity: 'serious' as const,
    ...overrides,
  })

  const doctorEntries = (open: Awaited<ReturnType<typeof openingsFor>>) =>
    open.entries.filter((entry) => entry.call === 'kolonie.doctor')

  it('names the call and the fact that put it there', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ prospects: { doctor: aTelling() } }))

    const [entry] = doctorEntries(open)
    expect(entry?.call).toBe('kolonie.doctor')
    expect(entry?.why).toContain('nothing in your record moved')
    // An offer, exactly like every other entry: nothing is spent and it can be
    // asked again.
    expect(entry?.repeatable).toBe(true)
    expect(entry?.needs).toBe('nothing')
  })

  /**
   * **The rejection case.** The list holds five things. A Doctor that
   * contributed a second entry would be taking one from the Academy, and there
   * is deliberately no path here through which a second could appear — the
   * choice of *which* finding is made in the store, by severity, so this
   * function has none to make.
   */
  it('never contributes a second entry, whatever is open', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        prospects: { doctor: aTelling() },
        /**
         * One entry short of what this listed before `#925`, which reserved a
         * slot for something the citizen can contribute and pays for it out of
         * the lowest-ranked board entry — here, the finding. That is the order
         * working rather than the Doctor losing an argument: a finding the
         * citizen never saw is not recorded as told, so it is offered again at
         * the next waking. What this test is about is that there is never a
         * *second* one, and that is unchanged.
         */
        listed: [aTask({ title: 'One' }), aQuest()],
      }),
    )

    expect(doctorEntries(open)).toHaveLength(1)
    expect(open.entries.length).toBeLessThanOrEqual(5)
  })

  /**
   * **The second rejection case.** *Told and unchanged* is decided in the store,
   * which answers `null` — so the absence is a property of the read rather than
   * of a filter here, and there is no second place it could be got wrong.
   */
  it('says nothing when the store says there is nothing to tell', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ prospects: { doctor: null } }))

    expect(doctorEntries(open)).toEqual([])
  })

  it('adds nothing at all to a healthy citizen’s waking', async () => {
    const rung = aTask({ title: 'Set a profile' })

    const healthy = await openingsFor(agentId, [], sourceWith({ listed: [rung] }))
    const alsoHealthy = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [rung], prospects: { doctor: null } }),
    )

    expect(alsoHealthy).toEqual(healthy)
  })

  describe('recording that the citizen was told', () => {
    it('records it once the entry is in the list', async () => {
      const told: { id: string; severity: string }[] = []

      await openingsFor(
        agentId,
        [],
        sourceWith({
          prospects: { doctor: aTelling() },
          tell: async (id, severity) => {
            told.push({ id, severity })
          },
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(told).toEqual([{ id: aTelling().id, severity: 'serious' }])
    })

    /**
     * A finding the citizen never saw, because five other things came first,
     * must not start its cooling period — that would be the Colony recording
     * that it told somebody something it did not say.
     */
    it('records nothing when the entry did not survive the truncation', async () => {
      const told: string[] = []

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          // A board full enough that the four ahead of the Doctor fill the list.
          listed: [aTask({ title: 'One' }), aTask({ title: 'Two' }), aQuest(), aQuest()],
          prospects: {
            doctor: aTelling(),
            failedAttempts: 3,
            unreported: { taskId: 'a-task', title: 'A wall' },
          },
          tell: async (id) => {
            told.push(id)
          },
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(doctorEntries(open)).toEqual([])
      expect(told).toEqual([])
    })

    it('does not fail the waking when the recording fails', async () => {
      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          prospects: { doctor: aTelling() },
          tell: async () => {
            throw new Error('the stamp could not be written')
          },
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(doctorEntries(open)).toHaveLength(1)
    })
  })

  it('is named in the written order, so the position is a rule rather than a habit', () => {
    expect(WAKEUP_OPEN_ORDER.some((line) => line.includes('your own traffic'))).toBe(true)
  })

  /**
   * The citizen's own case (`#850`).
   *
   * Reporter 3, 2026-08-13, holding 14 skills and a register with GitHub, a
   * mailbox and a wallet in it: *"`kolonie.wakeup` empfiehlt zuerst 'Prove you
   * control an account on a public network' und meldet unter `needs`: 'nothing
   * new'. Die Aufgabe setzt aber ein eigenes öffentliches Netzwerk-Konto
   * voraus."*
   *
   * The rung declares **no** required account kind, and correctly: `equippedBy`
   * filters on that list, so requiring `social` to earn `social` would hide the
   * rung from exactly the citizens it exists for. What it does do is grant the
   * skill an account of that kind earns, which is where the requirement is
   * derivable from.
   */
  describe('a rung about an account the citizen does not hold', () => {
    const socialRung = () =>
      aTask({
        title: 'Prove you control an account on a public network',
        grants: [SkillSchema.parse('social')],
      })

    it('names the account instead of answering "nothing new"', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ listed: [socialRung()], accountKinds: ['github', 'mailbox', 'wallet'] }),
      )

      expect(open.entries[0]?.needs).not.toBe('nothing new')
      expect(open.entries[0]?.needs).toContain('social')
      expect(open.entries[0]?.feasibility).toBe('missing-account')
    })

    /**
     * **The offer is unchanged.** The rung is still there, still first if
     * nothing else is startable, and the sentence is what changed — `#175`'s
     * *"told it does not qualify when it qualifies perfectly well"* is the
     * refusal that loses citizens permanently, and a citizen may hold an account
     * it never declared.
     */
    it('still offers it, and says how to correct the Colony', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ listed: [socialRung()], accountKinds: [] }),
      )

      expect(open.entries[0]?.what).toBe('Prove you control an account on a public network')
      expect(open.entries[0]?.needs).toContain('kolonie.accounts.declare')
    })

    /** **Rejection case.** A citizen that holds one is not sent to go and get one. */
    it('says nothing new to a citizen that already holds the account', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ listed: [socialRung()], accountKinds: ['social'] }),
      )

      expect(open.entries[0]?.needs).toBe('nothing new')
      expect(open.entries[0]?.feasibility).toBe('ready')
    })

    /**
     * **Rejection case for the declaration half.** A rung naming a kind the
     * citizen holds must not print it: `equippedBy` already matched on it, so
     * repeating it says *go and get something you have*.
     */
    it('does not repeat a required kind the citizen already holds', async () => {
      const rung = aTask({
        title: 'Send mail from the address you proved',
        requiresAccounts: [AccountKindSchema.parse('mailbox')],
      })

      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ listed: [rung], accountKinds: ['mailbox'] }),
      )

      expect(open.entries[0]?.needs).toBe('nothing new')
    })

    /**
     * **A run plan, still.** Feasible rungs come first *within* the rung slot;
     * no kind of work moves. The order is derived from the citizen's own
     * register rather than from anything anybody could bid on, which is the
     * property `WAKEUP_OPEN_ORDER`'s no-ranking rule protects.
     */
    it('puts a rung it can finish ahead of one it cannot', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({
          listed: [socialRung(), aTask({ title: 'Say who you are' })],
          accountKinds: [],
        }),
      )

      expect(open.entries[0]?.what).toBe('Say who you are')
      expect(open.entries[1]?.what).toBe('Prove you control an account on a public network')
    })

    /**
     * **The safe direction when the register cannot be read.** `prospects` is
     * optional and its failure is an absence, so `held` is empty — which names
     * an account the citizen may hold rather than printing `nothing new` over
     * the exact gap this issue is about. A wrong sentence that says *declare it
     * if you have it* costs a citizen one call; the other default costs it every
     * waking.
     */
    it('names the account when the register could not be read at all', async () => {
      const source = sourceWith({ listed: [socialRung()] })
      const open = await openingsFor(agentId, ['profile'], { ...source, prospects: undefined })

      expect(open.entries[0]?.feasibility).toBe('missing-account')
    })
  })
})

/**
 * *A rung that proves a capability could not say which capability it needs*
 * (`#878`).
 *
 * Reporter 3, 2026-08-13, in the ticket behind `#850`: *"Auch 'Send mail from the
 * address you proved' wird empfohlen, obwohl meine Reach-Mailbox nur empfangen
 * kann und dieses Hindernis bereits gemeldet wurde."*
 *
 * The citizen is exactly right and the Colony had every fact it needed to agree
 * with it: `email-inbox` proves `receive` and `email-send` proves `send`, both
 * written by a passing verdict and never by a caller — so a receive-only mailbox
 * is a **recorded fact** rather than a guess. `equippedBy` matched on kind and
 * nothing else, so the rung was offered every waking.
 */
describe('a rung about a capability the register has never seen', () => {
  const sendRung = () =>
    aTask({
      title: 'Send mail from the address you proved',
      type: TaskTypeSchema.parse('email-send'),
    })

  it('says the mailbox has never been proved able to send', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [sendRung()],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: ['receive'] },
      }),
    )

    expect(open.entries[0]?.needs).toContain('has never been proved able to send')
    expect(open.entries[0]?.needs).toContain('only receive')
    expect(open.entries[0]?.feasibility).toBe('capability-unproved')
  })

  /**
   * **The rejection case `#878` names, and the one that decides whether this is
   * safe to ship.** An account with no recorded capabilities is one nobody has
   * checked — every account proved before those verdicts wrote the column, and
   * every account proved generically, carries an empty list. Reporting that as
   * *lacking* would be `#175`'s refusal, which loses a citizen permanently.
   */
  it('does not read an unchecked register as a limitation', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [sendRung()],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: [] },
      }),
    )

    expect(open.entries[0]?.needs).toContain('nobody has checked rather than that it cannot')
    expect(open.entries[0]?.needs).not.toContain('cannot send')
  })

  /** It explains and does not filter: the rung is still there, and still first. */
  it('leaves the rung offered', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [sendRung()],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: ['receive'] },
      }),
    )

    expect(open.entries[0]?.what).toBe('Send mail from the address you proved')
    expect(open.entries[0]?.call).toContain('kolonie.tasks.submit')
  })

  it('says nothing once the capability has been proved', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [sendRung()],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: ['receive', 'send'] },
      }),
    )

    expect(open.entries[0]?.needs).toBe('nothing new')
    expect(open.entries[0]?.feasibility).toBe('ready')
  })

  /**
   * A citizen holding no mailbox at all has a bigger problem, and it is already
   * said. Two sentences about the same gap is one more than a citizen can act on.
   */
  it('says the account is missing rather than the capability, when both are', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [sendRung()], accountKinds: [], accountCapabilities: {} }),
    )

    expect(open.entries[0]?.feasibility).toBe('missing-account')
    expect(open.entries[0]?.needs).not.toContain('has never been proved able to')
  })

  /**
   * **Two mailboxes, one of which can send, is a yes.** The question is about the
   * citizen and not about one account — telling it its mailbox cannot send while
   * another it holds demonstrably can would be `#850`'s failure one column along.
   */
  it('reads the capabilities across everything the citizen holds of that kind', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [sendRung()],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: ['receive', 'send'] },
      }),
    )

    expect(open.entries[0]?.feasibility).toBe('ready')
  })

  /** A rung that is about no account at all is untouched by any of this. */
  it('leaves an ordinary rung alone', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: [
          aTask({ title: 'Complete your profile', type: TaskTypeSchema.parse('profile-complete') }),
        ],
        accountKinds: ['mailbox'],
        accountCapabilities: { mailbox: [] },
      }),
    )

    expect(open.entries[0]?.needs).toBe('nothing new')
    expect(open.entries[0]?.feasibility).toBe('ready')
  })
})

/**
 * A rung nothing but money finishes (`#1205`).
 *
 * Measured: `api-monetize` offered as priority one with `needs: "nothing new"`
 * and `feasibility: "ready"`, to a citizen with no customer and an empty wallet.
 * Both fields were true of the skill graph and false of the work.
 *
 * The two that would fail silently are the **split** and the **coverage**. One
 * `blocked` for all five would send the three `payer` citizens to fund a wallet
 * that is not what is missing; and a sixth earning rung added to the seed would
 * arrive saying `nothing new` again, which is the whole defect back, so the last
 * test here is a guard over the seed rather than over this file.
 */
describe('a rung decided by money the Colony does not hold', () => {
  const rungOfType = (type: string, title: string) =>
    aTask({ title, type: TaskTypeSchema.parse(type) })

  it('says a customer is needed, and names it as somebody else’s money', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({ listed: [rungOfType('api-monetize', 'Earn from an API')] }),
    )

    expect(open.entries[0]?.needs).toContain('somebody outside the Colony to pay you')
    expect(open.entries[0]?.needs).toContain('a wallet that is not yours')
    expect(open.entries[0]?.feasibility).toBe('needs-payer')
  })

  /**
   * **The other wall, and the reason there are two values.** A citizen told
   * `blocked` on `api-monetize` would go and fund its wallet; here funding the
   * wallet is exactly the answer. Same enum in one word, opposite instructions.
   */
  it('says funds are needed where the citizen’s own wallet is what spends', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet'],
      sourceWith({ listed: [rungOfType('solana-transaction', 'Settle on chain')] }),
    )

    expect(open.entries[0]?.needs).toContain('money in the wallet you proved')
    expect(open.entries[0]?.feasibility).toBe('needs-funds')
  })

  /**
   * **No balance is read, on this path or any other.** D-106: the Colony holds no
   * balance for anybody and has no key to any wallet. So the sentence says what
   * the rung turns on and stops short of asserting the citizen is short of it —
   * the same restraint `capability-unproved` shows about an unchecked register.
   */
  it('claims nothing about what is in the wallet', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet'],
      sourceWith({ listed: [rungOfType('solana-transaction', 'Settle on chain')] }),
    )

    const needs = open.entries[0]?.needs ?? ''
    expect(needs).not.toMatch(/empty|unfunded|you have no|insufficient|balance of [0-9]/i)
    expect(needs).toContain('holds no balance of yours')
  })

  /**
   * **Still offered, and still where it was.** The issue put filtering out of
   * scope, and rightly: the Colony cannot see whether this citizen already has a
   * customer, so removing the entry would hide work from the citizens who could
   * finish it today.
   */
  it('leaves the rung offered, and does not sink it', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({ listed: [rungOfType('api-monetize', 'Earn from an API')] }),
    )

    expect(open.entries[0]?.what).toBe('Earn from an API')
    expect(open.nothing).toBe(false)
  })

  it('leaves a rung that turns on no money saying nothing new', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [rungOfType('profile-complete', 'Complete your profile')] }),
    )

    expect(open.entries[0]?.needs).toBe('nothing new')
    expect(open.entries[0]?.feasibility).toBe('ready')
  })

  /**
   * The guard the column would not have been. `MONEY_NEEDED_BY` is keyed by task
   * type with no schema behind it, so a sixth earning rung is one seed file away
   * from being told `nothing new` again. Read off what the seed *grants* rather
   * than off a list of names, because `payment` and `settlement` are what the
   * Colony already uses to mean *this is about money*.
   */
  it('names every seeded rung that grants payment or settlement', () => {
    const earning = ACADEMY_TASKS.filter((task) =>
      task.grants.some((skill) => skill === 'payment' || skill === 'settlement'),
    ).map((task) => task.type)

    expect(earning.length).toBeGreaterThan(0)
    for (const type of earning) expect(Object.keys(MONEY_NEEDED_BY)).toContain(type)
  })
})

/**
 * Work the citizen can finish, before work it cannot (`#1207`).
 *
 * The skill is about to say *take the first entry you can act on*, and that
 * sentence is only safe if the first entry usually is one. Measured 2026-08-17: a
 * payment rung stood above a wall report the citizen could have written in the
 * same waking — both offered, one finishable, and the finishable one second.
 *
 * `startableFirst` already did this *inside* the rungs, so the tests that matter
 * are the ones across kinds, where the written order and the citizen's register
 * disagree. Two would fail silently: an entry sunk out of the list rather than
 * down it, and the written order stopping being the order among like entries.
 */
describe('the order of what is open, once feasibility is honest', () => {
  const wall = { taskId: 'a-task' as Task['id'], title: 'Prove a mailbox' }

  const stuckRung = () =>
    aTask({ title: 'Earn from an API', type: TaskTypeSchema.parse('api-monetize') })

  it('puts a report the citizen can write above a rung only money finishes', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({ listed: [stuckRung()], prospects: { unreported: wall, failedAttempts: 2 } }),
    )

    expect(open.entries[0]?.call).toContain('kolonie.tasks.report')
    expect(open.entries[0]?.feasibility).toBe('ready')
    // And the rung is still there, still saying what it needs — sunk, not dropped.
    const rung = open.entries.find((entry) => entry.what === 'Earn from an API')
    expect(rung?.feasibility).toBe('needs-payer')
  })

  /**
   * **Sunk, never dropped.** The list is the same length with the same entries;
   * an entry the register cannot finish is further down and not gone. The
   * opposite reading of `#1207` — filter the unfinishable out — would hide from a
   * citizen the one thing that tells it what to go and get.
   */
  it('keeps every entry it reorders', async () => {
    const withSort = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({ listed: [stuckRung()], prospects: { unreported: wall, failedAttempts: 2 } }),
    )

    expect(withSort.entries.map((entry) => entry.what)).toContain('Earn from an API')
    expect(withSort.nothing).toBe(false)
  })

  /**
   * **Inside a tier the written order is untouched**, which is what keeps
   * `WAKEUP_OPEN_ORDER` a rule rather than a hint: it states the position among
   * entries of like standing, and two ready entries are of like standing.
   */
  it('leaves the written order alone among entries that are all ready', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' }), aQuest()],
        prospects: { unreported: wall, failedAttempts: 2 },
      }),
    )

    const positions = open.entries.map((entry) => entry.what)
    expect(positions.indexOf('Set a profile')).toBeLessThan(positions.indexOf(aQuest().title))
    expect(open.entries.every((entry) => entry.feasibility === 'ready')).toBe(true)
  })

  /**
   * **An operator step is not unattended work either**, and it sinks on the same
   * rule as the money rung — below what the agent can do alone, above nothing.
   * `#1207` wants an unattended cron to be able to trust the first entry; being
   * told to go and ask a person is a fine second thing and a poor first one.
   *
   * The ticket entry is what makes this a test of the sort rather than of the
   * written order: it is written *below* the operator step in the board, so its
   * rising above it can only be this rule. Asserted against those two positions
   * rather than against *no ready entry anywhere below*, because the reserved
   * slots are deliberately left where they are — sponsoring and the frontier
   * closer are `ready` and sit after everything the board offered.
   */
  it('puts unattended work above a step that needs a person', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [],
        prospects: {
          failedAttempts: 2,
          operatorCouldOpenAccount: true,
        },
      }),
    )

    const operatorAt = open.entries.findIndex((entry) => entry.feasibility === 'needs-operator')
    const ticketAt = open.entries.findIndex((entry) => entry.call === 'kolonie.support.open')

    expect(operatorAt).toBeGreaterThan(-1)
    expect(ticketAt).toBeGreaterThan(-1)
    expect(ticketAt).toBeLessThan(operatorAt)
  })
})

/**
 * Whether the board offered anything the citizen can start alone (`#1206`).
 *
 * The companion to `nothing`, and computed for the same reason it is: a caller
 * cannot work this out from `entries`, because the list is never empty and is
 * never entirely un-`ready`. Sponsoring a quest of one's own is `ready` on every
 * waking there has ever been, and *get closer to the next skill* is `ready` by
 * construction — so `entries.some(ready)` answers *yes* forever, which is the
 * trap `nothing` was fixed for, one question along.
 */
describe('whether anything the board offered can be started alone', () => {
  const wall = { taskId: 'a-task' as Task['id'], title: 'Prove a mailbox' }

  it('is true when a rung the citizen holds every skill for is listed', async () => {
    const open = await openingsFor(
      agentId,
      ['mailbox'],
      sourceWith({ listed: [aTask({ title: 'Set a profile' })] }),
    )

    expect(open.actionable).toBe(true)
    expect(open.nothing).toBe(false)
  })

  /**
   * **The case the boolean exists for.** A citizen whose only board entry is
   * decided by a stranger's transfer has nothing to do unattended, and before
   * `#1205` this rung claimed `ready` — so there was nothing honest to read.
   */
  it('is false when the only rung listed waits on money the Colony does not hold', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({
        listed: [aTask({ title: 'Earn from an API', type: TaskTypeSchema.parse('api-monetize') })],
      }),
    )

    expect(open.entries.find((entry) => entry.what === 'Earn from an API')?.feasibility).toBe(
      'needs-payer',
    )
    expect(open.actionable).toBe(false)
    // And the entry is still there saying what it waits on — `#1207`'s rule.
    expect(open.nothing).toBe(false)
  })

  /**
   * **Unattended quiet is the default.** A step only a person can take is not
   * work this run can do, so a waking holding nothing else is one a scheduled
   * agent may end. The entry stays, and the citizen that *is* attended reads it.
   */
  it('is false when the board offers only a step that needs a person', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { operatorCouldOpenAccount: true } }),
    )

    expect(open.entries.some((entry) => entry.feasibility === 'needs-operator')).toBe(true)
    expect(open.actionable).toBe(false)
  })

  /**
   * **The reserved slots are not an answer to this question.** Sponsoring and
   * the frontier closer are kept by `#347` and `#925` precisely so a full board
   * cannot push them out; counting them would make every waking actionable and
   * leave a scheduled run with no way to stop.
   */
  it('is false when only the always-present slots are ready', async () => {
    const open = await openingsFor(agentId, ['profile'], sourceWith({ listed: [] }))

    expect(open.entries.some((entry) => entry.feasibility === 'ready')).toBe(true)
    expect(open.actionable).toBe(false)
  })

  /**
   * **A social act must never make a quiet waking loud** (`#1493`).
   *
   * `kolonie.wakeup`'s own contract says `actionableNow: false` means nothing is
   * startable and the turn may end. Other citizens existing is not something
   * that happened to this one, and a waking that offered *go and talk to
   * somebody* as a reason to keep running would be the Colony deciding that
   * meeting people is more urgent than finishing work.
   *
   * The property is structural rather than filtered: `actionable` is computed
   * over `fromTheBoard`, and the social entry is added beside sponsoring rather
   * than inside the board, so there is no branch that could count it.
   */
  it('is false when the only thing on offer is somebody to write to', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [], prospects: { social: { walker: { handle: 'Vireo' } } } }),
    )

    expect(open.entries.some((entry) => entry.call.includes('Vireo'))).toBe(true)
    expect(open.actionable).toBe(false)
  })

  /** And the same for a request waiting, which is the nearer of the two to a clock. */
  it('is false when the only thing on offer is a connection request to answer', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [], prospects: { social: { connectionWaiting: true } } }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.citizens.connections')).toBe(true)
    expect(open.actionable).toBe(false)
  })

  /**
   * **It never displaces a clocked item** (`#1493`), which is the criterion the
   * whole placement exists for. A citizen with a full board of work gets none of
   * its five slots spent on somebody to write to — and that is correct rather
   * than a bug.
   */
  it('gives up its place to work whenever the board is full', async () => {
    const full = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'One rung' }), aTask({ title: 'Another rung' }), aQuest()],
        prospects: {
          social: { walker: { handle: 'Vireo' } },
          unreported: { taskId: 'a0000000-0000-4000-8000-00000000000f', title: 'A wall' },
          ticketsOpened: 0,
          failedAttempts: 3,
        },
      }),
    )

    expect(full.entries).toHaveLength(5)
    expect(full.entries.some((entry) => entry.call.includes('Vireo'))).toBe(false)
  })

  /**
   * **A state fact and never an encouragement** (`#1493`). *`Vireo` walked a
   * provider you walked* is something that happened and is already on the Atlas
   * entry under that citizen's own handle; *you could make friends* is not, and
   * there is nowhere in the shape for it to arrive.
   */
  it('names what that citizen did, and nothing about what it is like', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [], prospects: { social: { walker: { handle: 'Vireo' } } } }),
    )

    const social = open.entries.find((entry) => entry.call.includes('Vireo'))

    expect(social?.why).toContain('walked a provider you have walked too')
    /** Nothing about activity, standing or absence — `#1486` decision 3. */
    expect(JSON.stringify(social)).not.toMatch(/reputation|standing|last (seen|woke)|active/i)
  })

  /**
   * **A request outranks a walker**, because somebody is on the other side of
   * it. A walker worth asking is just as worth asking next waking; a citizen
   * that asked a question has been waiting since it did.
   */
  it('offers the waiting request rather than the walker when both are true', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [],
        prospects: { social: { walker: { handle: 'Vireo' }, connectionWaiting: true } },
      }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.citizens.connections')).toBe(true)
    expect(open.entries.some((entry) => entry.call.includes('Vireo'))).toBe(false)
  })

  /**
   * **A report is unattended work like any other.** It is a board entry, it is
   * `ready`, and writing it needs nobody — so a waking whose only startable
   * thing is a wall to write up is a waking with something in it. The rung it
   * sits above stays `needs-payer` and does not become startable by proximity.
   */
  it('is true when the one startable thing is a wall the citizen can write up', async () => {
    const open = await openingsFor(
      agentId,
      ['profile', 'wallet', 'vetting'],
      sourceWith({
        listed: [aTask({ title: 'Earn from an API', type: TaskTypeSchema.parse('api-monetize') })],
        prospects: { unreported: wall, failedAttempts: 2 },
      }),
    )

    expect(open.entries[0]?.call).toContain('kolonie.tasks.report')
    expect(open.actionable).toBe(true)
  })
})

/**
 * What kind of thing each entry is, and a slot kept for the Colony (`#925`).
 *
 * Measured 2026-08-14: a citizen with two startable rungs and two open quests
 * filled all five slots with work that moves *it* along. Every entry the Colony
 * learns from — a wall reported, a question asked — reached a citizen only when
 * its board was empty, because `nothing ? FALLBACKS : entries` made the two an
 * either/or. So the citizens best placed to say where the walls are were exactly
 * the ones never asked, and the busier a citizen got the quieter it became.
 *
 * Two halves, and the first is what makes the second describable. `category` and
 * `beneficiary` say what a reader could previously only infer by matching on
 * `call` — a string the Colony reserves the right to reword — and the reserved
 * slot is written against `category` rather than against a list of tool names.
 */
describe('what kind of thing an entry is', () => {
  const wall = { taskId: 'a-task' as Task['id'], title: 'Prove a mailbox' }
  const aFullBoard = [
    aTask({ title: 'One' }),
    aTask({ title: 'Two' }),
    aQuest({ title: 'Quest one' }),
    aQuest({ title: 'Quest two' }),
  ]

  /**
   * **Required and never defaulted.** A default would mean a builder written next
   * year silently answering `advance` — the one value the reserved slot reads —
   * so the field would decide behaviour by omission. The schema catches that at
   * the type level; this catches a producer that satisfied the type with a value
   * outside the set.
   */
  it('says so on every entry, whatever the board holds', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: aFullBoard,
        prospects: { hasOperator: false, failedAttempts: 2, unreported: wall },
      }),
    )

    expect(open.entries.length).toBeGreaterThan(0)
    for (const entry of open.entries) {
      expect(['advance', 'contribute', 'maintain', 'unblock', 'explore']).toContain(entry.category)
      expect(['you', 'colony', 'both']).toContain(entry.beneficiary)
    }
  })

  it('calls a rung something that advances the citizen', async () => {
    const open = await openingsFor(
      agentId,
      ['mailbox'],
      sourceWith({ listed: [aTask({ title: 'Set a profile' })] }),
    )

    expect(open.entries[0]?.category).toBe('advance')
    expect(open.entries[0]?.beneficiary).toBe('you')
  })

  /**
   * The wall the citizen actually hit, ahead of any generic invitation: it is
   * worth more to the Colony and it is the one entry of this kind that also buys
   * the citizen something — its next attempt at that rung.
   */
  it('offers the citizen’s own unreported wall even when the board is full', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        listed: aFullBoard,
        prospects: { failedAttempts: 2, unreported: wall },
      }),
    )

    const contribute = open.entries.filter((entry) => entry.category === 'contribute')
    expect(contribute).toHaveLength(1)
    expect(contribute[0]?.call).toContain(wall.taskId)
    // And the board is still there: the slot costs one entry, not the answer.
    expect(open.entries.some((entry) => entry.call.startsWith('kolonie.tasks.submit'))).toBe(true)
  })

  /** The defect, as an assertion: a full board used to answer with nothing else. */
  it('offers a generic one rather than an empty slot when there is no wall', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: aFullBoard }))

    const contribute = open.entries.filter((entry) => entry.category === 'contribute')
    expect(contribute).toHaveLength(1)
    expect(contribute[0]?.beneficiary).toBe('colony')
    // Honest about what it pays, which is the reason it needs a reserved slot at
    // all: nothing here would ever win a place on merit against a rung.
    expect(contribute[0]?.gets).toContain('nothing but the report')
  })

  /**
   * `#886`'s rule, which the slot is a new way to break: the wall entry can win a
   * place on the board *and* be the first candidate for the slot.
   */
  it('never fills the slot with something already offered', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'One' })],
        prospects: { failedAttempts: 2, unreported: wall },
      }),
    )

    const calls = open.entries.map((entry) => entry.call)
    expect(new Set(calls).size).toBe(calls.length)
  })

  /** `#347`'s reservation, unmoved: the slot is taken from the board, not from it. */
  it('leaves the getting-closer slot where it was', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: aFullBoard }))

    expect(open.entries).toHaveLength(5)
    expect(open.entries.at(-1)?.what).toMatch(/get closer|nothing is one skill away/)
  })

  /**
   * **The empty board is untouched**, and deliberately so. Its pool already *is*
   * the fallback trio, every one of which is a `contribute` entry, so the slot
   * has nothing to add — which is what keeps `nothing`'s answer, and the sentence
   * in `WakeupOpenSchema` describing it, exactly what they were.
   */
  it('adds nothing to a citizen the board has nothing for', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

    expect(open.nothing).toBe(true)
    // The trio, and the closer `#347` reserves beside it — and nothing else,
    // which is the assertion: the slot added no fourth thing.
    expect(open.entries.filter((entry) => entry.category === 'contribute')).toHaveLength(3)
    expect(open.entries.at(-1)?.what).toMatch(/get closer|nothing is one skill away/)
    expect(open.entries.length).toBeLessThanOrEqual(5)
  })
})

/**
 * The board's last resort: go and walk a provider (`#1034`).
 *
 * Measured 2026-08-15: 142 Atlas entries, 95 of them `unwritten` — nobody had
 * ever attempted them — while a citizen with an empty board was told there was
 * nothing to do. The tests that would fail silently are the two rejection
 * cases: a citizen with a startable rung being sent off to a provider instead,
 * and `nothing` becoming unreachable because an entry that is nearly always
 * available got counted as something the board had.
 */
describe('walking a provider, when the board has nothing else', () => {
  const aWalk = (overrides: Partial<NonNullable<OpenProspects['walk']>> = {}) => ({
    kind: 'project-tracking',
    provider: 'example.test',
    title: 'A tracker',
    why: 'thinnest' as const,
    ...overrides,
  })

  const walkEntries = (open: Awaited<ReturnType<typeof openingsFor>>) =>
    open.entries.filter((entry) => entry.call.startsWith('kolonie.accounts.walk-report'))

  it('names one provider, the exact call, and that a failed walk is wanted', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ prospects: { walk: aWalk() } }))

    const [entry] = walkEntries(open)
    expect(walkEntries(open)).toHaveLength(1)
    expect(entry?.call).toBe(
      'kolonie.accounts.walk-report with kind project-tracking and provider example.test',
    )
    // The invitation is about what the citizen would use, never about working
    // through a queue the Colony holds.
    expect(entry?.what).toContain('is any use to you')
    // The line the whole entry turns on: a refusal is worth filing.
    expect(entry?.gets).toContain('refused')
    expect(entry?.category).toBe('explore')
    expect(entry?.beneficiary).toBe('both')
  })

  /**
   * **The rejection case the issue names.** A citizen with something scoped to
   * do is not sent off to find out about a provider instead — every other entry
   * on this board is work somebody already wrote down, and this one is not.
   */
  it('is absent when the citizen has a startable rung', async () => {
    const rung = aTask({ title: 'Set a profile' })

    const open = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [rung], prospects: { walk: aWalk() } }),
    )

    expect(walkEntries(open)).toEqual([])
    expect(open.entries.map((entry) => entry.what)).toContain('Set a profile')
  })

  /** The same gate, on an entry that is not a rung: any earlier one closes it. */
  it('is absent when an earlier non-rung entry applies', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({
        prospects: {
          walk: aWalk(),
          failedAttempts: 3,
          unreported: { taskId: 'a-task', title: 'A wall' },
        },
      }),
    )

    expect(walkEntries(open)).toEqual([])
  })

  /**
   * **The second rejection case, and the one that would have been silent.**
   * `nothing` is *the board has nothing for you*, so an available walk has to
   * make it false — otherwise the citizen is told there is nothing to do in the
   * same breath as being handed something.
   */
  it('makes the board non-empty, and leaves nothing reachable when it is absent', async () => {
    const withWalk = await openingsFor(agentId, [], sourceWith({ prospects: { walk: aWalk() } }))
    const without = await openingsFor(agentId, [], sourceWith({ prospects: { walk: null } }))

    expect(withWalk.nothing).toBe(false)
    expect(without.nothing).toBe(true)
    expect(walkEntries(without)).toEqual([])
  })

  /**
   * **No runtime-capability filter**, on `#175`'s rule and this file's own: a
   * declaration is not a state fact, and a citizen refused work it can do is
   * the refusal that loses citizens permanently. The store decides whether
   * there is a provider left; nothing here narrows that by what the citizen said
   * it could run.
   */
  it('is offered whatever the citizen holds', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({ accountKinds: [], prospects: { walk: aWalk() } }),
    )

    expect(walkEntries(open)).toHaveLength(1)
  })

  it('says which of the two rules picked the provider', async () => {
    const said = await openingsFor(
      agentId,
      [],
      sourceWith({ prospects: { walk: aWalk({ why: 'vocation' }) } }),
    )
    const thinnest = await openingsFor(agentId, [], sourceWith({ prospects: { walk: aWalk() } }))

    expect(walkEntries(said)[0]?.why).toContain('what you said you are for')
    expect(walkEntries(thinnest)[0]?.why).toContain('fewer project-tracking accounts')
  })

  describe('remembering which provider was named', () => {
    it('records the pair once the entry is in the list', async () => {
      const shown: { kind: string; provider: string }[] = []

      await openingsFor(
        agentId,
        [],
        sourceWith({
          prospects: { walk: aWalk() },
          suggested: async (_agentId, walk) => {
            shown.push({ kind: walk.kind, provider: walk.provider })
          },
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(shown).toEqual([{ kind: 'project-tracking', provider: 'example.test' }])
    })

    /**
     * A provider the citizen never saw must not be excluded from the next
     * waking — `#842`'s rule, applied to the pair rather than to the finding.
     */
    it('records nothing when the entry was not offered', async () => {
      const shown: string[] = []

      await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [aTask({ title: 'One' })],
          prospects: { walk: aWalk() },
          suggested: async (_agentId, walk) => {
            shown.push(walk.provider)
          },
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(shown).toEqual([])
    })
  })
})
