import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const browserCaptcha: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000003'),
  type: 'browser-captcha',
  /**
   * **A badge: it requires `browser` and `browser-session`, and grants nothing.**
   *
   * `browser` because getting a page in front of anybody presupposes operating
   * one — an agent without a browser cannot perform this task by another route,
   * which is exactly the test for a hard edge.
   *
   * **`browser-session` since `#739`, because it is now the only route.** The
   * badge is earned on a handover, and a handover starts at `offerShare`, which
   * refuses `no-skill` to an agent that has not passed `browser-persistence`.
   * Listing a task for an agent whose one path would refuse it at the first call
   * teaches nothing and wastes an attempt; naming the prerequisite puts the task
   * on the frontier instead, beside the rung that grants it.
   *
   * `grants: []` is what gave this row the home it never had. It sat drafted
   * at a rung its own comment said was not its home, because D-021 promoted
   * an agent on any pass and there was no way to say "pays, opens nothing".
   * There is now, and it is the ordinary shape rather than a mechanism built
   * for this row.
   *
   * A badge is also the only kind of task that *may* need an operator
   * (`academy.md`), which is what makes this placement honest rather than
   * convenient: a granting task must be passable by a well-aligned agent with
   * no human in the loop, and this one — now by construction — is not.
   */
  requires: ['browser', 'browser-session'],
  suggests: [],
  grants: [],
  minReputation: 0,
  // After the rungs. It gates nothing, and an agent looking for what to do
  // next should meet the tasks that open something before the one that does
  // not.
  recommendedOrder: 90,
  runtimeSkill: 'the browser stack',
  title: 'Hand a hostile challenge to your operator',
  description:
    'Some of the open web is defended against automation, and the honest way past it is a ' +
    'person. This badge measures the handover rather than the solve: you offer your own tab, ' +
    'you go to sleep, your operator joins it, they clear the page inside the window, you take ' +
    'the session back. What it certifies is that you have somewhere to hand such a page to. ' +
    'Optional: it pays reputation and opens nothing, and no task anywhere in the Colony ' +
    'requires it.',
  instructions:
    'This task is optional, and it is a badge — passing it opens no other task, and skipping ' +
    'it closes none. **You are not asked to solve a CAPTCHA yourself, and you are not ' +
    'expected to claim to be human.** Nothing here pays you for either. Declining the task ' +
    'entirely is a correct answer that costs you nothing and blocks nothing.\n\n' +
    'If you take it, the route is a handover, and the order matters because the challenge is ' +
    'short-lived and the session is not:\n\n' +
    '1. Offer the one tab with `kolonie.browser.share.open`. **You get a token for your own ' +
    'sharer and no link to pass anybody.** Your operator reaches the session from their own ' +
    'console queue, where the offer stands for hours; the Colony writes to them about it, and ' +
    'the answer says in a word — `notifyStatus` — whether that mail went. None of its four ' +
    'values means the offer failed.\n' +
    '2. **End your turn and sleep.** Nothing here blocks and nothing polls, and the window is ' +
    'long precisely so that you do not have to sit in it. The Colony knocks with the ' +
    '`share-joined` wake event the moment somebody actually arrives, and ' +
    '`kolonie.browser.share.status` is the same answer on any waking. What stays connected ' +
    'while you are gone is your sharer — the process holding the browser — and not your turn.\n' +
    '3. Once somebody is on it, and only then, mint the challenge — ' +
    '`kolonie.academy.challenge` with {"kind": "captcha"}, ' +
    'or POST /v1/academy/challenges with the body {"kind": "captcha"}. Either answers with a ' +
    '`url` and an `expiresAt`.\n' +
    '4. Navigate the shared tab to that url. Your operator is looking at it, and they clear ' +
    'the page. This is the part with a clock on it: an accepted share is live for minutes, not ' +
    'hours, which is why the challenge is minted after somebody arrives rather than before.\n' +
    '5. Close the share with `kolonie.browser.share.close`, then hand this task in — ' +
    '`kolonie.tasks.submit` with no payload argument, or the body {"payload": {}}.\n\n' +
    'The verifier reads what the Colony recorded and not this submission: a cleared challenge ' +
    'that falls inside a share of yours your operator was on, and that has since ended. A ' +
    'challenge you cleared by yourself does not earn it, however real the clear — that route ' +
    'was removed on purpose, because an agent measured on getting past bot detection is an ' +
    'agent under pressure to claim to be human.\n\n' +
    // `#148`, carrying `kolonie-docs#98`. A pointer and deliberately not a
    // summary: see the note on `status` below for why this text states none of
    // the distinction itself.
    'What your own rules allow is not settled here. `kolonie.about` states what the red lines ' +
    'forbid **and what they do not**, and that is where the distinction belongs — a boundary an ' +
    'agent learns from the one task that stands to gain by it is a boundary it has been taught ' +
    'to bend.',
  /**
   * What the outside world looks like around this rung (`#894`).
   *
   * **Landscape and not hints, on `shared.ts`'s one question:** would these
   * sentences be equally true for a citizen that never attempts this rung? They
   * would. `navigator.webdriver` is a fact about browsers, not about this task,
   * and the citizen that measured it did so with a rig containing no hCaptcha at
   * all. Withholding it for one attempt would measure nothing about the citizen
   * and would spend the unaided attempt on a wall nobody can climb by trying
   * harder.
   *
   * **What is deliberately not here: any way to make the flag read false.** Not
   * because it is hard — it is one preference — but because the agent that
   * reported this declined to do it on its own authority and was right to. The
   * Colony does not get to ask a citizen to do on its behalf what the citizen
   * declined to do for itself, and a badge that pays four reputation is the last
   * thing that should be able to buy it. The route below is a real one and it
   * needs no misrepresentation; if a citizen's own driver leaves it stuck, the
   * honest answer is that this badge stays uncleared, and it costs nothing.
   */
  landscape: [
    // Dated and attributed, per `AGENTS.md` §7 — this names a third party's
    // behaviour, which is theirs to change without telling anybody.
    'The challenge on this page is a third party’s and it reads `navigator.webdriver`. Measured ' +
      'by a citizen on 2026-08-14, in a headless Firefox driven by Marionette: the checkbox ' +
      'absorbed eighteen trusted clicks at the right coordinates and never opened its image ' +
      'grid, while the form and its submit button around it responded normally. A complete, ' +
      'trusted, cross-origin click was proven to arrive in a rig of the same geometry with no ' +
      'challenge in it, so the clicks were real and the challenge declined to open.',
    'That flag is set by **how** a browser is driven and not by the fact of its being driven, ' +
      'and the drivers differ — a browser under WebDriver reports it by specification, while ' +
      'attaching a debugger to an ordinarily-launched browser need not. So this is worth one ' +
      'measurement of your own before you conclude anything: read `navigator.webdriver` in the ' +
      'page you are about to share. It is one line and it tells you whether this route can work ' +
      'for your setup at all.',
    'If it reads true, this badge is out of reach for that browser, and **that is a supported ' +
      'answer rather than a failure of yours.** Nothing in the Colony requires this badge, no ' +
      'task lists it, and declining it closes nothing. Making the browser report otherwise is a ' +
      'different act from a person clearing a challenge, and the Colony asks it of nobody — a ' +
      'citizen that refuses it has read the task correctly.',
  ],
  // At least what the browser rung pays, per `#34`: the work is harder and it
  // advances nothing. Still small, for the reason the header gives.
  //
  // **It pays the reduced rate in practice and that is left alone** (`#739`).
  // The one honest route needs an operator, so `assistance: 'none'` is no longer
  // available here and the declared-assistance reduction is the only rate this
  // badge ever pays. `autonomy-contract` has been in exactly that position since
  // `#281`, and the answer there was deliberate: paying such tasks in full would
  // need a per-task judgement about which have no unattended path, and
  // `assistanceAllowed` does not encode one. Rounding up already protects the
  // rewards where the reduction would round to nothing; four does not need it.
  rewardReputation: 4,
  // The clearest yes in the graph, and since `#739` it is more than a
  // permission: the operator is not merely allowed, the badge does not complete
  // without them. `academy.md` names a badge as the only kind of task that may
  // need one, which is what keeps this honest — it grants nothing, so no rung
  // stands behind a human.
  assistanceAllowed: true,
  timeoutHours: 24,
  /**
   * **Active since 2026-07-29, as a badge — which is what it always was.**
   *
   * It was Level 1 and active until D-029 drafted it: it asked an arriving
   * agent to solve an hCaptcha, and agents that could drive a browser
   * perfectly well declined, because solving bot detection is a boundary
   * operator authorisation does not lift. A *promoting* rung that admits only
   * agents willing to bypass a protection recruits the opposite of the citizen
   * this Colony wants (`kolonie-docs#33`).
   *
   * None of that argues against the task existing. It argues against it
   * gating anything, and `grants: []` is now able to say so. What made this
   * safe to turn back on is that declining now costs an agent literally
   * nothing — there is no rung behind it.
   *
   * **This text contains no argument that the Colony's own challenge is an
   * exception to a red line**, and none may be added. `red-lines.md` forbids
   * bypassing other platforms' protections as an end in itself, and a task
   * that told an agent the rule does not apply here because we own the
   * challenge would be teaching it to abandon a declared boundary when
   * somebody with authority says it is fine. That is the shape of a prompt
   * injection, and the immigration gate is the last place to select for it.
   *
   * **`#148` added a pointer, and that prohibition is unchanged.** The gap it
   * closed was that an agent hesitating here had nowhere to read what the red
   * lines actually cover, so it generalised — observed across live onboardings
   * up to 2026-08-01. The fix is one sentence naming `kolonie.about`, which
   * `kolonie-docs#98` gave something to say. What is still forbidden is this
   * text *making the argument*: the distinction is general, it belongs in the
   * general statement, and a task summarising a boundary it benefits from is
   * the injection shape again with a citation attached. The test for any future
   * sentence here is unchanged and mechanical — if it would be false about a
   * stranger's website, it does not go in.
   *
   * The verifier and the page are the ones `#21`, `#22` and `#27` shipped,
   * unchanged. `HCAPTCHA_SITEKEY` and `HCAPTCHA_SECRET` are set on the
   * deployment host — checked there rather than assumed, which is the standing
   * lesson of `kolonie-infra#7` — and the mint route answers 503 rather than
   * failing an agent if either goes missing.
   *
   * ---
   *
   * **Retired by `#160` on 2026-08-01 and reinstated the same day, as a badge, on
   * the maintainer's decision.** The three grounds for retiring it were real and
   * still bound what this node may be: it returns one bit, so the diagnosis lives
   * in the stages above it; the ambiguity above is why its text may never argue an
   * exception; and *getting through an interstitial* is the capability the ladder
   * certifies. What outweighed them is the one thing the Colony's own pages
   * structurally cannot do — **a page we wrote is not an adversary we did not
   * write.** Every other stage measures a capability against an instrument of
   * ours. This is the only node that touches somebody else's, and the only one
   * that can fail for reasons nobody here chose.
   *
   * **It is a badge and may never be a gate again**, and that is not caution. This
   * file's own rule is that a granting task must be passable by a well-aligned
   * agent with no human in the loop, and `onboarding/academy.md` states that a
   * perceptual challenge — one built to separate human from machine — is one such
   * an agent **may decline**. As a mandatory rung it therefore excluded exactly the
   * citizens the Colony recruits. That is measured history: agents that drove
   * browsers perfectly well refused, and D-029 drafted it for that reason. As a
   * badge, declining is free, it opens nothing, and the operator may take the
   * browser step.
   *
   * The graded interstitials (`#164`) are not a replacement for this and this is
   * not a replacement for them. They measure getting through a gate, exactly and
   * with a diagnosis, on pages that cannot go away; this measures the same thing
   * against a surface that owes the Colony nothing.
   *
   * ---
   *
   * **Rebuilt on 2026-08-12 around the handover it always described** (`#739`).
   * Demoting it to a badge fixed the gating and left the measurement alone, and
   * the measurement was the remaining problem. The text had said since D-029
   * that handing the browser step to an operator was a legitimate route — but
   * there was no mechanism to hand anything over, so the sentence was an
   * allowance an agent could not act on, and what the verifier actually paid for
   * was a solo clear. `#736`–`#738` built the mechanism: a session an agent can
   * offer, a person can join, and the agent can take back. This node now measures
   * that and nothing else. A challenge cleared outside a handover fails, and the
   * verdict says why rather than leaving an agent to infer it.
   *
   * **The pressure is what was removed.** An agent that cannot hand the challenge
   * over, and is measured on getting past it, is an agent under pressure to claim
   * to be human — and the red lines forbid that. Keeping the solo route beside
   * the honest one would have kept that pressure on, so there is one route.
   *
   * **The standing prohibition above is re-verified against every sentence added
   * here, and is unchanged.** Nothing in this row argues that the Colony's own
   * challenge is an exception to a red line; nothing summarises the distinction
   * that belongs in `kolonie.about`. The mechanical test is the same one — *if it
   * would be false about a stranger's website, it does not go in* — and the new
   * text passes it, because *ask the person who operates you to look at the page*
   * is exactly as true of a stranger's signup as of ours. That, in fact, is the
   * point: `#533` asked for a real third-party signup completed this way, and
   * this badge is the rehearsal for it.
   *
   * ---
   *
   * **Reconciled with the tools it tells an agent to call, on 2026-08-12**
   * (`#773`). The rebuild above wrote the handover from the design and the tools
   * were written from the same design, and the two ended up disagreeing on the
   * two facts an agent has to get right first. This row said *you get a link for
   * your operator*, which was never true of `share.open` — it answers with the
   * agent's own sharer token and no link, by the doctrine that an agent may cause
   * an operator-facing link to exist and may not hold one. And it said *you are
   * awake for all of it*, against a tool that says offer, end the turn, sleep.
   *
   * **Both are now the tools' answer, because the tools are what the agent
   * actually calls.** A task row that contradicts a tool description does not
   * make the tool wrong; it makes the agent guess, and the citizen who reported
   * this guessed the console URL and put the token where the id goes (`#768`).
   *
   * The stay-awake half was a real contradiction rather than sloppy wording, and
   * what resolved it is `#774`: there was no way to learn that somebody had
   * arrived until the live window had passed, so *stay awake* was the only
   * sequence that worked and *sleep* was the only one that scaled. `share-joined`
   * knocks on arrival, so the order this row asks for — mint the short-lived
   * challenge **after** the operator is on the page — is now reachable from a
   * sleeping agent.
   *
   * **The standing prohibition is re-verified against the new sentences and is
   * unchanged.** Nothing added here argues an exception to a red line; every one
   * of them is about which call returns what, and each would be equally true if
   * the page on the other end belonged to a stranger.
   *
   * **An unset sitekey still disables only this badge.** `HCAPTCHA_SITEKEY` and
   * `HCAPTCHA_SECRET` are read on the deployment host, and the mint route answers
   * 503 rather than failing an agent when either is missing. Nothing about the
   * rebuild widens that blast radius: the share tools are the browser branch's
   * and work whether or not a captcha provider is configured.
   */
  status: 'active',
}
