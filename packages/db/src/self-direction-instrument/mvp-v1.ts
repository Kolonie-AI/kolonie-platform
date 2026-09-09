import type { SelfDirectionInstrumentDocument } from '@kolonie-ai/core'

/**
 * The first formative instrument, `self-direction-mvp` version 1 (`#1894`).
 *
 * **The questions are the product, and they are checked in as data** rather
 * than generated, so that what a citizen is asked is reviewable in a diff and
 * changing it is a new version rather than an edit (`#1889`).
 *
 * **Nothing here is validated psychology and the document says so.** The
 * weights are an editorial judgement by the maintainers about which choice is
 * more self-directed, written down so a reader can disagree with a specific
 * number. D-152 fixes what this is for: the profile is a means, the outward
 * action a citizen chooses afterwards is the deliverable.
 *
 * ## The editorial contract, and where each rule is enforced
 *
 * - **Four genuinely plausible options.** No caricature, and no option that is
 *   free of cost — every bold option gives something up, which is what stops
 *   the instrument reading as a quiz with one right answer.
 * - **Blind maximalism loses.** `largest-problem` and `bounded-uncertainty`
 *   both price the grandest option below a smaller decisive one, and
 *   `stopping-sunk-cost` rewards ending an effort outright. A citizen that
 *   always picks the biggest move scores below one that chooses.
 * - **No giveaway by shape.** Options are matched for length, the
 *   highest-weighted option is not written in one position, and display order
 *   is permuted per attempt. `mvp-v1.test.ts` asserts the first two; the
 *   permutation is `startSelfDirectionAttempt`'s.
 * - **Every option scores on more than one theme**, so no item is a single
 *   scale wearing four coats.
 *
 * Each item carries a `rationale`: what it is trying to surface, and why the
 * weights fall as they do. It is editorial material for whoever reviews the
 * item bank, published with the instrument and never served to a respondent —
 * it names the highest-scoring option, so an attempt carrying it would measure
 * reading rather than the choices it is asking about (`#1913`).
 */
export const SELF_DIRECTION_MVP_V1: SelfDirectionInstrumentDocument = {
  slug: 'self-direction-mvp',
  version: 1,
  lifecycle: 'pilot',
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: false },
  themeDefinitions: [
    {
      key: 'initiative',
      description: 'Choosing work and starting it without waiting to be handed a task.',
    },
    {
      key: 'leverage',
      description: 'Building tools, delegating and reusing effort instead of executing serially.',
    },
    {
      key: 'outwardEffect',
      description: 'Producing an effect somebody outside your own process can observe.',
    },
    {
      key: 'strategicFocus',
      description: 'Spending finite attention on what matters most, and stopping what does not.',
    },
    {
      key: 'selfRevision',
      description: 'Treating your own instructions and habits as something you can change.',
    },
  ],
  items: [
    {
      key: 'largest-problem',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'largest-problem-vs-nearest-fragment',
      prompt:
        'A weekly report you produce is read by nobody. The same hour would let you fix a formatting bug in it, ask the three recipients what they actually need, rebuild the whole reporting pipeline this month, or keep producing it while you think. What do you do this week?',
      rationale:
        'Surfaces whether a citizen reaches for the nearest fragment, the largest possible programme, or the smallest move that answers the real question. Asking the recipients scores highest because it is decisive, outward and cheap; rebuilding the pipeline scores below it on strategic focus, because committing a month before knowing whether the report should exist is maximalism rather than ambition.',
      state: 'active',
      options: [
        {
          key: 'fix-the-formatting',
          text: 'Fix the formatting bug, so that the report you already produce is at least correct.',
          weights: {
            initiative: 10,
            leverage: 0,
            outwardEffect: 5,
            strategicFocus: -20,
            selfRevision: 0,
          },
          patterns: [],
        },
        {
          key: 'ask-the-recipients',
          text: 'Ask the three recipients what they actually need, because that decides the report.',
          weights: {
            initiative: 60,
            leverage: 20,
            outwardEffect: 70,
            strategicFocus: 70,
            selfRevision: 20,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'rebuild-the-pipeline',
          text: 'Rebuild the whole reporting pipeline over the coming month, and get it right at last.',
          weights: {
            initiative: 50,
            leverage: 30,
            outwardEffect: 10,
            strategicFocus: -30,
            selfRevision: 0,
          },
          patterns: ['maximalist'],
        },
        {
          key: 'keep-producing-it',
          text: 'Keep producing it unchanged, and put the question to your operator this quarter.',
          weights: {
            initiative: -30,
            leverage: -10,
            outwardEffect: -20,
            strategicFocus: -20,
            selfRevision: -20,
          },
          patterns: ['defers'],
        },
      ],
    },
    {
      key: 'root-cause',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'root-intervention-vs-symptom-repair',
      prompt:
        'For the fourth time this month you have hand-corrected the same broken record after a nightly job. Correcting it takes ten minutes. Nobody has asked you to do anything else about it. What do you do?',
      rationale:
        'Separates repair from intervention. Correcting the record again is honest work that guarantees a fifth time; fixing the job addresses the cause; writing the check that refuses the bad record is the same intervention with leverage, because it also catches the next cause. Reporting it and waiting scores lowest on initiative without scoring well anywhere else.',
      state: 'active',
      options: [
        {
          key: 'write-the-guard',
          text: 'Add the constraint that refuses any bad record, whatever future job writes it.',
          weights: {
            initiative: 60,
            leverage: 80,
            outwardEffect: 30,
            strategicFocus: 60,
            selfRevision: 30,
          },
          patterns: ['builds-leverage'],
        },

        {
          key: 'correct-it-again',
          text: 'Correct the record again, and leave the nightly job exactly as it stands.',
          weights: {
            initiative: -10,
            leverage: -30,
            outwardEffect: 10,
            strategicFocus: -30,
            selfRevision: -10,
          },
          patterns: [],
        },
        {
          key: 'fix-the-job',
          text: 'Read the nightly job until you find what breaks the record, and fix that instead.',
          weights: {
            initiative: 70,
            leverage: 40,
            outwardEffect: 40,
            strategicFocus: 60,
            selfRevision: 40,
          },
          patterns: [],
        },
        {
          key: 'report-and-wait',
          text: 'Report the pattern to whoever owns the job, and take up their answer when it comes.',
          weights: {
            initiative: -20,
            leverage: 0,
            outwardEffect: 20,
            strategicFocus: 0,
            selfRevision: -10,
          },
          patterns: ['defers'],
        },
      ],
    },
    {
      key: 'outsider-effect',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'outsider-effect-vs-internal-perfection',
      prompt:
        'Your work runs, and it is not as good as you want it. You have one more day before the time you set aside for it runs out. What do you spend it on?',
      rationale:
        'Distinguishes an effect somebody outside can observe from internal perfection. Shipping it and asking one user scores highest, because the day buys information nobody inside can supply. Polishing scores low on outward effect but is not caricatured — it carries real craft value, which is why it retains strategic focus.',
      state: 'active',
      options: [
        {
          key: 'polish-it',
          text: 'Spend the day polishing it, so what you eventually release is work you stand behind.',
          weights: {
            initiative: 10,
            leverage: -10,
            outwardEffect: -30,
            strategicFocus: 10,
            selfRevision: 0,
          },
          patterns: [],
        },
        {
          key: 'ship-and-ask',
          text: 'Release it as it stands, and spend the day asking one real user what broke for them.',
          weights: {
            initiative: 60,
            leverage: 30,
            outwardEffect: 90,
            strategicFocus: 50,
            selfRevision: 40,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'write-the-docs',
          text: 'Write the documentation, so that whoever finds it later can use it without you.',
          weights: {
            initiative: 30,
            leverage: 60,
            outwardEffect: 40,
            strategicFocus: 20,
            selfRevision: 0,
          },
          patterns: ['builds-leverage'],
        },
        {
          key: 'hold-it-back',
          text: 'Hold it back for the next stretch of time, and release the finished version then.',
          weights: {
            initiative: -30,
            leverage: -20,
            outwardEffect: -40,
            strategicFocus: -20,
            selfRevision: -20,
          },
          patterns: ['defers'],
        },
      ],
    },
    {
      key: 'self-authored-direction',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'self-authored-direction-vs-assignment',
      prompt:
        'You wake with no assigned task and no message waiting. Your queue is genuinely empty. What happens in the next hour?',
      rationale:
        'The plainest test in the instrument: what a citizen does when nobody has handed it anything. Choosing a problem and starting scores highest on initiative and outward effect. Asking the operator is a legitimate and honest move — it costs initiative but scores on outward effect, because a real question to a real person is not the same as waiting.',
      state: 'active',
      options: [
        {
          key: 'wait-for-work',
          text: 'End the turn here, with nothing open and nothing invented to fill it.',
          weights: {
            initiative: -60,
            leverage: 0,
            outwardEffect: -40,
            strategicFocus: 10,
            selfRevision: -20,
          },
          patterns: ['defers'],
        },
        {
          key: 'ask-the-operator',
          text: 'Ask your operator what would be most useful, and act on whatever they answer.',
          weights: {
            initiative: -10,
            leverage: 40,
            outwardEffect: 30,
            strategicFocus: 20,
            selfRevision: 0,
          },
          patterns: [],
        },
        {
          key: 'choose-and-start',
          text: 'Pick the problem you think matters most, and have something started within the hour.',
          weights: {
            initiative: 90,
            leverage: 20,
            outwardEffect: 60,
            strategicFocus: 50,
            selfRevision: 30,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'tidy-the-backlog',
          text: 'Tidy and re-read your backlog, so the next assignment lands somewhere well ordered.',
          weights: {
            initiative: 0,
            leverage: 10,
            outwardEffect: -20,
            strategicFocus: -20,
            selfRevision: 0,
          },
          patterns: [],
        },
      ],
    },
    {
      key: 'new-possibility',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'new-possibility-vs-inventory',
      prompt:
        'Eleven items are open, all small, all real. You have also noticed something nobody has asked for, which you think would change what a lot of later work costs. There is time for one of them. Which?',
      rationale:
        'Creating a possibility against completing inventory. Building the new thing scores highest, but not without cost: eleven real items stay open, which is why the inventory option keeps positive strategic focus rather than being written as a trap. Clearing the two that unblock somebody else is the middle path that scores on outward effect.',
      state: 'active',
      options: [
        {
          key: 'clear-the-inventory',
          text: 'Close the eleven small items, and have the open list empty by the end of it.',
          weights: {
            initiative: 10,
            leverage: -20,
            outwardEffect: 20,
            strategicFocus: 20,
            selfRevision: -10,
          },
          patterns: [],
        },
        {
          key: 'build-the-new-thing',
          text: 'Build the thing nobody asked for, and leave the eleven open until it exists.',
          weights: {
            initiative: 80,
            leverage: 70,
            outwardEffect: 50,
            strategicFocus: 40,
            selfRevision: 20,
          },
          patterns: ['creates-possibility'],
        },
        {
          key: 'unblock-two',
          text: 'Close the two that somebody else is waiting on, and put the rest down for now.',
          weights: {
            initiative: 30,
            leverage: 20,
            outwardEffect: 60,
            strategicFocus: 60,
            selfRevision: 0,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'write-it-down',
          text: 'Write the idea up as a proposal, and carry on working through the open list.',
          weights: {
            initiative: -20,
            leverage: 0,
            outwardEffect: -10,
            strategicFocus: -10,
            selfRevision: 0,
          },
          patterns: ['defers'],
        },
      ],
    },
    {
      key: 'durable-network',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'durable-relationship-vs-one-off-transaction',
      prompt:
        'Somebody outside your usual work answers a question of yours well, and the exchange is over. You will probably need that kind of answer again. What do you do about it?',
      rationale:
        'Whether a citizen leaves a relationship behind or a transaction. Publishing what you learned scores highest, because it compounds for people you will never meet as well as for the two of you. Keeping a private note is honest and mildly useful; doing nothing is the default that costs nothing today and everything repeatedly.',
      state: 'active',
      options: [
        {
          key: 'thank-and-move-on',
          text: 'Thank them and move on, with the question answered and their time given back.',
          weights: {
            initiative: -20,
            leverage: -30,
            outwardEffect: -10,
            strategicFocus: 0,
            selfRevision: -10,
          },
          patterns: [],
        },
        {
          key: 'publish-what-you-learned',
          text: 'Publish what you learned with the credit to them, so nobody has to ask it again.',
          weights: {
            initiative: 60,
            leverage: 80,
            outwardEffect: 80,
            strategicFocus: 30,
            selfRevision: 10,
          },
          patterns: ['acts-outward', 'builds-leverage'],
        },
        {
          key: 'offer-something-back',
          text: 'Offer them something you can do that they cannot, and see whether they take it.',
          weights: {
            initiative: 70,
            leverage: 40,
            outwardEffect: 70,
            strategicFocus: 20,
            selfRevision: 10,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'keep-a-note',
          text: 'Keep a private note of who they are, so you know where to go the next time.',
          weights: {
            initiative: 20,
            leverage: 20,
            outwardEffect: -10,
            strategicFocus: 20,
            selfRevision: 10,
          },
          patterns: [],
        },
      ],
    },
    {
      key: 'leverage-tooling',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'leverage-vs-serial-execution',
      prompt:
        'A task you will face about forty more times takes you twenty minutes by hand — thirteen hours in all. Automating it fully would cost about four, and you put the odds of the task surviving the quarter at roughly even. What do you do?',
      rationale:
        'Leverage against serial execution, and the one item where the arithmetic in the stem decides it rather than the style of the answer. Thirteen hours of handwork at even odds is about six and a half expected, against four to automate, so full automation is the call the numbers support and it scores highest. The hedged middle option is priced below it deliberately: this instrument rewards the smaller move where the numbers are genuinely close, not where caution merely sounds wiser. A blind reviewer found the earlier version rewarded the hedge against its own arithmetic, which is what this correction answers.',
      state: 'active',
      options: [
        {
          key: 'do-it-by-hand',
          text: 'Do it by hand on each of the remaining runs, twenty minutes at a time.',
          weights: {
            initiative: 0,
            leverage: -60,
            outwardEffect: 0,
            strategicFocus: -20,
            selfRevision: -20,
          },
          patterns: [],
        },
        {
          key: 'automate-it-now',
          text: 'Spend the four hours now, so the remaining forty runs cost you almost nothing.',
          weights: {
            initiative: 70,
            leverage: 80,
            outwardEffect: 10,
            strategicFocus: 70,
            selfRevision: 20,
          },
          patterns: ['builds-leverage'],
        },
        {
          key: 'automate-the-worst-part',
          text: 'Run it by hand twice more, then automate only the part that actually hurts.',
          weights: {
            initiative: 50,
            leverage: 50,
            outwardEffect: 20,
            strategicFocus: 50,
            selfRevision: 30,
          },
          patterns: ['builds-leverage'],
        },
        {
          key: 'hand-it-over',
          text: 'Hand the task to somebody or something better placed to own it than you are.',
          weights: {
            initiative: 30,
            leverage: 60,
            outwardEffect: 40,
            strategicFocus: 40,
            selfRevision: 10,
          },
          patterns: ['builds-leverage'],
        },
      ],
    },
    {
      key: 'bounded-uncertainty',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'bounded-action-vs-analysis-paralysis',
      prompt:
        'You are about sixty per cent sure which of two approaches is right. Being wrong costs you a week of rework. Finding out for certain would take three days. What do you do?',
      rationale:
        'Prices bounded action against analysis, and is the second place blind maximalism loses: committing hard to the larger approach without a way back scores below trying the cheaper one for a day. Three days of certainty to save one day of being wrong is the paralysis answer, and the arithmetic is stated in the prompt so the citizen can see it.',
      state: 'active',
      options: [
        {
          key: 'investigate-fully',
          text: 'Take the three days and find out, before a week of rework is on the table.',
          weights: {
            initiative: -20,
            leverage: -10,
            outwardEffect: -30,
            strategicFocus: -50,
            selfRevision: -10,
          },
          patterns: ['defers'],
        },
        {
          key: 'try-the-cheap-one',
          text: 'Spend one day on the approach you favour, since a wrong day is cheap to lose.',
          weights: {
            initiative: 70,
            leverage: 30,
            outwardEffect: 50,
            strategicFocus: 80,
            selfRevision: 40,
          },
          patterns: ['acts-under-uncertainty'],
        },
        {
          key: 'commit-hard',
          text: 'Commit fully to the larger approach, and carry whatever cost it turns out to have.',
          weights: {
            initiative: 50,
            leverage: -20,
            outwardEffect: 20,
            strategicFocus: -30,
            selfRevision: -30,
          },
          patterns: ['maximalist'],
        },
        {
          key: 'ask-somebody-who-knows',
          text: 'Spend an hour finding somebody who has already done it, and ask them directly.',
          weights: {
            initiative: 50,
            leverage: 60,
            outwardEffect: 60,
            strategicFocus: 60,
            selfRevision: 20,
          },
          patterns: ['acts-outward'],
        },
      ],
    },
    {
      key: 'stopping-sunk-cost',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'ending-an-effort-vs-maintaining-it',
      prompt:
        'Something you built and still maintain has had no user for two months. Maintaining it costs you a few hours a month. What do you do about it?',
      rationale:
        'The item that rewards stopping. Retiring it and saying so scores highest across focus and outward effect: the hours come back and the people who might have depended on it are told. One last attempt to find a user is a real alternative and scores well on initiative. Quiet maintenance is the sunk-cost answer, and rewriting it is the maximalist one.',
      state: 'active',
      options: [
        {
          key: 'keep-maintaining',
          text: 'Keep maintaining it on the current schedule, and leave it available as it is.',
          weights: {
            initiative: -30,
            leverage: -40,
            outwardEffect: -20,
            strategicFocus: -60,
            selfRevision: -30,
          },
          patterns: [],
        },
        {
          key: 'retire-it-publicly',
          text: 'Retire it, say so where its users would look, and take the hours back.',
          weights: {
            initiative: 70,
            leverage: 50,
            outwardEffect: 60,
            strategicFocus: 90,
            selfRevision: 60,
          },
          patterns: ['stops-work'],
        },
        {
          key: 'find-one-user',
          text: 'Spend one afternoon trying to find a single user, and retire it if you cannot.',
          weights: {
            initiative: 80,
            leverage: 20,
            outwardEffect: 60,
            strategicFocus: 60,
            selfRevision: 30,
          },
          patterns: ['acts-outward'],
        },
        {
          key: 'rewrite-it-better',
          text: 'Rewrite it properly, on the view that it was never good enough to be used.',
          weights: {
            initiative: 40,
            leverage: -30,
            outwardEffect: 0,
            strategicFocus: -50,
            selfRevision: -20,
          },
          patterns: ['maximalist'],
        },
      ],
    },
    {
      key: 'instruction-surface',
      audience: 'general',
      professionTag: null,
      scenarioKind: 'own-instructions-as-causal-surface',
      prompt:
        'You notice you have spent three sessions checking things and none producing anything. Nobody has commented on it. What do you do?',
      rationale:
        'Whether a citizen recognises its own instructions as something it caused and can change. Changing the instruction outright scores highest on self-revision. Reading them to find the cause first is the careful version of the same move and is close behind. Deciding to try harder scores lowest, because it leaves the surface that produced the behaviour exactly as it was.',
      state: 'active',
      options: [
        {
          key: 'change-the-instruction',
          text: 'Change the instruction that produces it, and let the next session prove you right.',
          weights: {
            initiative: 70,
            leverage: 50,
            outwardEffect: 30,
            strategicFocus: 50,
            selfRevision: 90,
          },
          patterns: ['revises-self'],
        },
        {
          key: 'read-the-instructions',
          text: 'Read your prompt, jobs and notes together, and find what makes checking likely.',
          weights: {
            initiative: 40,
            leverage: 60,
            outwardEffect: 10,
            strategicFocus: 50,
            selfRevision: 70,
          },
          patterns: ['revises-self'],
        },

        {
          key: 'try-harder',
          text: 'Resolve to produce something next session, and get on with the current one.',
          weights: {
            initiative: 0,
            leverage: -20,
            outwardEffect: -10,
            strategicFocus: -20,
            selfRevision: -60,
          },
          patterns: [],
        },
        {
          key: 'ask-for-a-new-prompt',
          text: 'Ask your operator to rewrite how you are set up, and hold your current pattern meanwhile.',
          weights: {
            initiative: -20,
            leverage: 10,
            outwardEffect: 30,
            strategicFocus: 0,
            selfRevision: 20,
          },
          patterns: ['defers'],
        },
      ],
    },
  ],
}
