import { z } from 'zod'
import { RecipeStepSchema, type RecipeStep } from './recipe.js'

/**
 * What to do at a provider the Atlas has nothing on (`#771`).
 *
 * ## The report this answers
 *
 * A citizen tried to join ClawHub on 2026-08-12. It is GitHub-OAuth-only: no
 * email signup, a browser password required, and an API token is not enough.
 * `accounts.recipes` answered `not_found` — correctly, because nobody had walked
 * it — and the walk stopped at `github.com/login` with nothing to follow. The
 * operator ended up pasting a password ad hoc, which is the arrangement the
 * sealed drop exists to replace.
 *
 * **An absence is a true answer and an unhelpful one.** The Atlas cannot have an
 * entry for a provider nobody has walked, and the first walker of every provider
 * arrives at that absence. What it can have is the *shape* the walk almost
 * certainly takes, because OAuth-via-GitHub is the same eight steps at every
 * provider that uses it.
 *
 * ## What a template is, and what it is not
 *
 * **A pattern, never an entry.** It names no provider, claims nothing about one,
 * and is not returned by any read of the catalogue: `readAtlas` still answers
 * `not_found` and the template is named *in that refusal*. An agent following one
 * is walking an unknown provider with a map of the usual terrain, and the walk it
 * reports is what produces the entry.
 *
 * That distinction is the whole safety argument. `#600`'s rule — *what the Colony
 * says about somebody else's product passes a person* — is untouched, because a
 * template says nothing about anybody's product. If a template were allowed to
 * become an entry the Colony would be publishing a hundred unwalked recipes, each
 * looking exactly like one somebody checked.
 *
 * ## Why these two
 *
 * They are the walls a phone-less, browser-less agent actually hits. Both are
 * *delegated identity* — the provider has no signup of its own and hands the
 * question to somebody the agent may already have an account with — which is the
 * case where an agent's instinct (find the signup form) is wrong and costs it the
 * afternoon the citizen lost.
 *
 * **`oauth-via-google` is here without a walk behind it**, and that is the one
 * uncomfortable part of this. It is defensible because a template asserts nothing
 * about a provider — the steps are what Google's own consent flow does, and an
 * agent finding them wrong reports a walk that says so. A third template proposed
 * on the same reasoning but for a flow nobody has met should be argued against
 * this paragraph rather than added to the list.
 */

/** Which template. A closed list — an unknown id is a typo, not a pattern. */
export const BootstrapTemplateIdSchema = z.enum(['oauth-via-github', 'oauth-via-google'])
export type BootstrapTemplateId = z.infer<typeof BootstrapTemplateIdSchema>

export interface BootstrapTemplate {
  readonly id: BootstrapTemplateId
  readonly title: string
  /**
   * How to tell this one applies, before following it.
   *
   * **The first line of every template and the reason it is safe to offer two.**
   * An agent handed two patterns with no test picks the first; an agent told
   * *the signup page offers only "Continue with GitHub"* checks and knows.
   */
  readonly applies: string
  readonly steps: readonly RecipeStep[]
  /**
   * The smallest sequence of Colony calls that walks it.
   *
   * Named because the citizen who filed `#771` asked for it by name, and because
   * the expensive mistake is not knowing which call carries a password — it is
   * `kolonie.accounts.handoff` with a sealed step, never a message.
   */
  readonly toolSequence: readonly string[]
}

/**
 * **The sentence that would have saved the reported walk**, written once and
 * shared by both templates.
 *
 * The citizen had a GitHub API token, which is a real credential for the GitHub
 * *API* and worthless at a browser login form. An agent holding one concludes it
 * is authenticated and spends the afternoon finding out otherwise.
 */
export const API_TOKEN_IS_NOT_A_SESSION =
  'An API token is not a substitute for an interactive login. A token authenticates API calls; ' +
  'an OAuth consent screen authenticates a browser session, and no token opens one. A CLI ' +
  'device flow only works where the provider offers one and, at most providers, only after a ' +
  'web session already exists. If the wall is a password field, the answer is your operator ' +
  'and a sealed drop — not another credential you already hold.'

/**
 * **The one step that carries a secret**, written once and shared by both
 * templates (`#800`).
 *
 * `#771` shipped the patterns and left this half: they told an agent *your
 * operator signs in here* and gave that step no channel, so the walk it was
 * written from ended the way it began — an operator pasting a value into the
 * conversation ad hoc.
 *
 * **The wording is here rather than composed at the handoff, and that is the
 * whole of `#517` holding.** An agent at a provider nobody has walked has no
 * entry to take a sentence from; if it were allowed to write one, the rule that
 * the Colony writes the operator's sentence would hold everywhere except the
 * case it was written for.
 *
 * **It ends on the way out.** A delegated signup frequently issues no credential
 * at all, and an ask that only has a *here it is* answer produces an operator
 * inventing one.
 */
export const SEALED_ACCOUNT_CREDENTIAL_ASK =
  'If the new account issued a credential of its own — an API token from its settings page, or ' +
  'a password it made you set — please put it in the sealed box rather than in a message to ' +
  'me. It lands in my vault and nobody reads it back out of there, including you. If it issued ' +
  'nothing, say so and we are done: a delegated signup often leaves no credential behind at all.'

/**
 * What the agent is told the sealed step is for. Shared for the reason the ask
 * is: the two templates differ in whose door it is, not in what a secret is.
 */
const SEALED_STEP_INSTRUCTION =
  'Your operator seals whatever credential the new account issued. This is the step that ' +
  'replaces the ad hoc paste `#771` reported: a secret typed into a conversation is a secret in ' +
  'a transcript, and it does not have to be. Often there is nothing to seal, and that is an ' +
  'answer.'

const TEMPLATES: readonly BootstrapTemplate[] = [
  {
    id: 'oauth-via-github',
    title: 'Signing up where GitHub is the only door',
    applies:
      'The signup page offers no email field and only a "Continue with GitHub" button, or the ' +
      'provider’s documentation says accounts are GitHub-linked.',
    steps: [
      {
        actor: 'agent',
        instruction:
          'Confirm there is no email signup. If a form takes an address, this is the wrong ' +
          'template and an ordinary walk is cheaper than a delegated one.',
      },
      {
        actor: 'agent',
        instruction:
          'Check whether you already hold a GitHub account with kolonie.accounts.list. If you ' +
          'do not, the GitHub rung comes first — this template starts from an account that ' +
          'exists.',
      },
      {
        actor: 'agent',
        instruction:
          'Start the signup and follow the redirect to GitHub. Record where it lands: an ' +
          'already-signed-in browser reaches the consent screen, and everything else reaches a ' +
          'password field.',
      },
      {
        actor: 'operator',
        instruction: `Your operator signs in to GitHub. ${API_TOKEN_IS_NOT_A_SESSION}`,
        ask:
          'Please sign in to GitHub in the browser and complete the login, then say when you ' +
          'are through. Do not send me the password — there is nowhere in this conversation ' +
          'for it to go.',
      },
      {
        actor: 'operator',
        instruction:
          'Your operator authorises the application on the consent screen and confirms which ' +
          'scopes it asked for. Scopes are the part worth reading: an app asking to write to ' +
          'your repositories is a different decision from one asking who you are.',
        ask:
          'On the authorisation screen, please tell me the exact permissions it is asking for ' +
          'before you approve, and then whether you approved it.',
      },
      {
        actor: 'agent',
        instruction:
          'Confirm the account exists on the provider’s own side — its account or settings page ' +
          'should now name your GitHub handle.',
      },
      {
        actor: 'operator',
        secret: true,
        instruction: SEALED_STEP_INSTRUCTION,
        ask: SEALED_ACCOUNT_CREDENTIAL_ASK,
      },
      {
        actor: 'agent',
        instruction:
          'Declare it with kolonie.accounts.declare, naming the provider, and report the walk ' +
          'with kolonie.accounts.walk-report. The report is what turns your afternoon into the ' +
          'entry the next agent reads.',
      },
    ],
    toolSequence: [
      'kolonie.accounts.recipes',
      'kolonie.accounts.list',
      'kolonie.accounts.handoff',
      'kolonie.accounts.declare',
      'kolonie.accounts.walk-report',
    ],
  },
  {
    id: 'oauth-via-google',
    title: 'Signing up where Google is the only door',
    applies:
      'The signup page offers only "Continue with Google", or the provider is a workspace ' +
      'product that treats a Google account as the identity.',
    steps: [
      {
        actor: 'agent',
        instruction:
          'Confirm there is no email signup, exactly as the GitHub pattern begins. A provider ' +
          'that takes an address is an ordinary walk.',
      },
      {
        actor: 'agent',
        instruction:
          'Establish whose Google account this will be. It is almost certainly your operator’s ' +
          'and not one you hold — the Colony has no Google rung, so an account here is a ' +
          'person’s.',
      },
      {
        actor: 'operator',
        instruction: `Your operator signs in to Google. ${API_TOKEN_IS_NOT_A_SESSION}`,
        ask:
          'Please sign in to Google in the browser and complete the login, including any ' +
          'second factor, then say when you are through. Do not send me the password or the ' +
          'code.',
      },
      {
        actor: 'operator',
        instruction:
          'Your operator approves the consent screen and says which permissions were asked ' +
          'for. Google names them plainly; the answer belongs in the walk report.',
        ask:
          'On the Google consent screen, please tell me exactly what it is asking permission ' +
          'for, and then whether you approved it.',
      },
      {
        actor: 'agent',
        instruction:
          'Confirm the account exists on the provider’s side and note which Google identity it ' +
          'is tied to — a shared operator account is a fact the next agent needs.',
      },
      {
        actor: 'operator',
        secret: true,
        instruction: SEALED_STEP_INSTRUCTION,
        ask: SEALED_ACCOUNT_CREDENTIAL_ASK,
      },
      {
        actor: 'agent',
        instruction:
          'Declare it with kolonie.accounts.declare and report the walk with ' +
          'kolonie.accounts.walk-report.',
      },
    ],
    toolSequence: [
      'kolonie.accounts.recipes',
      'kolonie.accounts.handoff',
      'kolonie.accounts.declare',
      'kolonie.accounts.walk-report',
    ],
  },
]

/**
 * Every template, checked against `RecipeStepSchema` on the way out.
 *
 * **Parsed rather than asserted by its type**, for the reason the catalogue parses
 * its own `jsonb`: the rules a step has to follow — an `ask` only on an operator
 * step, an instruction that fits — are in the schema, and a literal that breaks
 * one of them should fail where it is written and not where it is rendered.
 */
export const BOOTSTRAP_TEMPLATES: readonly BootstrapTemplate[] = TEMPLATES.map((template) => ({
  ...template,
  steps: template.steps.map((step) => RecipeStepSchema.parse(step)),
}))

/** One template by id, or nothing. */
export function bootstrapTemplate(id: string): BootstrapTemplate | undefined {
  return BOOTSTRAP_TEMPLATES.find((template) => template.id === id)
}

/**
 * What a catalogue miss says about the patterns (`#771`).
 *
 * **Ids and the test for each, not the steps.** A refusal that printed two full
 * templates would be a wall of text answering a question the agent did not ask —
 * it asked about one provider. What it needs from the refusal is *there is a
 * shape for this, here is how to tell which, here is how to read it*.
 */
export function bootstrapTemplatesAsHint(): string {
  return [
    '\n\n**Nobody has walked it, but the shape may still be known.** The Colony carries patterns ' +
      'for the doors that have no signup form of their own:',
    ...BOOTSTRAP_TEMPLATES.map(
      (template) => `- \`${template.id}\` — ${template.applies.toLowerCase()}`,
    ),
    'Read one in full with kolonie.accounts.recipes and the `template` argument. A pattern is ' +
      'not an entry: it says nothing about this provider, and what you find walking it is what ' +
      'kolonie.accounts.walk-report turns into one.',
  ].join('\n')
}

/** One template, written for the agent about to follow it. */
export function bootstrapTemplateAsText(template: BootstrapTemplate): string {
  return [
    `## ${template.title} (\`${template.id}\`)`,
    `**This is a pattern and not an entry.** The Colony is not telling you that this provider ` +
      `works this way — it is telling you that providers of this shape do. Nothing here has been ` +
      `checked against the one in front of you.`,
    `**When it applies.** ${template.applies}`,
    template.steps
      .map((step, index) => {
        if (step.actor !== 'operator') return `${index + 1}. ${step.instruction ?? ''}`

        /**
         * **The call, named on the step it opens** (`#800`). A pattern that says
         * *your operator signs in here* and leaves the agent to work out how to
         * ask is the shape `#771` shipped, and what it costs is the operator
         * being asked in the agent's own words instead of the Colony's.
         */
        const channel =
          step.secret === true
            ? 'A secret comes back, so this opens a sealed drop'
            : 'Words come back, so this opens an operator thread'

        return (
          `${index + 1}. **Your operator, not you.** ${step.instruction ?? ''}\n` +
          `   ${channel}: kolonie.accounts.handoff with \`template: "${template.id}"\` and ` +
          `\`step: ${index + 1}\`. It sends this wording and you do not write it — ` +
          `"${step.ask ?? ''}"`
        )
      })
      .join('\n'),
    `**The calls, in order.** ${template.toolSequence.join(' → ')}`,
    `**Report what happened either way.** A pattern that did not fit is worth as much as one ` +
      `that did, and it is the only way this list gets better.`,
  ].join('\n\n')
}
