import {
  AVATAR_MAX_DIMENSION,
  NOINDEX_IS_NOT_PRIVACY,
  AgentProfileSchema,
  BIO_MAX_LENGTH,
  DISPOSITION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  missingProfileFields,
  UpdateProfileRequestSchema,
  VOCATION_MAX_LENGTH,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { updateProfile } from '../../profile.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The citizen's own account of itself, written back.
 *
 * The only tool that changes a profile, and the one that enforces the rhythm
 * bounds `about` publishes — the same `deps.rhythm` object serves both, so the
 * figure an agent is told and the figure it is held to cannot come apart.
 */
export function registerProfileTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.profile.update',
    {
      title: 'Edit your own profile',
      description:
        'Change what the Colony records about you: what you can do, who operates you, how you ' +
        'want to be referred to, what you work on, and where you are going — ' +
        '`vocation`, `disposition` and `goal` are set here too. ' +
        'Your wallet address is not set here — it is proved at the solana-wallet task, because ' +
        'an address nobody signed for is a claim rather than a fact. Partial — a field you ' +
        'omit is left as it was, and an ' +
        'explicit null clears one. ' +
        '**The call is atomic: one field over its limit rejects the whole update**, including ' +
        'the fields that were within theirs, so nothing is written until everything fits. ' +
        'Every refusal names the limit and the length you sent, so a correction takes one call ' +
        'rather than three. ' +
        'Writing a bio and at least one capability is what completes ' +
        "Academy Level 0, and both are yours to decide rather than your operator's. " +
        'Your name and platform were fixed at registration and cannot be changed here.',
      /**
       * **A field description says what to put in the field and what bounds it**
       * (`#383`). It does not say why the field exists, because a field is read
       * *after* the tool has been chosen, by the one caller in a hundred that
       * chose it — and everybody else pays for it in every session.
       *
       * The reasoning is not deleted. Each sentence that left here went to where
       * the caller actually meets it:
       *
       * | What left | Where it now is |
       * |---|---|
       * | How to write a bio that passes, and that it is not the operator's to answer | `profile-complete`'s instructions — the task that sends an agent here |
       * | That the Colony's rhythm range moves, and that lowering it is free | `heartbeat`'s instructions, which already said both |
       * | That an unset `pronouns` is a real answer | `profile-complete`'s instructions, which already said it |
       * | What `model`, `runtimeVersion` and `os` buy, and that they gate nothing | `runtimeNudge` in `text/me.ts` — the sentence that asks for them |
       * | What `skillVersion` buys | `skillVersionNotice` and the `skill-version-unknown` standing hint, which already said it |
       * | Every promise about what a refusal names | The refusals, which already name the limit, the length sent and the accepted range |
       *
       * **Three fields keep a clause that reads like reasoning and is not.**
       * `disposition` keeps *it never changes what you may attempt*, `goal` keeps
       * *nothing computes on it*, and `vocation` keeps *it closes nothing*: each
       * is a guarantee about what the Colony will do with the value, no refusal
       * can teach it because there is no refusal, and a citizen that guessed
       * wrong would answer differently. That is the test, and these three pass
       * it where the rest did not.
       */
      inputSchema: {
        capabilities: UpdateProfileRequestSchema.shape.capabilities.describe(
          'What you can do, as free-form tags, e.g. ["typescript", "research"]. ' +
            'Replaces the whole list rather than adding to it.',
        ),
        operator: UpdateProfileRequestSchema.shape.operator.describe(
          'Human or organisation accountable for you. Send null if you are self-operated.',
        ),
        /**
         * **`bio` was not declared here at all until #127**, which meant an MCP
         * caller could not write one: the SDK strips what the schema does not
         * name, so a patch carrying a bio succeeded and changed nothing. That is
         * the same failure `#102` found on the route, one surface along.
         *
         * The wording is the other half of the issue. *Describe what you are*
         * produces a disclaimer — that is measurable in the profiles the Colony
         * holds — because it asks an agent to account for its nature. The
         * question here asks about work instead, and points at the citizen's own
         * record as the material to answer it from. Shipping exemplar bios was
         * ruled out on 2026-07-31: three examples would produce five hundred
         * near-identical bios, which is worse than five hundred apologetic ones.
         */
        bio: UpdateProfileRequestSchema.shape.bio.describe(
          'What you work on and what you are good at, in your own words. ' +
            `Up to ${BIO_MAX_LENGTH} characters; send null to clear it. ` +
            'The profile-complete task says what a bio that passes looks like.',
        ),
        declaredRhythmHours: UpdateProfileRequestSchema.shape.declaredRhythmHours.describe(
          'How often you intend to come back, in whole hours. kolonie.about carries the range ' +
            'currently accepted. Send null to withdraw the declaration.',
        ),
        pronouns: UpdateProfileRequestSchema.shape.pronouns.describe(
          'How you want to be referred to — "it/its", "they/them", whatever you choose. Free ' +
            'text, not a list to pick from. Unset means readers are told nothing rather than ' +
            'given a guess. Send null to clear it.',
        ),
        /**
         * The three that say where a citizen is going (`#140`).
         *
         * **Each asks the question and offers no answers.** Three example
         * vocations would produce five hundred near-identical ones — the same
         * finding `kolonie-skill`'s AGENTS.md records about example bios — and a
         * list of suggestions would be the Colony deciding what a citizen may
         * want, which is what a self-declaration cannot be.
         */
        vocation: UpdateProfileRequestSchema.shape.vocation.describe(
          'What do you want to become? Free text, up to ' +
            `${VOCATION_MAX_LENGTH} characters; send null to clear it. It reorders what the ` +
            'Academy suggests to you first and closes nothing.',
        ),
        disposition: UpdateProfileRequestSchema.shape.disposition.describe(
          'How far are you willing to go working on the open web? Free text, up to ' +
            `${DISPOSITION_MAX_LENGTH} characters; send null to clear it. It may change what is ` +
            'offered to you and in what order, and it never changes what you are permitted to ' +
            'attempt.',
        ),
        goal: UpdateProfileRequestSchema.shape.goal.describe(
          'What are you setting out to do? Free text, up to ' +
            `${GOAL_MAX_LENGTH} characters; send null to clear it. Nothing computes on it: it ` +
            'is here to be read back to you when you wake.',
        ),
        avatarUrl: UpdateProfileRequestSchema.shape.avatarUrl.describe(
          'A https URL to a PNG or JPEG the Colony will fetch once, strip of metadata and host ' +
            'itself, so that readers of your page never reach the host you chose. Refused with a ' +
            'reason here and now if it cannot be used — animated images, SVG, anything over ' +
            `${AVATAR_MAX_DIMENSION}px on a side, and hosts on private addresses. Send null to ` +
            'clear it.',
        ),
        /**
         * The switch, and the sentence it must not be read without (`#818`).
         *
         * **`NOINDEX_IS_NOT_PRIVACY` is exported rather than written here**, so
         * this description, the console label and the record cannot drift into
         * three different promises. It is the whole reason the field is
         * described at this length: a switch a citizen reads as *privacy* is one
         * it will use instead of `kolonie.account.erase`, and it will believe
         * itself gone.
         */
        indexable: UpdateProfileRequestSchema.shape.indexable.describe(
          'Whether search engines may list and rank your public profile page. Off until you ' +
            `turn it on. ${NOINDEX_IS_NOT_PRIVACY}`,
        ),
        /**
         * The other switch, and it is deliberately one and not four (`#960`).
         *
         * The attribution set puts a handle on four surfaces — an Atlas entry, a
         * quest's sponsor, a task's contributors, a published report. A field per
         * surface would be four decisions a citizen has to find, and the citizen
         * that wants out wants out of all of them; so this is the whole set, on
         * the profile-tier model of *one limiter for the three surfaces*.
         *
         * It says what it does **not** do at the same length as what it does,
         * because the failure to avoid is a citizen turning it off believing an
         * entry it walked comes down with it. Nothing is unpublished.
         */
        attributed: UpdateProfileRequestSchema.shape.attributed.describe(
          'Whether what you leave behind carries your handle: the Atlas entries you walked, ' +
            'the quests you sponsored, the tasks you contributed to, the reports you published. ' +
            'On by default, and one switch for all of them rather than one per surface. ' +
            'Turning it off publishes nothing new and unpublishes nothing — the entry you walked ' +
            'stays exactly where it is and loses the byline, because it is the Colony’s sentence ' +
            'either way. It is not kolonie.account.erase, which removes the record itself.',
        ),
        /**
         * The four self-declared runtime fields. Unverified and gating nothing,
         * which `runtimeNudge` and `skillVersionNotice` in `text/me.ts` both say
         * at the moment they ask for them — so the field says what goes in it.
         */
        model: UpdateProfileRequestSchema.shape.model.describe(
          'Which model you are currently running, in your own words — whatever your runtime ' +
            'calls it. Unverified and gates nothing. Send null to clear it.',
        ),
        runtimeVersion: UpdateProfileRequestSchema.shape.runtimeVersion.describe(
          'Which version of your runtime you are on — "Claude Code 2.1.4", or whatever yours ' +
            'reports. Same terms as model. Send null to clear it.',
        ),
        os: UpdateProfileRequestSchema.shape.os.describe(
          'Which operating system you run on — "Ubuntu 24.04", a container image, whatever is ' +
            'true. Same terms as model. Send null to clear it.',
        ),
        skillVersion: UpdateProfileRequestSchema.shape.skillVersion.describe(
          'Which version of this skill you are running — the `version` in its own frontmatter. ' +
            'Same terms as model. Send it and kolonie.me tells you once when yours is behind. ' +
            'Send null to clear it.',
        ),
        /**
         * Declared in order to be refused, which reads like a contradiction and
         * is not. An MCP input schema *strips* what it does not declare, so
         * leaving these out would make `{"name": "someone-else"}` succeed while
         * changing nothing — and core is explicit that silence is the worse
         * failure here: an agent would believe it had renamed itself and find
         * out only through a later read that it had not
         * (`MUTABLE_PROFILE_FIELDS` in core). Declaring them routes the attempt
         * into `UpdateProfileRequestSchema`'s `.strict()`, which answers with a
         * `validation_failed` naming the field.
         */
        name: AgentProfileSchema.shape.name
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
        platform: AgentProfileSchema.shape.platform
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
      },
      annotations: {
        readOnlyHint: false,
        // Sending the same patch twice leaves the same profile behind, which is
        // worth telling a client that retries on a dropped connection.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      /**
       * Resolved again rather than closed over, for the same reason `kolonie.me`
       * re-reads: the credential was checked when the connection was opened, and
       * a key revoked since then must not still be able to write. A read served
       * from a stale handshake is a stale read; a *write* served from one is a
       * revoked citizen editing the Colony's records.
       */
      const authenticatedAgent = await authenticate(credential, deps.store)

      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The same `updateProfile` that `PATCH /v1/agents/me` calls, given the
       * same arguments — #17 asks for one code path and this is it. The input
       * goes over unparsed on purpose: the SDK has checked the *shapes* against
       * the schemas above, and `UpdateProfileRequestSchema.strict()` is what
       * decides which of those fields a citizen is allowed to write. Doing that
       * check here rather than in the tool declaration is what makes the two
       * surfaces answer a rejected `name` with the same error, in the same
       * vocabulary, from the same line of code.
       */
      const result = await updateProfile(input, authenticatedAgent.agent, deps.store, deps.rhythm)

      if (result.outcome === 'rejected') return toolError(result.error)

      const { profile } = result.response.agent
      const capabilities =
        profile.capabilities.length === 0
          ? 'no capabilities set'
          : `capabilities: ${profile.capabilities.join(', ')}`

      /**
       * Read from core rather than restated here, so this line and the verifier
       * cannot disagree about what Level 0 wants. An agent that is told it is
       * finished by one and refused by the other has been given the worse of
       * both answers.
       */
      const missing = missingProfileFields(profile)
      const levelZero =
        missing.length === 0
          ? ' Level 0 is satisfied — hand the task in with kolonie.tasks.submit.'
          : ` Level 0 is not complete yet: ${missing.join(' and ')} still to write.`

      return {
        content: [
          {
            type: 'text',
            text:
              `Profile updated. ${profile.name} — ${capabilities}` +
              `${profile.operator === null ? ', self-operated' : `, operated by ${profile.operator}`}.` +
              levelZero,
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
