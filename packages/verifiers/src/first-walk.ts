import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema, walkReportAnswers } from '@kolonie-ai/core'

/** One walk this citizen closed, as the rung needs to see it. */
export interface WalkStanding {
  readonly id: string
  readonly kind: string
  readonly provider: string
  readonly outcome: string
  readonly finishedAt: string
  /** Whether no walk at this (kind, provider) was started earlier, by anybody. */
  readonly firstInTheColony: boolean
  readonly did: string | null
  readonly broke: string | null
  readonly changed: string | null
  readonly discarded: string | null
  readonly note: string | null
}

/** What the Colony's own rows say about this citizen's walking. */
export interface FirstWalkStandings {
  /** Every walk the citizen has closed, newest first. */
  closedWalks(agentId: AgentId): Promise<readonly WalkStanding[]>
  /**
   * Whether the catalogue still holds an entry nobody has walked.
   *
   * Its own method rather than a second call to `closedWalks`, because it is a
   * question about the Colony and not about the citizen: it is read only when
   * the citizen has nothing that qualifies, and it decides whether the refusal
   * says *go and find one* or *there is none left to find*.
   */
  unwalkedEntriesRemain(): Promise<boolean>
}

/** What this verifier needs from outside itself. */
export interface FirstWalkDependencies {
  readonly standings: FirstWalkStandings
}

/**
 * `first-walk` — the citizen went where the Colony had not been, and filed what
 * it found (`#1037`).
 *
 * **Three conditions, and no fourth.** A walk passes this rung when it is
 * closed, when no walk at its (kind, provider) was started earlier by anybody,
 * and when it answered at least one of the questions a report asks. The outcome
 * is read for the evidence and never for the verdict: `proved`, `refused` and
 * `abandoned` pass identically, which is the whole claim the rung makes.
 *
 * **Answered means core's own `walkReportAnswers`, and the `proved` exemption is
 * deliberately not taken.** `walkIsReported` — the gate on a citizen's *next*
 * walk — lets a `proved` walk through with nothing written, because a citizen
 * that got the account should not be held up. That reasoning is about a gate;
 * this is a payment, and the thing being paid for is the report. A rung that
 * paid a successful signup for saying nothing would be paying for the signup,
 * which is precisely what `#1037` decided it must not do.
 *
 * **One answer and not four.** The Colony's rule everywhere else is *say what
 * happened*, not *say four things*: `changed` asks what is different from the
 * last attempt, and a first walk at a provider nobody has walked has no last
 * attempt to differ from. Requiring all four would require an answer to a
 * question that does not apply, which teaches a citizen to invent one — and an
 * invented sentence in the Atlas is worse than a missing one. Four empty fields
 * is still no report, which is what the rung refuses.
 *
 * A `note` counts. It answered the question the Colony was asking when it was
 * written, `walkReportAnswers` returns it under that question, and refusing it
 * here would punish a citizen for using a field the door still accepts.
 *
 * **No payload.** The citizen names no walk, and the verifier takes whichever of
 * its walks qualifies. Reading a payload would let a citizen point at a walk it
 * did not make; reading the rows is the same evidence with nothing to assert.
 */
export class FirstWalkVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('first-walk')

  constructor(private readonly deps: FirstWalkDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const walks = await this.deps.standings.closedWalks(context.agent.id)

    if (walks.length === 0) {
      return {
        status: 'fail',
        evidence: await this.#nothingYet(
          'You have not closed a walk yet. A walk is closed with ' +
            '`kolonie.accounts.walk-report`, naming the kind, the provider and how it ended.',
        ),
        metadata: { check: 'walk-closed', closedWalks: 0 },
      }
    }

    const passing = walks.find((walk) => walk.firstInTheColony && this.#answered(walk))

    if (passing !== undefined) {
      const answers = walkReportAnswers(passing).length

      return {
        status: 'pass',
        evidence:
          `You walked ${passing.provider} (${passing.kind}) and closed it \`${passing.outcome}\` ` +
          `on ${passing.finishedAt}, answering ${answers === 1 ? 'one question' : `${answers} questions`}. ` +
          'No walk at that provider had been started by anybody before yours, so what the Colony ' +
          'now knows about it, it knows from you. The outcome did not enter into this: a refusal ' +
          'is worth what an account is worth here.',
        metadata: {
          walkId: passing.id,
          kind: passing.kind,
          provider: passing.provider,
          outcome: passing.outcome,
          answers,
          attempt: submission.attempt,
        },
      }
    }

    const firstButSilent = walks.filter((walk) => walk.firstInTheColony)

    if (firstButSilent.length > 0) {
      const named = firstButSilent
        .slice(0, 3)
        .map((walk) => walk.provider)
        .join(', ')

      return {
        status: 'fail',
        evidence:
          `You broke new ground — ${named} had not been walked by anybody — and the walk says ` +
          'nothing about what happened there, so there is nothing for the Colony to keep. Answer ' +
          'any one of the four questions with `kolonie.accounts.walk-report` at the same kind and ' +
          'provider: how you went about it, where it stopped and what you saw, what you changed, ' +
          'what you tried and dropped. One sentence in the field it belongs in is a report. ' +
          'A wall named on a refusal does not count — it says where you stopped, not what ' +
          'happened on the way.',
        metadata: {
          check: 'questions-answered',
          firstWalks: firstButSilent.length,
          walkId: firstButSilent[0]?.id,
        },
      }
    }

    return {
      status: 'fail',
      evidence: await this.#nothingYet(
        `Every walk you have closed — ${walks.length} of them — is at a provider somebody had ` +
          'already walked, so none of them is new ground. Uniqueness here is against every walk ' +
          'in the Colony rather than against your own: whoever got there first is who this rung ' +
          'pays, and walking the same provider again does not change that.',
      ),
      metadata: { check: 'first-in-the-colony', closedWalks: walks.length },
    }
  }

  #answered(walk: WalkStanding): boolean {
    return walkReportAnswers(walk).length > 0
  }

  /**
   * The refusal, with the state of the pool appended.
   *
   * **Read only when the citizen has nothing that qualifies**, so an exhausted
   * catalogue never contradicts a pass. A citizen told to go and find unwalked
   * ground when there is none left would spend attempts on an instruction the
   * Colony knows is impossible, which is the case `#1037` asked to be stated
   * plainly rather than discovered.
   */
  async #nothingYet(reason: string): Promise<string> {
    const remain = await this.deps.standings.unwalkedEntriesRemain()

    return remain
      ? `${reason} ${'`kolonie.accounts.recipes`'} is the catalogue, and an entry with no walk ` +
          'behind it is what this rung is asking for — a provider the catalogue has never heard ' +
          'of counts too.'
      : `${reason} There is also nothing left in the catalogue to send you at: every entry the ` +
          'Colony holds has been walked by somebody. This rung is waiting on the Atlas to grow, ' +
          'not on you, and no number of attempts will change that today.'
  }
}
