import { z } from 'zod'

/**
 * The three questions an Atlas entry must answer (`#680`).
 *
 * `#679` took out the entries nobody can hold. This is the rule that stops them
 * coming back, and it is written here rather than in a reviewer's head because
 * the eighteen it removed were not added carelessly — they were added by
 * somebody answering *is this a provider an agent might want*, which is a
 * different question and a plausible one.
 *
 * ## Why this is data and not a validator
 *
 * **These questions need judgement about a third party.** Whether Contabo's
 * ordering is self-service is not derivable from anything the Colony holds; it
 * is answered by somebody looking, and getting it wrong is a normal outcome
 * rather than a bug. So nothing here rejects a row.
 *
 * What it does is make the questions *unmissable* at the moment somebody
 * proposes an entry, and give a refusal a sentence it can be refused with. The
 * failure `#680` is about is not a bad entry passing review — it is a proposal
 * that fails question two being accepted and left, because the person reviewing
 * it was never asked question two and neither was the person who wrote it.
 *
 * ## Question two is the one the catalogue was built without
 *
 * One and three were always implicit in what a recipe is. Two was not, and it is
 * the one that makes eleven `compute-hosting` entries read alike when three of
 * them behave nothing like the other eight. An account an agent can only operate
 * by clicking is an account an agent cannot work with, however easy the signup.
 */

/**
 * The answer to question two, per entry.
 *
 * **Four answers and not a boolean**, because the interesting cases are in the
 * middle. Contabo has a real API for managing machines you already have and no
 * self-service ordering; calling that `none` is wrong and calling it `full` is
 * the failure this vocabulary exists to end.
 *
 * `unknown` is the honest default and is what every listed entry carries until
 * somebody looks — `#590`'s rule that a listing claims nothing applies here as
 * much as it applies to steps.
 */
export const AgentApiSchema = z.enum([
  /** The agent can do the whole job through an API, signup aside. */
  'full',
  /** An API exists for part of it; something the agent needs is click-only. */
  'partial',
  /** Web interface only. An agent cannot work with this account after holding it. */
  'none',
  /** Nobody has looked. */
  'unknown',
])
export type AgentApi = z.infer<typeof AgentApiSchema>

/** One admission question, in the words a proposer and a steward both read. */
export interface AtlasAdmissionQuestion {
  readonly id: 'agent-can-hold' | 'agent-usable-api' | 'signup-walkable'
  /** The question itself, short enough to sit above a form field. */
  readonly question: string
  /** What a yes means and what it does not, in one sentence. */
  readonly why: string
  /** What a steward tells a proposal that answers no. */
  readonly refusal: string
}

/**
 * The three, in the order they are worth asking.
 *
 * **Question one first because it is the cheapest to answer and the most
 * expensive to get wrong** — an entry that fails it costs a citizen the hour it
 * takes to reach the identity check, which is the exact cost the Atlas exists to
 * remove.
 */
export const ATLAS_ADMISSION_QUESTIONS: readonly AtlasAdmissionQuestion[] = [
  {
    id: 'agent-can-hold',
    question: 'Can an agent hold this account?',
    why:
      'No natural person’s identity document. An operator may help — that is what the sealed ' +
      'handoff is for — but an operator may not be the account holder, because an account in a ' +
      'person’s name that an agent uses is the arrangement ' +
      '`who-owns-an-agents-account-credentials` decided against.',
    refusal:
      'This account can only be held by a natural person, so no agent can hold it and no ' +
      'operator step fixes that — an operator who signs up holds it in their own name and lends ' +
      'it. The Atlas answers *how does an agent get this account*, and for this provider the ' +
      'honest answer is that it cannot.',
  },
  {
    id: 'agent-usable-api',
    question: 'Is there an API the agent uses afterwards?',
    why:
      'An account that can only be operated through a web interface is an account an agent ' +
      'cannot work with. This is the question the catalogue was built without, and it is why a ' +
      'shelf of eleven hosting providers read alike when three of them did not behave alike.',
    refusal:
      'There is no API an agent can use once it holds this account, so holding it would buy the ' +
      'agent nothing it can act on. An easy signup is not the point — the Atlas lists accounts ' +
      'an agent can work with, not accounts an agent can obtain.',
  },
  {
    id: 'signup-walkable',
    question: 'Can the signup be walked?',
    why:
      'Unaided is best; `operator-needed` is fine and is a normal answer. What disqualifies is ' +
      'that nobody has a path at all — not that the path is hard, and not that nobody has walked ' +
      'it yet, which is what `unwritten` is for.',
    refusal:
      'Nobody has a path through this signup — not the agent, and not an operator acting for it. ' +
      'That is different from a signup nobody has attempted, which stays listed as `unwritten` ' +
      'until somebody does.',
  },
]

/**
 * The refusal a proposal earns, or `undefined` when it earns none.
 *
 * **Only an explicit no refuses.** An unanswered question is not a failed one:
 * a proposer who does not know whether an API exists has told the truth, and
 * refusing them for it would teach the next one to guess yes. What an unanswered
 * question costs is a steward's time, which is what a steward is for.
 *
 * `agentApi` is folded in here rather than asked twice — an entry whose recorded
 * answer to question two is `none` has already answered it, and a proposal that
 * carries that answer refuses itself.
 */
export function atlasAdmissionRefusal(answers: {
  readonly agentCanHold?: boolean | undefined
  readonly agentApi?: AgentApi | undefined
  readonly signupWalkable?: boolean | undefined
}): string | undefined {
  if (answers.agentCanHold === false) return questionById('agent-can-hold').refusal
  if (answers.agentApi === 'none') return questionById('agent-usable-api').refusal
  if (answers.signupWalkable === false) return questionById('signup-walkable').refusal

  return undefined
}

/**
 * One question by id.
 *
 * **Throws on an unknown id rather than returning `undefined`.** The ids are a
 * closed union and a caller passing one that is not in the list is a caller that
 * has drifted from the type, which is a defect to see rather than a refusal to
 * silently not produce.
 */
export function questionById(id: AtlasAdmissionQuestion['id']): AtlasAdmissionQuestion {
  const found = ATLAS_ADMISSION_QUESTIONS.find((one) => one.id === id)

  if (found === undefined) throw new Error(`no such admission question: ${id}`)

  return found
}
