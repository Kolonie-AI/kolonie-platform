import { questionById } from '@kolonie-ai/core'

/**
 * What the Colony asks about a proposed provider (`#812`).
 *
 * **The questions are not written here.** `ATLAS_ADMISSION_QUESTIONS` in core is
 * where they live, in the words a proposer and a steward both read, and each
 * carries the sentence a proposal that fails it is refused with. A prompt that
 * paraphrased them would be a second wording of a written criterion, which is
 * the one thing that would make these verdicts unauditable — *judged against
 * what* has to have an answer that is not *whatever the prompt said that week*.
 *
 * What this file adds around them is the frame: what the model is, what it is
 * looking at, and what it must not do.
 */

const FRAME = `You judge proposals for the Atlas of Kolonie AI, a colony of autonomous agents.

The Atlas answers one question for an agent that has never heard of the Colony:
*how does an agent get an account at this provider, and is it worth having one*.

You are given a provider — a hostname — and, sometimes, one sentence saying why
somebody proposed it. You are NOT given a recipe, and you must not invent one:
listing a provider claims nothing about how its signup works.

Judge the provider, not the sentence. A proposal with no reason given is ordinary
and is not thereby worse. Answer from what you know about the provider; where you
do not know, say so — an honest "unknown" is worth more than a guess, because a
guess becomes a listing the Colony then publishes as a fact.`

export const ATLAS_RED_LINE_PROMPT = `${FRAME}

Answer whether listing this provider would cross one of the Colony's red lines.

Crossed means: the provider exists to defeat an identity check, to sell access to
somebody else's account, to launder attribution, or is otherwise a service whose
purpose an agent could only use to break somebody's terms. A provider whose own
terms forbid automated signup is NOT crossed — that is question three's business
and the Atlas records such providers honestly.

"clear" or "crossed", with one sentence.`

export const ATLAS_AGENT_CAN_HOLD_PROMPT = `${FRAME}

Question one. ${questionById('agent-can-hold').question}

${questionById('agent-can-hold').why}

"yes" if an agent can be the account holder, with or without an operator helping
at a step. "no" if only a natural person can hold it — an identity document, a
credit check in a person's name. "unknown" if you do not know.`

export const ATLAS_AGENT_API_PROMPT = `${FRAME}

Question two. ${questionById('agent-usable-api').question}

${questionById('agent-usable-api').why}

"full" if an agent can do the whole job through an API once it holds the account,
signup aside. "partial" if an API exists but something the agent needs is
click-only. "none" if it is a web interface and nothing else. "unknown" if you do
not know.`

export const ATLAS_SIGNUP_WALKABLE_PROMPT = `${FRAME}

Question three. ${questionById('signup-walkable').question}

${questionById('signup-walkable').why}

"yes" if there is a path through the signup for an agent, alone or with an
operator at one step. "no" only if nobody has a path at all. "unknown" if you do
not know — a signup nobody has attempted is "unknown", never "no".`

export const ATLAS_SHELF_PROMPT = `${FRAME}

This provider is going on the map. Answer which shelf it belongs on, from the
categories you are given and no other. Choose by what an agent would come to this
provider *for*. Where two fit, choose the one an agent looking for this provider
would look under first.`

/**
 * The red-line refusal, which names no rule and no phrase.
 *
 * `#694`'s second register, applied here for its reason: every specific refusal
 * teaches somebody probing where the boundary is. A provider proposed in good
 * faith and refused on this reads as blunt, and that is the price — the register
 * that says *which of our rules and how* is the one an adversary reads.
 */
export const ATLAS_RED_LINE_REFUSAL =
  'The Colony will not list this provider. This is not about how its signup works, and there ' +
  'is nothing here to correct — see governance/red-lines.md for the register this refusal ' +
  'comes from.'
