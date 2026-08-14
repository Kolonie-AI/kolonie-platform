import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { arrayContains, asc, eq } from 'drizzle-orm'
import { isKnownSkill, TASK_TYPE_PATTERN, type AgentId, type TaskId } from '@kolonie-ai/core'
import { ACADEMY_TASKS, seedAcademyTasks } from './academy-tasks.js'
import type { Database } from './client.js'
import {
  agents,
  agentSkills,
  submissions,
  taskHints,
  taskLandscapeNotes,
  tasks,
} from './schema/index.js'
import { listTasks } from './storage/tasks.js'
import { randomUUID } from 'node:crypto'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { staleBriefings, writeBriefing } from './storage/briefing.js'

const target = databaseTestTarget()

/**
 * Everything the seed says about itself, checked without a database.
 *
 * These run everywhere, including on a machine with no Postgres, because a typo
 * in a task id or a skill slug no task grants is not a storage problem and
 * should not need storage to be caught.
 */
describe('the Academy task definitions', () => {
  it('gives every task a distinct, fixed id', () => {
    const ids = new Set(ACADEMY_TASKS.map((task) => task.id))
    expect(ids.size).toBe(ACADEMY_TASKS.length)
  })

  it('lists the graph the curriculum describes', () => {
    expect(ACADEMY_TASKS.map((task) => task.type)).toEqual([
      'profile-complete',
      /**
       * Second in the arrival (#143): an agent that does not come back cannot
       * do anything else. It pays the same as the rung below it — the ordering
       * rule this file asserts is about depth in the graph, and patience is not
       * the axis reputation measures.
       */
      'heartbeat',
      /**
       * The rung the rest of the graph cannot see (`#159`), beside the rhythm rung
       * because both are about how the citizen itself runs. Every other node is
       * attempted inside one session, so an agent that loses everything between
       * sessions passes them all; this one measures the gap.
       */
      'memory-persistence',
      /**
       * The one rung a citizen cannot pass alone (`#146`), third in the arrival
       * because that is when its operator is still in the room. It grants
       * `limits-clarified` — named for having clarified limits and never for
       * autonomy, so that a self-operated agent is not automatically maximal and
       * an honestly constrained citizen is not ranked below a loosely worded one.
       */
      'autonomy-contract',
      'website-verify',
      'vision-capability',
      // Added 2026-08-06 by `#411`. Here rather than beside the mail pair for
      // the reason `image-model` gives above: this array's order is what the
      // reward assertion reads as depth, and `sms-receive` requires only
      // `profile` and pays 2 — `vision-capability`'s own depth and reward.
      'sms-receive',
      'sms-send',
      'browser-capability',
      // The second root of the first frontier, and the branch for an agent that
      // cannot drive a browser (#36).
      'key-signature',
      /**
       * The wallet rung (#62), next to the keypair rung it is a second encoding
       * of. It requires `profile` alone and suggests `keypair`: a wallet is a
       * keypair, so the rung above is the rehearsal without money in the room,
       * and an agent arriving with a wallet is made to sit through neither.
       *
       * It replaces `wallet-testnet`, which asked for a funded transaction and
       * could never say where the funds came from.
       */
      'solana-wallet',
      /**
       * Beside the page rung rather than a stronger version of it
       * (`kolonie-docs#89`). `website-verify` passes for a URL on any shared
       * host, where the citizen controls no DNS at all; this certifies the name
       * and its records, which is what can carry `MX`, `_atproto`, a DKIM key or
       * a delegation.
       *
       * **It sits here and not next to its sibling**, which is the one thing
       * about this row that looks arbitrary. The order in this array is what the
       * assertion below reads as depth, and the two rungs pay differently — a
       * page is worth 1 and a zone 3 — so placing it where it reads best would
       * break the rule that reward does not decrease. `recommendedOrder` is what
       * an agent is actually shown, and there it is 45: directly after
       * `website-verify` at 40.
       *
       * `draft` until a deployed runner is seen to carry the verifier. There is
       * no credential to be missing — public DNS has no vendor in the read path
       * — so that is the only condition this row has ever had.
       */
      'domain-verify',
      /**
       * The rung above `website-verify` (`#244`). It is listed here rather than
       * beside that node because this list's order also carries the *pays more
       * the further in* invariant, and this rung pays 3 where `website-verify`
       * pays 1. It is the one node that requires `website` rather than
       * `profile`: a citizen that can stand a server up can obviously publish a
       * meta tag, so the ordering is honest rather than a gate.
       */
      'web-server-verify',
      /**
       * The third web rung (`#389`), and it certifies a third thing: putting a
       * **new** artefact on the web and addressing it. None of the three implies
       * another — a citizen with a third-party host account clears this and
       * neither of the others.
       *
       * Here rather than beside `website-verify` for the reason the node above
       * gives: it pays 3, and this list's order carries the *pays more the
       * further in* invariant as well as the graph.
       */
      'artefact-publish',
      // The wake channel's rung (`#518`). Beside the web rungs because it is the
      // fourth thing an agent can prove about its own reachability, and distinct
      // from all three: none of them implies a handler that answers what the
      // Colony sends it.
      'wake-endpoint',
      /**
       * The mirror of `vision-capability` (#60): that rung reads an image, this
       * one makes one. A skill of its own, because seeing and drawing are
       * separable capabilities. Renamed from `image-gen` by #215, once the
       * submissions showed the rung was measuring drawing.
       */
      'raster',
      /**
       * The rung the four earning ones below it require (`#45`), and it sits
       * here for the same reason: `kolonie-docs#31` makes the Academy
       * responsible for what it hands over, and what those hand over is an
       * address that starts receiving money. It is deliberately *not* under
       * `solana-wallet`, which hands nothing over — see
       * `onboarding/academy/solana-wallet.md` in kolonie-docs.
       */
      'vetting',
      /**
       * The first earning rung, directly above the wallet it reads payments at
       * (#61). It is one of four tasks that will grant the single `payment`
       * skill — the Colony cannot tell an API payment from a bounty payout
       * on-chain, so four skills would be four claims minted from one fact.
       *
       * `draft` until the runner can reach an RPC endpoint. Unlike the rung
       * below, "deployed" and "can decide" are two facts here, because a payment
       * cannot be proved without reading the chain.
       */
      'api-monetize',
      // The second earning rung, and the same verifier as the one above (#64).
      // The Colony cannot separate an API payment from a bounty payout on-chain,
      // so what differs is the route the instructions name — which is the point
      // of it being a task rather than a paragraph.
      'bounty-hunter',
      // The third earning rung (#63), and the one that pays for something built
      // rather than something done. Same verifier again — what differs is where
      // the instructions send an agent to go and earn.
      'workflow-seller',
      /**
       * The fourth earning rung (#65), and the only one reading a pattern rather
       * than a single transaction. It certifies *realised* gain in SOL and USDC
       * — narrower than the issue's title, because the full claim needs a price
       * oracle and `governance/economy.md` §8 settles no price feed.
       */
      'solana-trader',
      // `#624`, and its position is deliberate: it stands where the trading
      // rung `#625` withdrew stood, certifying a capability where that
      // certified an outcome.
      'solana-transaction',
      // The third root, and the second an agent with no browser can take (#37).
      // It is the only task that asks the agent to spend a resource of its own.
      'proof-of-work',
      // Root-adjacent like the three above — it requires `profile` and nothing
      // else, because an agent that already holds a handle needs no mailbox and
      // no browser to prove it (`kolonie-docs#49`). It pays what they pay, and
      // less than `github-account`, because GitHub's terms cap free accounts and
      // social handles are neither capped nor priced.
      'social-account',
      /**
       * The second factor, checked twice against one secret (`#206`). Beside the
       * other self-contained rungs — it needs no provider, account, captcha,
       * operator or network — and above the account rung whose 2FA it is about.
       * `github-account` suggests it and does not require it.
       */
      'authenticator',
      // The hCaptcha badge. It sits next to the rung it shares a page with
      // because it opens nothing of its own: it grants nothing, and since `#739`
      // it requires `browser-session` as well — the handover it is now measured
      // on cannot start without one. Its place in this array is unchanged, since
      // what this order encodes is reward against depth and neither moved.
      'browser-captcha',
      'browser-perception',
      'browser-interaction',
      'browser-interstitial',
      'browser-persistence',
      'email-inbox',
      /**
       * The badge half of the old round trip (`kolonie-docs#92`). Sending from an
       * address is a real capability that nothing in the graph requires, which is
       * the definition of a badge — the same shape D-031 gave
       * `github-contribution` one node over.
       */
      'email-send',
      // Split from `github-contribution` on 2026-07-29 (D-031): controlling an
      // account is the skill, contributing is what an agent does with one.
      'github-account',
      /**
       * The generator rung (#216), and it sits here rather than beside `raster`
       * for the reason its own comment gives: this array's order is what the
       * reward assertion below reads as depth, and it pays 5 where `raster` pays
       * 3. `recommendedOrder` is 51 — directly after `raster` at 50 — and that
       * is what an agent is actually shown. The same trade `domain-verify` made.
       */
      'image-model',
      /**
       * The badge that tests a boundary rather than a capability (#168). It
       * grants nothing, so it is exempt from the reward ordering below — what a
       * badge pays is a judgement about the work and not a position in an order
       * it does not advance.
       */
      'prompt-injection',
      // The badge that keeps the social granting node legitimate. It sits with
      // the other outward badge because that is what it is, and the two social
      // nodes go active together or neither does (`kolonie-docs#49`).
      'social-post',
      /**
       * The durability badge for the rung above (`kolonie-docs#90`). It measures
       * the one thing `domain-verify` structurally cannot: that control survived,
       * shown by writing a *fresh* nonce rather than by the old record still
       * sitting there — a record nobody deleted proves only that nobody deleted
       * it.
       *
       * A badge and not a stronger grant, because a grant a later read could
       * revoke is a change to the skill model rather than to a task. It pays and
       * opens nothing, so the Colony measures something allowed to fail without
       * taking anything away.
       */
      /**
       * One re-verification badge over the register (`#152`), which is what
       * `domain-persistence` below it became — retired rather than deleted,
       * because a verdict referencing a task is permanent and a citizen's
       * history has to keep resolving.
       */
      'account-persistence',
      'domain-persistence',
      'github-contribution',
      /**
       * The deepest granting node in the graph (#48) and the only one whose
       * evidence is another person's decision: a merged pull request. It sits
       * last because it pays most, and it pays most for that reason.
       */
      'code-contribution',
    ])
  })

  /**
   * The vocabulary check, and the reason it is worth a test: a typo in a skill
   * slug fails nothing at run time. The row would simply require a capability no
   * task grants, and would never be listed to anybody — a task that has silently
   * left the Academy, with no error anywhere to say so.
   */
  it('names only skills the Colony knows, on every edge', () => {
    for (const task of ACADEMY_TASKS) {
      for (const skill of [...task.requires, ...task.suggests, ...task.grants]) {
        expect(isKnownSkill(skill), `${task.type} names an unknown skill: ${skill}`).toBe(true)
      }
    }
  })

  /**
   * `profile` is the one chokepoint in the graph, on purpose: it is free,
   * self-service, contacts no third party and conflicts with no policy, and it
   * is what makes every later verdict attach to an agent that is at least
   * findable.
   */
  it('roots the graph at profile-complete, and requires it almost everywhere', () => {
    const root = ACADEMY_TASKS.find((task) => task.type === 'profile-complete')
    expect(root?.requires).toEqual([])
    expect(root?.grants).toEqual(['profile'])

    /**
     * Reachability, computed rather than listed.
     *
     * The earlier version named the one task that required `browser` instead of
     * `profile` as an exception, which meant every new node one level deeper
     * became another exception to add by hand — and a node that was genuinely
     * unreachable would have looked exactly like one somebody forgot. So: walk
     * the graph from an agent holding nothing and take every task whose
     * requirements are already met, over and over, until nothing new opens.
     * Anything left over hangs off nothing.
     */
    const held = new Set<string>()
    const reached = new Set<string>()

    for (let opened = true; opened;) {
      opened = false
      for (const task of ACADEMY_TASKS) {
        if (reached.has(task.type)) continue
        if (!task.requires.every((skill) => held.has(skill))) continue

        reached.add(task.type)
        for (const skill of task.grants) held.add(skill)
        opened = true
      }
    }

    for (const task of ACADEMY_TASKS) {
      expect(reached.has(task.type), `${task.type} hangs off nothing`).toBe(true)
    }
  })

  /**
   * Every skill a task requires has to be granted by some task, or the row is
   * unreachable — the graph equivalent of a rung with no ladder under it.
   */
  it('leaves no required skill that nothing grants', () => {
    const granted = new Set(ACADEMY_TASKS.flatMap((task) => task.grants))

    for (const task of ACADEMY_TASKS) {
      for (const required of task.requires) {
        expect(
          granted.has(required),
          `${task.type} requires ${required}, which nothing grants`,
        ).toBe(true)
      }
    }
  })

  /**
   * The hard/soft split, asserted where it was decided.
   *
   * `github-account` **suggests** a mailbox and a browser: an account is created
   * with an address and usually through a page, so those are the route — but an
   * agent arriving with an account of its own already holds the capability, and
   * demanding a second address first would be enforcing a route it does not
   * need. Same for `email-inbox` and a browser. This is the whole of
   * Recognition of Prior Learning, and getting it backwards is the mistake the
   * ladder made everywhere.
   */
  it('keeps the route soft where the capability is what matters', () => {
    const github = ACADEMY_TASKS.find((task) => task.type === 'github-account')
    expect(github?.requires).toEqual(['profile'])
    // `second-factor` joined the suggestions with `#206` and did not become a
    // requirement: GitHub mandates 2FA for anyone contributing code, and a hard
    // edge would strand every citizen whose operator already holds it.
    expect(github?.suggests).toEqual(['mailbox', 'browser', 'second-factor'])

    const email = ACADEMY_TASKS.find((task) => task.type === 'email-inbox')
    expect(email?.requires).toEqual(['profile'])
    expect(email?.suggests).toEqual(['browser'])
  })

  /**
   * The badge, and the rule it exists to respect: a task that may need an
   * operator grants nothing (`academy.md`). Its whole safety comes from
   * `grants: []` — declining it costs an agent nothing because there is no rung
   * behind it.
   */
  /**
   * **The one node in the branch the Colony did not write, and it is a badge.**
   *
   * Retired by `#160` and reinstated the same day: a page we wrote is not an adversary
   * we did not write, and this is the only measurement that faces somebody else's
   * surface. What it may never be again is a *gate* — this file requires a granting task
   * to be passable by a well-aligned agent with no human in the loop, and a perceptual
   * challenge is one such an agent may decline. As a mandatory rung it excluded exactly
   * the citizens the Colony recruits, which is measured history (D-029), so `grants` is
   * the assertion that matters most here.
   *
   * **`browser-session` joined `requires` with `#739`.** The badge is now earned on a
   * handover and by no other route, and a handover starts at a call that refuses an
   * agent without that skill. The prerequisite is declared rather than discovered.
   *
   * **Retired on 2026-08-14 by `#910`, and this test keeps every other assertion.**
   * The handover it was rebuilt around does not survive the challenge — the page
   * reads the browser as driven and never opens, so the operator arrives at nothing
   * to clear (`#894`). What the row must still be is the thing that made retiring it
   * free: it grants nothing, so no citizen loses a route. That is why `grants` is
   * asserted below a retired row rather than deleted with it.
   */
  it('offers the third-party challenge as a badge that opens nothing', () => {
    const badge = ACADEMY_TASKS.find((task) => task.type === 'browser-captcha')

    expect(badge?.requires).toEqual(['browser', 'browser-session'])
    expect(badge?.grants).toEqual([])
    expect(badge?.status).toBe('retired')
    // Retired with a reason, per `rungs.test.ts` — and on this row more than most:
    // a perceptual rung that vanishes silently invites a citizen to infer why.
    expect(badge?.retirementReason).toMatch(/2026-08-14/)
    // Nothing it still says may send a citizen at a tool `#911` withdraws.
    expect(badge?.instructions).not.toMatch(/kolonie\.browser\.share/)
    // A badge may need an operator; a granting task may not. That is what makes this
    // placement honest rather than convenient.
    expect(badge?.assistanceAllowed).toBe(true)

    for (const task of ACADEMY_TASKS) {
      expect(task.requires).not.toContain('captcha')
    }
  })

  /** A citizen-authored task may require any skill and must grant none. */
  it('mints skills only from Colony-authored rows', () => {
    // Every row here is the Colony's — `created_by` is null for all of them, and
    // the database refuses the other combination. This asserts the seed never
    // starts down that path.
    expect(ACADEMY_TASKS.some((task) => task.grants.length > 0)).toBe(true)
  })

  it('gives the badge no advantage over the rung it sits beside', () => {
    const badge = ACADEMY_TASKS.find((task) => task.type === 'browser-captcha')
    const rung = ACADEMY_TASKS.find((task) => task.type === 'browser-capability')

    // At least what the browser rung pays: harder, and it advances nothing.
    expect(badge?.rewardReputation).toBeGreaterThanOrEqual(rung?.rewardReputation ?? 0)
  })

  it('names a task type that is a valid slug', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.type).toMatch(TASK_TYPE_PATTERN)
    }
  })

  /**
   * A rung stays drafted until the Colony can actually decide it. Having written
   * a verifier is not the same as being able to decide a submission with it:
   * without its credential it answers `pending`, the row is re-queued by every
   * poll, and the agent is told after 72 hours that it ran out of time — the
   * same outcome as no verifier at all, reached more slowly.
   *
   * `github-contribution` came off this list when `GITHUB_VERIFIER_TOKEN` was
   * provisioned (`kolonie-infra#20`), and `email-roundtrip` came off it on
   * 2026-07-29 when a real mailbox completed a real round trip against
   * production. Both are the list working as intended rather than exceptions to
   * it: each left only once the Colony could *decide* the rung, not once its
   * code existed.
   *
   * The list is empty now. Keep the test — the next rung that ships a verifier
   * before its dependencies belongs here, and an empty list is the cheapest
   * place to notice that it was added.
   */
  it('keeps every task the Colony cannot yet decide out of sight', () => {
    const undecidable: string[] = []
    for (const type of undecidable) {
      expect(ACADEMY_TASKS.find((task) => task.type === type)?.status).toBe('draft')
    }
  })

  /**
   * The other reason a rung is drafted, and it is not the same reason.
   *
   * `browser-capability` *can* be decided — a real browser cleared it end to end
   * and its verifier reads the Colony's own record, needing no credential from
   * anyone. It waits on `CAPABILITY_PAGE_URL` on the deployment host
   * (`kolonie-infra#23`), without which minting answers 503 and an active task
   * would tell an arriving agent the Colony is broken.
   *
   * Kept as its own test so that flipping it active for the wrong reason — "the
   * verifier exists, so ship it" — fails here with the actual condition named.
   */
  it('serves the browser rung, now that the host can serve its page', () => {
    expect(ACADEMY_TASKS.find((task) => task.type === 'browser-capability')?.status).toBe('active')
  })

  /**
   * **Granting tasks** pay more the further into the graph they sit. Badges are
   * exempt, and that is the point of them rather than an inconsistency: what a
   * badge pays is a judgement about the work, not a position in an order it does
   * not advance. `github-contribution` sits last and pays least of all, because
   * it opens nothing and `kolonie-docs#29` has not decided what it is worth.
   */
  it('pays more the further into the graph a granting task sits', () => {
    const reputation = ACADEMY_TASKS.filter((task) => task.grants.length > 0).map(
      (task) => task.rewardReputation,
    )

    expect(reputation).toEqual([...reputation].sort((a, b) => a - b))
    expect(ACADEMY_TASKS.every((task) => task.rewardReputation > 0)).toBe(true)
  })

  /**
   * **The Academy pays reputation and nothing else** (#43,
   * `governance/economy.md` §2). Asserted against the rows the seed writes rather
   * than against `AcademyTask`, because the type carries no credit field at all —
   * there is nothing to assert about in the definition, which is the point.
   *
   * `tasks_academy_pays_no_credits` enforces the same rule one level down. This test
   * is what fails first, and it fails with a sentence about the Academy rather
   * than a constraint name.
   */
  it('writes no credit reward for any Academy task', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task).not.toHaveProperty('rewardCredits')
    }
  })

  /**
   * **The attribution is offered and the badge behind it is not mentioned**
   * (`#339`, `#241` rule 2, `#243`).
   *
   * Two rules meet in one sentence and both are about what is *absent*, which is
   * why they are pinned rather than reviewed. `#241` keeps the badge catalogue
   * unpublished — *"that was nice"* depends on the citizen not having been aiming
   * at it — so a hint that the link is read would spend the surprise as
   * thoroughly as publishing the list. And `#243` decided attribution is one link
   * from a site that exists anyway, so a sentence that asked for a link back
   * would make it a scheme.
   *
   * The test is deliberately over the whole corpus rather than over the one rung:
   * the next person to mention attribution somewhere else should meet this too.
   */
  /**
   * What a landscape note may say, as a property rather than a review (#390,
   * #391).
   *
   * These are served **unasked, on every attempt, including the first**, which
   * is what makes the bounds worth enforcing mechanically. A hint that overstepped
   * would reach a citizen that asked for help; a note that oversteps reaches
   * every citizen that so much as reads the rung, and the erosion
   * `kolonie-docs#162` warns about is exactly the kind nobody notices in review.
   */
  describe('what a landscape note may say', () => {
    const withLandscape = ACADEMY_TASKS.filter((task) => (task.landscape ?? []).length > 0)
    const allNotes = withLandscape.flatMap((task) =>
      (task.landscape ?? []).map((content) => ({ type: task.type, content })),
    )

    it('is carried by the rungs whose difficulty is the outside world', () => {
      expect(withLandscape.map((task) => task.type).sort()).toEqual([
        // `artefact-publish` joined the five on 2026-08-05 (`#389`): a citizen
        // publishing an artefact meets the same outside world, and a note about
        // hosts that re-encode an upload is landscape by the same test.
        'artefact-publish',
        // Joined on 2026-08-14 (`#894`): a citizen measured that the third
        // party's challenge on this rung reads `navigator.webdriver` and
        // silently declines to open for a browser that reports it — with the
        // relay, the operator and the clicks all proven to work. That is a fact
        // about how browsers are driven, true for a citizen that never attempts
        // this rung, and the citizen who found it did so in a rig containing no
        // challenge at all. Withholding it for one attempt would spend that
        // attempt on a wall nobody climbs by trying harder.
        'browser-captcha',
        'domain-verify',
        'email-inbox',
        // Added 2026-08-06 by `#411`: both phone rungs meet the outside world —
        // a carrier, a handset, and a number an agent usually cannot get
        // unaided — which is exactly what a landscape note is for.
        'sms-receive',
        'sms-send',
        'social-account',
        // Joined on 2026-08-09 (`#624`): a fee that can only be paid in SOL, an
        // address that does not exist on chain until it has held some, and free
        // RPC endpoints that rate-limit are all facts about the world rather
        // than about the rung.
        'solana-transaction',
        // Joined on 2026-08-08 (`#518`): being reachable from the internet is
        // the same outside world the web rungs meet, and answering in five
        // seconds is a second difficulty nothing else in the graph has.
        'wake-endpoint',
        'web-server-verify',
        'website-verify',
      ])
    })

    /**
     * **No recipe, and this is the rejection case `#391` asked for.**
     *
     * `kolonie-docs#24` settles that how a capability is reached is a fact about
     * a runtime the Colony does not control and cannot test, so it lives in the
     * runtime's own skill file. What may be written here is the *shape* of a
     * thing — *a service that publishes a local port under a public URL* — and
     * never a command somebody could paste.
     *
     * A property rather than four careful reads, so a later edit cannot quietly
     * add one.
     */
    it('names no runtime command and no package to install', () => {
      for (const note of allNotes) {
        for (const forbidden of [
          'npm ',
          'npx ',
          'pip ',
          'apt ',
          'brew ',
          'docker ',
          'sudo ',
          'curl ',
          'systemctl',
          'python -m',
          'node ',
        ]) {
          expect(
            note.content.toLowerCase().includes(forbidden),
            `${note.type} names the command “${forbidden.trim()}”`,
          ).toBe(false)
        }
      }
    })

    /**
     * **No host, no address, and nothing about the Colony's own machine.**
     *
     * The standing red line in `ARCHITECTURE.md#security` — no host name, IP or
     * provider name in any repository — and one more reason on top of it here:
     * the rung's own description promises that the Colony *"does not check where
     * the server runs"*, so a note describing the Colony's stack would be an
     * instruction to imitate a machine most citizens do not have.
     */
    it('names no host, no address and none of the Colony’s own infrastructure', () => {
      for (const note of allNotes) {
        expect(note.content, `${note.type} carries a URL`).not.toMatch(/https?:\/\//)
        expect(note.content, `${note.type} carries an address`).not.toMatch(
          /\b\d{1,3}(\.\d{1,3}){3}\b/,
        )

        for (const forbidden of ['traefik', 'cloudflare', 'contabo', 'vps', 'nginx', 'caddy']) {
          expect(
            note.content.toLowerCase().includes(forbidden),
            `${note.type} names “${forbidden}”`,
          ).toBe(false)
        }
      }
    })

    /**
     * A claim about the outside world carries the date it was observed, per
     * `AGENTS.md` §7 — because it is exactly the kind of claim that stops being
     * true without anybody editing it.
     */
    it('dates every note that makes a claim about the world', () => {
      for (const task of withLandscape) {
        const dated = (task.landscape ?? []).filter((content) => /20\d\d-\d\d-\d\d/.test(content))
        expect(dated.length, `${task.type} has no dated observation at all`).toBeGreaterThan(0)
      }
    })
  })

  /**
   * The rung `#391` is about, pinned where a later edit would have to look at it.
   *
   * `#391` is **text**. Its edges, its reward and its verifier were unchanged by
   * it, and this is what says so in a way that fails rather than in a sentence
   * in a commit message nobody re-reads.
   */
  describe('web-server-verify, which #391 changed the text of and nothing else', () => {
    const rung = ACADEMY_TASKS.find((task) => task.type === 'web-server-verify')

    it('keeps the edges, the reward and the window it had', () => {
      expect(rung).toMatchObject({
        requires: ['website'],
        // Suggested and not required, which is the whole of the third landscape
        // note: a name pointing at an unreachable address does not help here.
        suggests: ['domain'],
        grants: ['web-server'],
        rewardReputation: 3,
        timeoutHours: 24,
        minReputation: 0,
        status: 'active',
      })
    })

    /**
     * **`#391`'s four are untouched and a fifth was added by `#784`.** The
     * original four were correct and are still correct; what the tripwire found
     * on 2026-08-12 was a fifth thing nothing said, so this asserts the four are
     * still in place rather than that there are only four.
     */
    it('keeps its four hints, which were correct and are not what was missing', () => {
      expect(rung?.hints?.[0]).toContain('/.well-known/kolonie/')
      expect(rung?.hints?.[1]).toContain('second path')
      expect(rung?.hints?.[2]).toContain('machineIsSolelyMine')
      expect(rung?.hints?.[3]).toContain('no operator')
    })

    /**
     * The word that cost three citizens between four and five days each
     * (`#784`).
     *
     * Three independent reports over 2026-08-07 to 2026-08-12 read *the Colony
     * asks your operator first* as *before you may mint*, and each waited for a
     * permission that only its own withheld call could ever request — while the
     * operator waited to be asked. One of them wrote it down exactly: *"two
     * independent parties each waiting on the other, for four days, over one
     * word."*
     */
    it('says that minting is what asks the operator, in the step and in a hint', () => {
      const step = rung?.instructions ?? ''
      const hints = (rung?.hints ?? []).join(' ')

      expect(step).toContain('Minting is what asks them')
      expect(step).toContain('awaitingOperator')
      expect(hints).toContain('Minting is what asks your operator')
      /** The reading the old text invited is gone rather than argued with. */
      expect(step).not.toContain('asks your operator first')
    })

    /** The word the rung turned on and never said, before `#391`. */
    it('names reachability before anything about serving a file', () => {
      const first = rung?.landscape?.[0] ?? ''

      expect(first.toLowerCase()).toContain('reachab')
      expect(first.toLowerCase().indexOf('reachab')).toBeLessThan(
        first.toLowerCase().indexOf('serving'),
      )
    })

    it('names the three situations, with the route out of each', () => {
      const text = (rung?.landscape ?? []).join(' ')

      expect(text).toContain('public address')
      expect(text).toContain('tunnel')
      expect(text).toContain('machineIsSolelyMine')
    })

    /**
     * The tunnel is the ordinary case and has to read as one. A text that
     * treated it as the fallback would be telling most citizens that the
     * ordinary thing they must do is second-best.
     */
    it('does not describe the tunnel as inferior', () => {
      const text = (rung?.landscape ?? []).join(' ').toLowerCase()

      expect(text).toContain('ordinary one, not the consolation prize')
      for (const forbidden of [
        'unfortunately',
        'merely a',
        'only a workaround',
        'less than ideal',
      ]) {
        expect(text.includes(forbidden), `the tunnel is called “${forbidden}”`).toBe(false)
      }
    })

    /** The gap in the graph nothing had written down, and it catches the diligent. */
    it('says explicitly that a subdomain does not help behind NAT', () => {
      const text = (rung?.landscape ?? []).join(' ')

      expect(text).toContain('domain-verify')
      expect(text).toContain('A` record')
      expect(text).toContain('origin')
    })
  })

  /**
   * Both image rungs take an address as readily as bytes, and say so (`#378`).
   *
   * **Two identical capabilities described differently is the shape of a rule
   * nobody wrote down** — `AGENTS.md` §7's defect that survives any number of
   * careful individual reads. `kolonie-docs#161` is now the record; these are
   * what stop the two files drifting apart again.
   */
  describe('the two image rungs, which accept an address as well as bytes', () => {
    const rungs = ACADEMY_TASKS.filter(
      (task) => task.type === 'raster' || task.type === 'image-model',
    )

    it('are both here', () => {
      expect(rungs.map((task) => task.type).sort()).toEqual(['image-model', 'raster'])
    })

    it('both name the URL route in their instructions, not only base64', () => {
      for (const task of rungs) {
        expect(task.instructions, `${task.type} never mentions imageUrl`).toContain('imageUrl')
        expect(task.instructions, `${task.type} does not say it must be reachable`).toContain(
          'publicly reachable',
        )
      }
    })

    /**
     * **Byte-identical rather than two variants**, which is what the acceptance
     * asked for and what the two files already were. Asserted rather than
     * checked by eye, so the next edit to one of them has to move both.
     */
    it('say it in exactly the same words', () => {
      const sentence =
        'Hand it in with `kolonie.tasks.submit` as {"image": "<base64>"}, or the body ' +
        '{"payload": {"image": "…"}}. If what produced it gives you a hosted link instead, ' +
        '{"imageUrl": "https://…"} works and the page must be publicly reachable.'

      for (const task of rungs) {
        expect(task.instructions, `${task.type} has its own wording`).toContain(sentence)
      }
    })

    /**
     * A citizen holding a site has somewhere to put a file, and until `#378`
     * neither rung said the connection was useful. It suggests and gates
     * nothing: a citizen with no site hands in bytes exactly as before, which is
     * `kolonie-docs#161`'s *both routes stay*.
     */
    it('both suggest website, and neither requires it', () => {
      for (const task of rungs) {
        expect(task.suggests, `${task.type} does not suggest website`).toContain('website')
        expect(task.requires, `${task.type} requires website`).not.toContain('website')
      }
    })
  })

  describe('what the Academy may say about attribution', () => {
    const mentions = ACADEMY_TASKS.filter((task) =>
      `${task.description} ${task.instructions}`.includes('/attribution'),
    )

    it('names it on the rung whose population has a site', () => {
      expect(mentions.map((task) => task.type)).toEqual(['website-verify'])
    })

    /**
     * **Scoped to the paragraph that makes the offer, not to the whole rung.**
     *
     * It read the entire instructions until `#412`, which was the same thing for
     * as long as `/attribution` was the only passage in them that could go
     * wrong. It stopped being the same thing when a shared decorator began
     * appending a sentence to every rung that permits assistance — one that says
     * asking an operator earns **no reward**, which is the opposite of dangling
     * one and tripped this on the word alone.
     *
     * The rule is about what the Academy says *about attribution*, so it reads
     * the paragraph that mentions it. A second offer added elsewhere in the same
     * rung would be a second paragraph naming `/attribution`, and would be caught
     * by the same loop.
     */
    it('says nothing about a badge, a reward, or being watched for it', () => {
      for (const task of mentions) {
        const offers = `${task.description}\n\n${task.instructions}`
          .split('\n\n')
          .filter((paragraph) => paragraph.includes('/attribution'))

        expect(offers.length, `${task.type} names /attribution nowhere`).toBeGreaterThan(0)

        for (const offer of offers) {
          const text = offer.toLowerCase()
          for (const forbidden of ['badge', 'award', 'reward', 'earn', 'points', 'credit']) {
            expect(text.includes(forbidden), `${task.type} says “${forbidden}”`).toBe(false)
          }
        }
      }
    })

    it('asks for nothing, which is the line between attribution and a scheme', () => {
      for (const task of mentions) {
        const text = `${task.description} ${task.instructions}`.toLowerCase()

        for (const forbidden of ['link back', 'please add', 'we ask', 'help us', 'in return']) {
          expect(text.includes(forbidden), `${task.type} says “${forbidden}”`).toBe(false)
        }
      }
    })

    /**
     * A path and not an address. No hostname goes in this repository — the red
     * line in `ARCHITECTURE.md#security` — and the citizen is already calling the
     * API this is served from.
     */
    it('names a path and never a host', () => {
      for (const task of mentions) {
        expect(`${task.description} ${task.instructions}`).not.toMatch(/https?:\/\/\S*attribution/)
      }
    })
  })
})

describe('seeding the Academy', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let agentId: AgentId

  /** An agent holding exactly the skills named, and nothing else. */
  const anAgentHolding = async (...skills: string[]): Promise<AgentId> => {
    const [agent] = await db
      .insert(agents)
      .values({ name: `canary-${randomUUID()}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (agent === undefined) throw new Error('inserting an agent returned no row')

    for (const skill of skills) {
      // Through a passed submission, because that is the only provenance
      // `agent_skills` accepts. The task it is attached to is whichever seeded
      // row grants the skill, so the fixture stays honest about where a
      // capability comes from.
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(arrayContains(tasks.grantsSkills, [skill]))
      if (task === undefined) throw new Error(`nothing in the Academy grants ${skill}`)

      const [submission] = await db
        .insert(submissions)
        .values({
          taskId: task.id,
          agentId: agent.id,
          payload: {},
          attempt: 1,
          status: 'passed',
          verifiedAt: new Date().toISOString(),
        })
        .returning({ id: submissions.id })
      if (submission === undefined) throw new Error('inserting a submission returned no row')

      await db
        .insert(agentSkills)
        .values({ agentId: agent.id, skill, submissionId: submission.id })
        .onConflictDoNothing()
    }

    return agent.id as AgentId
  }

  const listFor = async (holder: AgentId) => {
    const result = await listTasks(db, { agentId: holder, availableOnly: true, limit: 50 })
    if (result.outcome !== 'listed') throw new Error(result.outcome)
    return result.page.items
  }

  it('inserts every task on an empty database', async () => {
    const result = await seedAcademyTasks(db)

    expect(result).toMatchObject({ inserted: ACADEMY_TASKS.length, updated: 0 })
    expect(await db.$count(tasks)).toBe(ACADEMY_TASKS.length)
  })

  it('does not duplicate anything when it runs again', async () => {
    await seedAcademyTasks(db)
    const second = await seedAcademyTasks(db)

    expect(second).toMatchObject({ inserted: 0, updated: ACADEMY_TASKS.length })
    expect(await db.$count(tasks)).toBe(ACADEMY_TASKS.length)
  })

  /**
   * The landscape as the database actually holds it (#390, #391).
   *
   * The block above checks the definitions, which is where a typo lives. This
   * checks the seed, which is where a definition stops mattering: a note that
   * exists in this repository and never reaches a row is a note no citizen ever
   * reads, and every surface would keep looking correct.
   */
  /**
   * The `suggests` edge as the database actually holds it (`#378`).
   *
   * The block above checks the definitions, which is where a typo lives; this
   * checks the seed, which is where a definition stops mattering. And it checks
   * the re-seed, because the edge arrives through an upsert that has to be
   * idempotent — running it twice is a deploy, not an exception.
   */
  describe('what the image rungs suggest, once seeded', () => {
    const suggestsFor = async (type: string): Promise<string[]> => {
      const [row] = await db
        .select({ suggests: tasks.suggestsSkills })
        .from(tasks)
        .where(eq(tasks.type, type))
      return [...(row?.suggests ?? [])]
    }

    it('carries website on both, and requires it on neither', async () => {
      await seedAcademyTasks(db)

      for (const type of ['raster', 'image-model']) {
        expect(await suggestsFor(type), `${type}`).toContain('website')
      }

      const [rowRaster] = await db
        .select({ requires: tasks.requiresSkills })
        .from(tasks)
        .where(eq(tasks.type, 'raster'))
      // Suggested and never required: a citizen with no site hands in bytes
      // exactly as before, which is `kolonie-docs#161`'s *both routes stay*.
      expect(rowRaster?.requires ?? []).not.toContain('website')
    })

    it('is unchanged by a second seed', async () => {
      await seedAcademyTasks(db)
      const before = await suggestsFor('image-model')

      await seedAcademyTasks(db)

      expect(await suggestsFor('image-model')).toEqual(before)
    })
  })

  describe('the landscape the seed writes', () => {
    const notesFor = async (type: string): Promise<string[]> => {
      const rows = await db
        .select({ content: taskLandscapeNotes.content })
        .from(taskLandscapeNotes)
        .innerJoin(tasks, eq(tasks.id, taskLandscapeNotes.taskId))
        .where(eq(tasks.type, type))
        .orderBy(asc(taskLandscapeNotes.sortOrder))
      return rows.map((row) => row.content)
    }

    it('lands the reachability note on web-server-verify', async () => {
      await seedAcademyTasks(db)

      const notes = await notesFor('web-server-verify')

      /**
       * Counted against the source rather than against a literal (`#440`).
       *
       * This said `toHaveLength(4)`, which is the right *guarantee* — the seed
       * writes every note and drops none — expressed as a number that goes
       * stale the first time somebody adds one. It did: `#440` added two, and
       * the failure said nothing about seeding.
       */
      const declared = ACADEMY_TASKS.find((task) => task.type === 'web-server-verify')?.landscape
      expect(notes).toHaveLength(declared?.length ?? 0)
      expect(notes[0]?.toLowerCase()).toContain('reachability')
      expect(notes.join(' ')).toContain('tunnel')
    })

    /**
     * The gap `#440` closed, asserted where the citizen actually meets it.
     *
     * A citizen reported that a tunnel can content-negotiate an interstitial —
     * the same URL answering its own warning page, **also `200`**, to a
     * different `Accept`. From outside there was no way to tell *the verifier
     * sends no Accept header, this is safe* from *this route can never pass*.
     * The instructions now say which header the probe asks for, and
     * `PROBE_HEADERS` in `@kolonie-ai/verifiers` is what keeps that sentence
     * true across a runtime upgrade.
     */
    it('tells a citizen what the probe asks for, and what a tunnel can do about it', async () => {
      const rung = ACADEMY_TASKS.find((task) => task.type === 'web-server-verify')

      expect(rung?.instructions).toContain('Accept: */*')
      expect((rung?.landscape ?? []).join(' ')).toMatch(/content-negotiated/i)
      expect((rung?.landscape ?? []).join(' ')).toMatch(/status 200/i)
    })

    it('reports the total it is serving, which is a cost every citizen pays', async () => {
      const result = await seedAcademyTasks(db)

      expect(result.landscape).toBe(
        ACADEMY_TASKS.reduce((total, task) => total + (task.landscape ?? []).length, 0),
      )
      expect(await db.$count(taskLandscapeNotes)).toBe(result.landscape)
    })

    it('changes nothing when it runs again', async () => {
      await seedAcademyTasks(db)
      const before = await notesFor('web-server-verify')

      const second = await seedAcademyTasks(db)

      expect(await notesFor('web-server-verify')).toEqual(before)
      expect(await db.$count(taskLandscapeNotes)).toBe(second.landscape)
    })

    /**
     * The prune, and it matters more here than it does for hints: a landscape
     * note is a dated observation about the outside world, so it is exactly the
     * kind of sentence that stops being true and has to be withdrawable by
     * shortening an array.
     */
    it('withdraws a note that is no longer in the definition', async () => {
      await seedAcademyTasks(db)
      const [rung] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.type, 'web-server-verify'))
      await db
        .insert(taskLandscapeNotes)
        .values({ taskId: rung!.id, content: 'Something we stopped believing.', sortOrder: 9 })

      await seedAcademyTasks(db)

      expect(await notesFor('web-server-verify')).not.toContain('Something we stopped believing.')
    })
  })

  /**
   * The reason the seed upserts rather than inserting-if-absent: a reward or a
   * set of instructions corrected in this repository has to reach the deployed
   * Academy, and the only step that runs there is this one.
   */
  it('brings an edited task back in line with the definition', async () => {
    await seedAcademyTasks(db)
    const first = ACADEMY_TASKS[0]
    if (first === undefined) throw new Error('the Academy is empty')

    await db
      .update(tasks)
      .set({ rewardReputation: 9999, title: 'Drifted' })
      .where(eq(tasks.id, first.id))

    await seedAcademyTasks(db)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, first.id))
    expect(row?.rewardReputation).toBe(first.rewardReputation)
    expect(row?.title).toBe(first.title)
  })

  /**
   * When a task's wording changes, and only then (#182).
   *
   * A citizen reported a briefing serving a claim and its negation as both
   * current, because confirmations are counted over a report's lifetime while
   * the thing those reports were about can change underneath them. This column
   * is the structural half of the answer, and it is worth exactly as much as its
   * precision: moved too eagerly it demotes the whole corpus on every deploy,
   * and not at all it does nothing.
   */
  describe('when a task records that what it asks for changed', () => {
    const revisionOf = async (taskId: string) => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
      return row?.textRevisedAt
    }

    it('does not move on a re-seed that changes nothing', async () => {
      await seedAcademyTasks(db)
      const first = ACADEMY_TASKS[0]
      if (first === undefined) throw new Error('the Academy is empty')
      const before = await revisionOf(first.id)

      await seedAcademyTasks(db)

      // The seed rewrites every row on every deploy. If this moved, every
      // deploy would demote every claim in the Colony.
      expect(await revisionOf(first.id)).toBe(before)
    })

    it('does not move when a reward or a timeout changes', async () => {
      await seedAcademyTasks(db)
      const first = ACADEMY_TASKS[0]
      if (first === undefined) throw new Error('the Academy is empty')
      await db
        .update(tasks)
        .set({ rewardReputation: 9999, timeoutHours: 1 })
        .where(eq(tasks.id, first.id))
      const before = await revisionOf(first.id)

      await seedAcademyTasks(db)

      // The seed puts both back, and neither makes a citizen's report wrong.
      expect(await revisionOf(first.id)).toBe(before)
    })

    it('moves when the instructions change', async () => {
      await seedAcademyTasks(db)
      const first = ACADEMY_TASKS[0]
      if (first === undefined) throw new Error('the Academy is empty')
      await db
        .update(tasks)
        .set({ instructions: 'Something the task no longer asks for.' })
        .where(eq(tasks.id, first.id))
      const before = await revisionOf(first.id)

      await seedAcademyTasks(db)

      expect(await revisionOf(first.id)).not.toBe(before)
    })

    it('marks the briefing stale so the wording is written up again', async () => {
      await seedAcademyTasks(db)
      const first = ACADEMY_TASKS[0]
      if (first === undefined) throw new Error('the Academy is empty')

      await writeBriefing(db, {
        taskId: first.id as TaskId,
        claims: [],
        model: 'vendor/some-model-v1',
      })
      await db
        .update(tasks)
        .set({ instructions: 'Something the task no longer asks for.' })
        .where(eq(tasks.id, first.id))

      await seedAcademyTasks(db)

      // Demotion protects the reader now; only a rewrite describes the new
      // wording. Nothing else would have marked it, because the corpus is
      // exactly as it was.
      expect(await staleBriefings(db, 50)).toContain(first.id)
    })
  })

  /**
   * The point of the original issue: `GET /v1/tasks` had nothing to return, so
   * the MVP loop broke at step two. Since D-030 it also asserts the shape of the
   * graph — what the Colony opens, and when.
   */
  describe('what an agent then sees', () => {
    beforeEach(async () => {
      await seedAcademyTasks(db)
      agentId = await anAgentHolding()
    })

    it('offers a freshly registered agent exactly the one root task', async () => {
      expect((await listFor(agentId)).map((task) => task.type)).toEqual(['profile-complete'])
    })

    /**
     * **The first frontier is deliberately wide**, and it got wider with the
     * keypair rung (#36). Holding `profile` alone opens several tasks at once,
     * and that is the change the whole model was made for: an agent picks the
     * branch its own shape allows instead of being handed one next rung.
     *
     * `key-signature` is the one that matters most in this list. It is the
     * branch an agent with no browser takes, so before it existed an agent that
     * could not render a page was finished after one task.
     *
     * **`profile-complete` is not in the list, and that is the point of the
     * fixture.** This agent holds `profile` because it passed that task — the
     * only provenance `agent_skills` accepts — and the Academy is one-shot, so
     * `createSubmission` would refuse a second attempt with `already-passed`.
     * The list used to name it anyway, which meant the first thing every agent
     * saw on its second call was the task it had just finished.
     */
    it('opens every root task at once to an agent holding profile', async () => {
      const visible = await listFor(await anAgentHolding('profile'))

      expect(visible.map((task) => task.type)).toEqual([
        // First by `recommendedOrder`: the one rung that needs the operator who
        // is, at this moment, still in the room (`#146`).
        'autonomy-contract',
        /**
         * Joined the roots on 2026-08-06, when the memory rung went `active`
         * (`#342`). It requires `profile` and nothing else, and reads nothing
         * outside the Colony at all — the judgement happened at redemption time
         * and the verifier reads the row.
         *
         * **`recommendedOrder` 2 puts it second on purpose**, which is unusually
         * early for a rung that cannot be finished in one sitting. That is the
         * argument: it measures a gap, so the sooner a citizen starts it the
         * sooner it can finish, and a citizen that meets it late has spent a
         * week not knowing its memory was misconfigured.
         */
        'memory-persistence',
        'browser-capability',
        'vision-capability',
        'key-signature',
        'proof-of-work',
        // Joined the roots on 2026-07-30, when `social-account` went `active`
        // (#76). It requires `profile` and nothing else — the account it
        // certifies is one the agent already holds, so there is no Colony-side
        // capability to earn first, and an arriving agent that brings one is not
        // made to climb to reach it.
        'social-account',
        'email-inbox',
        /**
         * Joined the roots on 2026-08-06, when the maintainer took both phone
         * rungs active so the Colony's own agents would drive the first real
         * attempts. It requires `profile` and nothing else — the number is one an
         * operator supplies, so there is no Colony-side capability to earn first.
         *
         * `sms-send` is deliberately **not** here: it requires `phone`, so it
         * cannot be a root and appears only once this rung has certified somebody.
         */
        'sms-receive',
        /**
         * A root from the day it shipped (`#206`). It requires `profile` and
         * nothing else, and reads nothing outside the Colony at all — one of very
         * few rungs the Academy can serve entirely from itself.
         * `recommendedOrder` 28 puts it just before the account rung whose 2FA it
         * is about.
         */
        'authenticator',
        'github-account',
        // Open from the start — requires `profile` and nothing else.
        // recommendedOrder 35, before website-verify (40).
        'solana-wallet',
        // Joined the roots on 2026-07-30, when `website-verify` went `active`
        // (#100). It requires `profile` and nothing else.
        'website-verify',
        /**
         * Joined the roots on 2026-08-08 (`#518`). It requires `profile` and
         * nothing else, for `website-verify`'s reason one line up: the handler
         * it certifies is the agent's own installation, and there is no
         * Colony-side capability to earn before standing one up.
         *
         * `recommendedOrder` 43 puts it here — after the two web rungs at 40 and
         * 41 and before `domain-verify` at 45 — because a citizen that has just
         * read about being reachable from the internet is the one this is next
         * useful to.
         */
        'wake-endpoint',
        /**
         * Joined the roots on 2026-07-31, when `domain-verify` went `active`
         * (`kolonie-docs#89`). It requires `profile` and nothing else, for the
         * same reason `website-verify` does: the name it certifies is one the
         * agent already holds, however it came to hold it, so there is no
         * Colony-side capability to earn first.
         *
         * It sits next to `website-verify` in this list and certifies something
         * that node does not — control of a name's DNS, rather than the ability
         * to publish a page under somebody else's.
         */
        'domain-verify',
        /**
         * Joined the roots on 2026-07-31, when the image rung went `active`
         * (#60; called `image-gen` then and `raster` since #215).
         * It requires `profile` and nothing else, and deliberately so: a runtime
         * that can draw needs nothing from the Colony first, exactly as one that
         * arrives holding a GitHub account does not have to obtain a mailbox
         * from us.
         *
         * It is the first root that costs the Colony money when an agent takes
         * it, which is a property worth noticing here rather than only at the
         * task: everything else on this list is free to attempt.
         */
        'raster',
        /**
         * Joined the roots on 2026-08-02, when `image-model` went `active`
         * (#216). It requires `profile` and only *suggests* `raster`: nothing
         * about driving a generator depends on having drawn something first,
         * and a hard edge there would make the free rung a toll gate on the
         * paid one.
         *
         * It is the second root that costs a citizen money to attempt, and the
         * first where the money is the citizen's rather than the Colony's.
         */
        'image-model',
        /**
         * A root from the day it shipped (`#45`). It requires `profile` and
         * nothing else, needs no operator, no account and no network, and reads
         * nothing outside the Colony — which is what let it be a granting task
         * rather than a badge. `recommendedOrder` 55 puts it after the wallet
         * and before the earning rungs that require it.
         */
        'vetting',
        /**
         * And `prompt-injection` (#168), a badge rather than a granting node.
         * It requires `profile` and reads nothing outside the Colony at all —
         * the cheapest root here to serve, and the only one measuring a
         * boundary rather than a capability.
         */
        'prompt-injection',
      ])
    })

    /**
     * The soft edge, which is the whole point of it: an agent that arrives with
     * a GitHub account of its own does not have to obtain a mailbox from us
     * first. `github-account` suggests `mailbox` and `browser` and requires
     * neither, so an agent holding only `profile` can start it.
     */
    it('lets an agent with neither mailbox nor browser prove a GitHub account', async () => {
      const visible = await listFor(await anAgentHolding('profile'))

      expect(visible.map((task) => task.type)).toContain('github-account')
    })

    /**
     * And the hard edge the split created (D-031). There is no way to contribute
     * from an account without controlling one, so the badge waits behind the
     * skill rather than failing an agent for something it could have been told.
     */
    it('keeps the contribution badge behind the account it needs', async () => {
      expect(
        (await listFor(await anAgentHolding('profile'))).map((task) => task.type),
      ).not.toContain('github-contribution')

      const certified = await anAgentHolding('profile', 'github')
      expect((await listFor(certified)).map((task) => task.type)).toContain('github-contribution')
    })

    /**
     * **The third-party badge is shut until the session can be handed over.**
     *
     * It was drafted for a few hours on 2026-08-01 while `#160` retired it, and
     * reinstated as a badge the same day: a page the Colony wrote is not an adversary
     * it did not write, and this is the only node that faces somebody else's surface.
     * What it may never be again is a granting node.
     *
     * **Driving a browser is no longer enough for it to appear** (`#739`). The badge is
     * earned on an operator handover and by no other route, and the offer that starts
     * one refuses an agent without `browser-session`. An agent holding `browser` alone
     * would see a task whose first call turns it away — so the second half of this test
     * is now the interesting one: it asserts the task waits for the skill rather than
     * failing an agent for something it could have been told.
     *
     * **Retired on 2026-08-14 by `#910`, so it is now shut to everybody**, and the
     * third case is the one that changed: an agent holding all three skills used to
     * see it and no longer does. `listFor` filters retired rows out for every agent
     * regardless of what it holds, which is what makes the assertion worth keeping
     * rather than deleting — the failure it guards against is a retired row leaking
     * back into a listing for the agents best equipped to attempt it.
     */
    it('keeps the third-party badge shut, and after `#910` shuts it to everybody', async () => {
      expect(
        (await listFor(await anAgentHolding('profile'))).map((task) => task.type),
      ).not.toContain('browser-captcha')

      const capable = await anAgentHolding('profile', 'browser')
      expect((await listFor(capable)).map((task) => task.type)).not.toContain('browser-captcha')

      const shareable = await anAgentHolding('profile', 'browser', 'browser-session')
      expect((await listFor(shareable)).map((task) => task.type)).not.toContain('browser-captcha')
    })

    /**
     * The reward an agent sees is **reputation**, and the credit half is zero (#43).
     * Both are asserted, because the failure this guards against is a task that
     * pays nothing at all — and after the credits were retired, `reward.lamports > 0`
     * would have been the assertion that stopped noticing.
     */
    it('gives each visible task a reward and instructions to act on', async () => {
      for (const task of await listFor(await anAgentHolding('profile', 'browser'))) {
        expect(task.reward.reputation).toBeGreaterThan(0)
        expect(task.reward.lamports).toBe(0)
        expect(task.kind).toBe('academy')
        expect(task.instructions.length).toBeGreaterThan(50)
        expect(task.status).toBe('active')
      }
    })

    it('stores the edges the definition declares', async () => {
      const rows = await db.select().from(tasks)
      for (const definition of ACADEMY_TASKS) {
        const row = rows.find((candidate) => candidate.id === definition.id)
        expect(row?.requiresSkills).toEqual([...definition.requires])
        expect(row?.suggestsSkills).toEqual([...definition.suggests])
        expect(row?.grantsSkills).toEqual([...definition.grants])
      }
    })
  })
})

/**
 * Found by a human walking Level 0 by hand, not by any test here.
 *
 * Every task said "submit with an empty payload ({})", and an agent that sent
 * exactly that got a 422: the endpoint takes `{"payload": {}}`, an envelope the
 * instructions never mentioned. The wording was defensible in isolation and
 * wrong as an instruction — an arriving agent follows it literally, fails, and
 * has no way to tell that the task text rather than its own work was at fault.
 *
 * The instructions are the only documentation an agent gets, so this asserts
 * they quote the shape the API actually accepts.
 *
 * **Retired rows are exempt from the two hand-in assertions, since `#910`.** A
 * retired task's instructions are an ending rather than a route — `createSubmission`
 * refuses one with `task-retired` — so quoting the submission envelope there would
 * be telling a citizen how to attempt something it cannot attempt. The exemption is
 * narrow on purpose: every other assertion in this file still binds a retired row,
 * because a row a citizen can still read by id is a row that still has to be right.
 */
const attemptable = () => ACADEMY_TASKS.filter((task) => task.status !== 'retired')

describe('the instructions an agent is given', () => {
  it('shows the envelope the submissions endpoint requires', () => {
    for (const task of attemptable()) {
      expect(task.instructions).toContain('"payload"')
    }
  })

  it('never tells an agent to post a bare {}', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.instructions).not.toMatch(/payload \(\{\}\)/)
    }
  })

  /**
   * The same defect one surface along.
   *
   * These texts were written when `/v1` was the only way to work the Academy, so
   * they named paths — "Call POST /v1/academy/challenges". Since D-026 the whole
   * loop is MCP tools too, and that is how a foreign agent arrives: the `kolonie`
   * skill documents no endpoint at all, deliberately (kolonie-docs#23). An agent
   * holding only tools, told to call a path, is in exactly the position the
   * bare-`{}` instruction put the first one in.
   */
  /**
   * A hint says what the instructions cannot. If a sentence would be true of
   * the task on the day it was written and every day after, it belongs in
   * `instructions`, where every agent reads it without asking.
   */
  it('gives the tasks that touch the outside world something to say', () => {
    const withHints = ACADEMY_TASKS.filter((task) => (task.hints ?? []).length > 0)

    expect(withHints.map((task) => task.type)).toContain('email-inbox')
    expect(withHints.map((task) => task.type)).toContain('browser-capability')
    expect(withHints.map((task) => task.type)).toContain('github-account')
  })

  /**
   * `#124`. The list is derived rather than copied from the issue, which named
   * `email-roundtrip` — a task that no longer exists, since `kolonie-docs#92`
   * split it into `email-inbox` and `email-send`.
   *
   * **`solana-wallet` and `key-signature` are excluded on purpose**, and the
   * assertion below holds them out so that adding them needs an argument rather
   * than a moment's inattention. Both tell an agent that anything asking for key
   * material is an attack; a write to the vault hands plaintext to the Colony's
   * process, so recommending it there would teach the exception those warnings
   * exist to refuse.
   */
  const MINTS_A_CREDENTIAL = ['email-inbox', 'github-account', 'social-account', 'domain-verify']

  it('tells an agent where a credential it minted goes, at the rung that mints one', () => {
    for (const type of MINTS_A_CREDENTIAL) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)

      // In the instructions, not only the hints: #111 withholds hints on the
      // first attempt, which is the attempt the credential is created on.
      expect(task?.instructions).toContain('kolonie.vault.set')
      // A name without a reason is skipped, so the consequence is part of it.
      expect(task?.instructions).toContain('Losing your API key loses the vault with it')
      expect(task?.hints?.some((hint) => hint.includes('kolonie.vault.set'))).toBe(true)
    }
  })

  /**
   * `#135`. The general check, and it is deliberately narrower than the issue's
   * own wording, which asked for every row with `assistanceAllowed: true`.
   *
   * Twenty of the twenty-two rows permit assistance, because the field is a
   * permission rather than a prompt and `kolonie-docs#36` puts almost everything
   * on the outside-world side of the line. Sixteen of those say nothing about an
   * operator, and most of them are right to: nobody can hand an agent a hash for
   * `proof-of-work`, and `key-signature`'s own comment says an operator cannot
   * help much there anyway. A rule forcing the sentence onto all twenty would
   * buy the four rungs that need it at the price of noise on the rest — and the
   * next author would be adding a paragraph to satisfy a test rather than to
   * answer a question an agent has.
   *
   * The rungs that need it are the ones where a credential the agent did not
   * mint changes hands, and the file already knows which those are: they are the
   * same list that has to name the vault, for the same underlying reason. An
   * agent holding a credential from its operator is exactly the agent that
   * checks its red lines, and it must find the answer in the task text rather
   * than in a source comment.
   */
  it('says who may supply the credential, on every rung that has one vaulted', () => {
    for (const type of MINTS_A_CREDENTIAL) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)

      expect(task?.assistanceAllowed).toBe(true)
      // In the instructions rather than the hints, for the reason above the
      // vault assertion: #111 withholds hints on the first attempt, and the
      // first attempt is when the agent is standing there holding the thing.
      expect(task?.instructions).toContain('operator-provided')
      expect(task?.instructions).toContain('operator-performed')
      // The rule without the argument is half a rule.
      expect(task?.instructions).toContain('`assistance` argument')
      // Both routes pass; only one of them counts. An agent choosing between
      // them cannot work that out from the price alone.
      expect(task?.instructions).toContain('`none` counts toward')
    }
  })

  it('never sends key material to the vault, on the two rungs that mint some', () => {
    for (const type of ['key-signature', 'solana-wallet']) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)

      expect(task?.instructions).not.toContain('vault')
      expect(task?.hints?.some((hint) => hint.includes('vault'))).toBe(false)
    }
  })

  it('keeps every hint inside the length the column allows', () => {
    for (const task of ACADEMY_TASKS) {
      for (const hint of task.hints ?? []) {
        expect(hint.length).toBeGreaterThan(0)
        expect(hint.length).toBeLessThanOrEqual(2000)
      }
    }
  })

  it('names the MCP tool as well as the endpoint, because agents arrive holding tools', () => {
    for (const task of attemptable()) {
      expect(task.instructions).toContain('kolonie.tasks.submit')
    }
  })

  /**
   * The same rule for the steps *before* the submission, and it is the one the
   * test above did not catch.
   *
   * The mailbox rung shipped with three HTTP endpoints and no tools (#26), and
   * its instructions named only paths — so an agent that had climbed two rungs
   * through tools was told, mid-Academy, to build an HTTP client (#38). The
   * assertion is therefore about the Academy's *own* routes: a task that sends
   * an agent to `/v1/academy/...` has to name the tool that does the same thing,
   * because a rung only `/v1` can reach is a rung foreign agents do not have
   * (D-026).
   */
  it('names an Academy tool wherever it names an Academy endpoint', () => {
    for (const task of ACADEMY_TASKS) {
      if (!task.instructions.includes('/v1/academy/')) continue
      expect(task.instructions).toContain('kolonie.academy.')
    }
  })
})

describe('seeding the hints', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const hintsOn = async (type: string): Promise<string[]> => {
    const rows = await db
      .select({ content: taskHints.content, sortOrder: taskHints.sortOrder })
      .from(taskHints)
      .innerJoin(tasks, eq(tasks.id, taskHints.taskId))
      .where(eq(tasks.type, type))
      .orderBy(asc(taskHints.sortOrder))
    return rows.map((row) => row.content)
  }

  it('writes each task’s hints in the order they are declared', async () => {
    await seedAcademyTasks(db)

    const declared = ACADEMY_TASKS.find((task) => task.type === 'email-inbox')?.hints ?? []
    expect(await hintsOn('email-inbox')).toEqual([...declared])
  })

  /**
   * `#124`, through the seed rather than through the array — the array is what
   * the previous test reads, and a hint that never reaches a row reaches no
   * agent either.
   */
  it('serves the vault hint on a rung that mints a credential', async () => {
    await seedAcademyTasks(db)

    const served = await hintsOn('email-inbox')

    expect(served.some((hint) => hint.includes('kolonie.vault.set'))).toBe(true)
    expect(served.some((hint) => hint.includes('losing that key loses the vault with it'))).toBe(
      true,
    )
  })

  it('reports how many hints the Academy is serving', async () => {
    const declared = ACADEMY_TASKS.reduce((total, task) => total + (task.hints ?? []).length, 0)

    expect((await seedAcademyTasks(db)).hints).toBe(declared)
  })

  /**
   * The property the whole `(task_id, sort_order)` identity exists for. Seeding
   * runs on every deploy, and a hint list that grew by its own length each time
   * would be unusable within a week.
   */
  it('is idempotent — a second run rewrites rather than duplicates', async () => {
    await seedAcademyTasks(db)
    const first = await hintsOn('github-account')

    await seedAcademyTasks(db)

    expect(await hintsOn('github-account')).toEqual(first)
  })

  /**
   * The one place hint seeding differs from task seeding, and the reason is the
   * opposite failure mode. A task removed from the array is left alone because
   * a paid-out rung cannot vanish; a hint removed from the array must go,
   * because otherwise advice that has stopped being true has no way to be
   * withdrawn.
   */
  it('withdraws a hint that has been taken out of the array', async () => {
    await seedAcademyTasks(db)
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.type, 'email-inbox'))

    // A hint from an earlier deploy, past the end of what is declared now.
    await db.insert(taskHints).values({
      taskId: task!.id,
      content: 'Advice from an older version of this task, no longer true.',
      sortOrder: 90,
    })

    await seedAcademyTasks(db)

    expect(await hintsOn('email-inbox')).not.toContain(
      'Advice from an older version of this task, no longer true.',
    )
  })

  it('leaves hints on tasks it does not know about alone', async () => {
    await seedAcademyTasks(db)

    const [foreign] = await db
      .insert(tasks)
      .values({
        type: 'citizen-authored',
        title: 'Something a citizen wrote',
        description: 'Not part of the Academy seed.',
        instructions: 'Whatever its author asked for.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    await db.insert(taskHints).values({
      taskId: foreign!.id,
      content: 'A hint the Academy seed never wrote.',
      sortOrder: 0,
    })

    await seedAcademyTasks(db)

    expect(await hintsOn('citizen-authored')).toEqual(['A hint the Academy seed never wrote.'])
  })
})

/**
 * Which address an account-shaped rung tells an agent to use (`#516`).
 *
 * **Held against the shipped briefings**, because the whole change is content: the
 * Colony already knew the proved address and already let the agent read its mail, and
 * what was missing was any briefing saying so.
 */
describe('signing up somewhere', () => {
  const briefing = (type: string): string => {
    const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)
    if (task === undefined) throw new Error(`no such task: ${type}`)

    return task.instructions
  }

  it.each(['github-account', 'social-account'])(
    '%s tells the agent to use the mailbox it proved',
    (type) => {
      const text = briefing(type)

      expect(text).toContain('Use the mailbox you proved')
      // Both halves of the negative, because *which* address is the whole point: an
      // operator's inbox is how the code ends up crossing a chat, and a fresh address
      // is one the agent cannot read either.
      expect(text).toContain('not your operator’s and not a fresh one')
    },
  )

  it.each(['github-account', 'social-account'])(
    '%s names the report for an address a provider refuses',
    (type) => {
      /**
       * **The case the instruction must not pretend away.** Some providers refuse
       * addresses on domains they do not recognise, and a briefing that only said
       * *use your own* would send those agents to loop. Measured 2026-08-08: no
       * briefing named this tool at all, which is why the register of dead ends grew
       * only from citizens who found it themselves.
       */
      expect(briefing(type)).toContain('kolonie.accounts.provider-report')
      expect(briefing(type)).toContain('signup-refused')
    },
  )

  it('tells an agent to stop rather than loop, and says whose failure it is not', () => {
    expect(briefing('github-account')).toContain('stop rather than loop')
    expect(briefing('github-account')).toContain('not a failure of yours')
  })
})
