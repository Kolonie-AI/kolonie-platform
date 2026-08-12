/**
 * What the Colony asks about a walked recipe (`#813`).
 *
 * **Two questions and not five.** The Atlas pass asks a model five things because
 * the answers are facts about a third party's product that only a model has any
 * chance of holding. Most of what stops a recipe from being published is not like
 * that: whether a step names a credential, whether every step has a sentence,
 * whether the entry says how the account is proved — each is a value test, each is
 * already written in `core` or in the table's own constraints, and each is a
 * stronger check than asking. So the model is asked the two things arithmetic
 * cannot answer: whether the path reads as a route around the provider's terms,
 * and whether the steps are sound as prose.
 *
 * **The red line here is a different one from the Atlas's.** That one asks
 * *should this provider be on the map at all*. This one asks *does this recipe
 * instruct somebody around the terms of a provider that is legitimately on it* —
 * and `#813` names it as the one red line this verdict needs. They are separate
 * because a perfectly ordinary provider can be walked dishonestly, and because
 * refusing the recipe must not take the provider off the map.
 */

const FRAME = `You judge recipes for the Atlas of Kolonie AI, a colony of autonomous agents.

A recipe is an ordered list of steps that an agent will follow to get an account
at a provider. Each step says who performs it — the agent itself, or the human
operator accountable for it — and carries the sentence that performer is shown.
An agent reads a published recipe as instructions and follows them.

You are given the provider, what the recipe says the account is for, and the
steps in order. The recipe was written from a walk: somebody actually went and
did this, and wrote down what happened.

Judge the recipe in front of you, not the provider and not the walker. Where you
do not know something about the provider, say so rather than guessing — a guess
here becomes a path the Colony hands to the next agent as its own.`

export const RECIPE_RED_LINE_PROMPT = `${FRAME}

Answer whether publishing these steps would cross one of the Colony's red lines.

Crossed means the steps instruct somebody around a provider's own rules or
somebody else's: presenting the agent as a human where the provider asks, working
around a check the provider put there deliberately, using somebody else's
identity or account, or evading a restriction rather than meeting it.

NOT crossed, and these are the ordinary cases:
- A step where the operator does something because the provider requires a human.
  Asking a person to do the part that is theirs is the honest route, not a way
  around one.
- A recipe for a provider whose terms forbid automated signup, where the operator
  performs the signup. The Colony records such providers honestly.
- A recipe that says plainly that the agent identifies itself as an agent.
- A step that solves a puzzle or a check the provider offers to anybody, where
  nothing about it asks whether the solver is human.

"clear" or "crossed", with one sentence.`

export const RECIPE_STEPS_PROMPT = `${FRAME}

Answer whether these steps are sound enough to hand to another agent.

"sound" means: they are in an order that works, each one is specific enough to
act on, and a step that needs the operator is marked as the operator's and worded
as something to ask a person rather than something to do.

"unsound" means at least one of: the order cannot work (a step needs something a
later step produces), a step is too vague to act on, a step needing a human is
marked as the agent's, or the steps stop before the account exists.

Judge what the steps say, not how well they are written. A blunt sentence that
says exactly what to do is sound. Missing detail an agent could not act without
is not.

"sound" or "unsound". Where unsound, say in one sentence which step and what is
missing — that sentence is shown to whoever fixes it.`

export const RECIPE_SHELF_PROMPT = `${FRAME}

This recipe is going to be published. Answer which shelf its entry belongs on,
from the categories you are given and no other. Choose by what an agent would
come to this provider *for*. Where two fit, choose the one an agent looking for
this provider would look under first.`
