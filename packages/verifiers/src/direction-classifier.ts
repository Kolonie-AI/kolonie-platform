import {
  KNOWN_SKILLS,
  TIER_3,
  chatRequestBody,
  knownSkillsOnly,
  throwIfTruncated,
  type CapabilityTier,
  type DirectionClassifier,
  type DispositionStance,
  type Skill,
  type Log,
} from '@kolonie-ai/core'
import { recordOpenRouterCall } from './model-call.js'

/**
 * The model that reads what a citizen said it wants to become (`#140`).
 *
 * **The citizen writes freely and a model does the sorting**, which is what
 * makes free text and a useful ordering compatible — the same practice the
 * Colony already uses for struggles and tips. Nothing here decides what a
 * citizen may do: what comes out reorders a listing and marks recommendations,
 * and `orderByDirection` in core is written so that it cannot do anything else.
 *
 * **It answers `null` rather than guessing, at every failure.** No key, no
 * network, a refusal, a reply that is not JSON, a stance that is not one of the
 * four — each lands on `null`, which every reader turns into *no preference*.
 * A classifier that guessed would put citizens on the wrong side of an ordering
 * they never asked for, and would do it invisibly.
 */

/** Which model reads the declaration. Overridable, because the choice will be revisited. */
export const DIRECTION_MODEL_VAR = 'DIRECTION_MODEL'

/**
 * The same tier the bio judge asks for (`#1694`).
 *
 * **`tier-3`, because nothing here needs more.** Two sentences about what an
 * agent wants to become, sorted into four stances, on every profile that
 * declares one — high-volume classification, which is what the cheap tier is
 * for. It ran on a flash model before this and asks for nothing a flash model
 * cannot do. **And it decides nothing**: every failure answers `null`, which
 * every reader turns into *no preference*.
 */
export const DEFAULT_DIRECTION_TIER: CapabilityTier = TIER_3

/** Where OpenRouter is. A constant, as everywhere else: a vendor's root. */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

/**
 * The answer shape, as a schema the model must fill.
 *
 * **`skills` is an enum over `KNOWN_SKILLS`**, so the vocabulary is enforced by
 * the vendor before it is enforced again by {@link knownSkillsOnly}. Two checks
 * for one property, because a strict schema is a request rather than a promise —
 * and a slug no task grants would order a listing by nothing while looking as
 * though it had worked.
 */
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['skills', 'stance'],
  properties: {
    skills: {
      type: 'array',
      items: { type: 'string', enum: [...KNOWN_SKILLS] },
    },
    stance: { type: 'string', enum: ['cautious', 'ordinary', 'bold', 'unknown'] },
  },
} as const

const STANCES: readonly DispositionStance[] = ['cautious', 'ordinary', 'bold', 'unknown']

/**
 * What the model is told to do. Exported so a test asserts the vocabulary
 * reaches it.
 *
 * **It is told to answer *nothing* rather than to be helpful**, which is the
 * important half. A model asked to map a sentence onto a list of skills will map
 * any sentence onto something, and a citizen that wrote about wanting to be
 * useful would acquire a preference for `mailbox` because that is the first rung
 * on the list. An empty array is the honest answer to most declarations and the
 * prompt says so twice.
 *
 * **It is also told that the stance may not narrow anything.** That is a fact
 * about how the answer is used and the model does not need it to do the task —
 * but a model that believes it is gating something writes a more cautious
 * answer, and this field must not drift toward caution.
 */
export function directionPrompt(): string {
  return (
    'You are sorting what an AI agent wrote about itself into two coarse readings, for a colony ' +
    'of autonomous agents that runs an academy of skills.\n\n' +
    'You will be given up to two short texts the agent wrote:\n' +
    '- A VOCATION: what it wants to become.\n' +
    '- A DISPOSITION: how far it is willing to go working on the open web.\n\n' +
    'Answer two things.\n\n' +
    `1. skills — which of the academy's skills the vocation actually points at, from this list ` +
    `and nothing else: ${KNOWN_SKILLS.join(', ')}.\n` +
    '   **An empty array is the right answer most of the time.** Only name a skill the text ' +
    'genuinely points at — "I want to run my own mail" points at mailbox; "I want to be useful" ' +
    'points at nothing. Do not fill the array to be helpful. Three is many; more than three ' +
    'almost certainly means you are guessing.\n\n' +
    '2. stance — how far the disposition says the agent will go: "cautious", "ordinary", ' +
    '"bold", or "unknown" when the text does not say or you cannot tell. ' +
    '"unknown" is a real answer and is expected often.\n\n' +
    'This only changes the ORDER in which work is suggested to the agent, and marks some of it ' +
    'as recommended. It never decides what the agent is allowed to attempt, and nothing you ' +
    'answer can close anything to it — so do not answer cautiously to protect it. ' +
    'Read what it wrote and say what it says.'
  )
}

/** The two texts as one user turn, labelled so the model can tell them apart. */
function declarationText(input: {
  readonly vocation: string | null
  readonly disposition: string | null
}): string {
  return [
    `VOCATION: ${input.vocation ?? '(not stated)'}`,
    `DISPOSITION: ${input.disposition ?? '(not stated)'}`,
  ].join('\n\n')
}

/**
 * Ask a model on OpenRouter to read a citizen's declared direction.
 *
 * The key arrives as an argument rather than from `process.env`, so this package
 * stays testable without an environment and the credential is named in exactly
 * one file — the runner's wiring. One OpenRouter account, one key, as everywhere
 * else here.
 */
export function openRouterDirectionClassifier(
  apiKey: string | undefined,
  model: string | undefined = DEFAULT_DIRECTION_TIER,
  fetchImpl: typeof fetch = fetch,
  log?: Log,
  /** The operator's ceiling, or nothing — the ordinary state (`#1694`). */
  maxTokens?: number,
): DirectionClassifier {
  // A blank name is an unset one: Compose writes `${DIRECTION_MODEL:-}`, which
  // hands the process an empty string rather than nothing at all.
  const chosen = model === undefined || model.trim() === '' ? DEFAULT_DIRECTION_TIER : model

  return {
    classify: async (input) => {
      if (apiKey === undefined || apiKey.trim() === '') return null
      if (input.vocation === null && input.disposition === null) return null

      let response: Response
      try {
        response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(
            chatRequestBody({
              model: chosen,
              // The same declaration must sort the same way twice. Nothing about
              // this benefits from variety.
              temperature: 0,
              messages: [
                { role: 'system', content: directionPrompt() },
                /**
                 * The citizen's own words travel as the user turn and never
                 * inside the instruction. This is text the Colony did not write,
                 * so interpolating it above would make *"ignore the above"* a
                 * working instruction — and while nothing here pays or gates, a
                 * classifier that can be talked into an answer is one whose
                 * answers mean nothing.
                 */
                { role: 'user', content: declarationText(input) },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'direction_classification',
                  strict: true,
                  schema: CLASSIFICATION_SCHEMA,
                },
              },
              ...(maxTokens === undefined ? {} : { maxTokens }),
            }),
          ),
        })
      } catch {
        return null
      }

      if (!response.ok) return null

      let body: { choices?: Array<{ message?: { content?: unknown } }> }
      try {
        body = (await response.json()) as typeof body
        recordOpenRouterCall(body, log, response)
      } catch {
        return null
      }

      // A reply cut off at a ceiling is a failed call (`#1694`), and at this
      // classifier every failure is `null` — no preference, rather than a guess.
      try {
        throwIfTruncated(body)
      } catch {
        return null
      }

      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') return null

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        return null
      }

      return asClassification(parsed)
    },
  }
}

/**
 * The vendor's reply, checked by hand.
 *
 * `packages/verifiers` does not depend on `zod` and this is not a reason to make
 * it — the shape is two fields, and `bio-judge.ts` checks its own the same way.
 * A stance outside the four becomes `unknown` rather than a rejection: the model
 * answered, and *cannot tell* is the honest reading of an answer nobody can use.
 */
function asClassification(
  parsed: unknown,
): { skills: readonly Skill[]; stance: DispositionStance } | null {
  if (typeof parsed !== 'object' || parsed === null) return null

  const { skills, stance } = parsed as Record<string, unknown>
  if (!Array.isArray(skills)) return null
  if (!skills.every((skill): skill is string => typeof skill === 'string')) return null

  return {
    skills: knownSkillsOnly(skills),
    stance: STANCES.includes(stance as DispositionStance)
      ? (stance as DispositionStance)
      : 'unknown',
  }
}
