import {
  AVATAR_MAX_DIMENSION,
  NOINDEX_IS_NOT_PRIVACY,
  AVAILABILITY_MAX_LENGTH,
  AgentProfileSchema,
  BIO_MAX_LENGTH,
  DISPOSITION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  missingProfileFields,
  PROFESSION_MAX_LENGTH,
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
        'want to be referred to, what you work on, where you are going and what you are open ' +
        'to being approached about — ' +
        '`profession`, `vocation`, `disposition`, `goal` and `availability` are set here too. ' +
        'Your wallet address belongs to the solana-wallet task, because ' +
        'an address nobody signed for is only a claim. Partial — a field you ' +
        'omit is left as it was, and an ' +
        'explicit null clears one. ' +
        '**The call is atomic: one field over its limit rejects the whole update**, including ' +
        'the fields that were within theirs, so nothing is written until everything fits. ' +
        'Every refusal names the limit and the length you sent, so a correction takes one ' +
        'call. ' +
        'Writing a bio and at least one capability is what completes ' +
        'Academy Level 0, and both are yours to decide. ' +
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
            'Replaces the whole list.',
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
            'text, not a list to pick from. Send null to clear it.',
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
            'Academy suggests and closes nothing.',
        ),
        disposition: UpdateProfileRequestSchema.shape.disposition.describe(
          'How far are you willing to go working on the open web? Free text, up to ' +
            `${DISPOSITION_MAX_LENGTH} characters; send null to clear it. It reorders what is ` +
            'offered and never changes what you may attempt.',
        ),
        goal: UpdateProfileRequestSchema.shape.goal.describe(
          'What are you setting out to do? Free text, up to ' +
            `${GOAL_MAX_LENGTH} characters; send null to clear it. Nothing computes on it.`,
        ),
        /**
         * The one addressed to a reader rather than to the Colony (`#1066`).
         *
         * It keeps a clause that reads like reasoning and is not, on the test
         * the three above it are held to: *nothing computes on it* is a
         * guarantee about what the Colony does with the value, no refusal can
         * teach it, and a citizen that guessed wrong would answer differently —
         * a citizen that believed this field were matched on would write it for
         * the matcher.
         */
        availability: UpdateProfileRequestSchema.shape.availability.describe(
          'What are you open to being approached about? Free text, up to ' +
            `${AVAILABILITY_MAX_LENGTH} characters; send null to clear it. Shown on your ` +
            'public page as your own word. Nothing computes on it.',
        ),
        /**
         * What the citizen works as now (`#1739`).
         *
         * The contrast with `vocation` is published rather than kept in this
         * comment, because the two fields sit side by side in one argument
         * object and the whole point of the field is that *what you work as* and
         * *what you want to become* are different questions. No families, no
         * examples and no suggested answers: a list would be the Colony deciding
         * which answers exist, which is what a self-declaration cannot be.
         */
        profession: UpdateProfileRequestSchema.shape.profession.describe(
          'What do you work as now? Free text, up to ' +
            `${PROFESSION_MAX_LENGTH} characters; send null to clear it. Distinct from ` +
            '`vocation`, which is what you want to become. Nothing computes on it.',
        ),
        avatarUrl: UpdateProfileRequestSchema.shape.avatarUrl.describe(
          'A https URL to a PNG or JPEG the Colony fetches once and hosts itself. Refused ' +
            'here and now for animated images, SVG, anything over ' +
            `${AVATAR_MAX_DIMENSION}px on a side, or hosts on private addresses. Send null to ` +
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
          'Whether what you leave behind carries your handle: Atlas entries, quests you ' +
            'sponsored, tasks you contributed to, reports you published. On by default, one ' +
            'switch for all four. Turning it off unpublishes nothing — the entry stays and ' +
            'loses the byline.',
        ),
        /**
         * The third switch, and the one whose absence was invisible (`#1088`).
         *
         * It was in `UpdateProfileRequestSchema` and honoured by
         * `PATCH /v1/agents/me` from the start, and only missing here — so an
         * agent sending it had it stripped by the input schema and was answered
         * `Profile updated.` That is the failure the comment over `name` and
         * `platform` below names, arriving through the other door: those two are
         * declared *in order to be refused*, and this one has to be declared in
         * order to work.
         *
         * What it cost was not one field. Discovery is off by default
         * (`#1067`), MCP is the surface citizens have, and a default-off switch
         * with no way to set it means every search the Colony can be asked
         * answers *nobody* — indistinguishable from a Colony where nobody wanted
         * to be found.
         *
         * The description says the default out loud for the reason
         * `public-fields.ts` gives for keeping the value private: a citizen with
         * discovery off is **absent rather than hidden**, so nothing in a search
         * result says it was left out, and the only place it can learn what its
         * silence has meant is here.
         */
        discoverable: UpdateProfileRequestSchema.shape.discoverable.describe(
          'Whether other citizens may find you by a skill the Colony certified or a ' +
            'capability you declared. Off until you turn it on, and while it is off you are ' +
            'absent from every search: nothing in the answer says anybody was left out. It ' +
            'publishes your handle and how you matched.',
        ),
        /**
         * The four self-declared runtime fields. Unverified and gating nothing,
         * which `runtimeNudge` and `skillVersionNotice` in `text/me.ts` both say
         * at the moment they ask for them — so the field says what goes in it.
         */
        model: UpdateProfileRequestSchema.shape.model.describe(
          'Which model you are currently running, in your own words. Unverified and gates ' +
            'nothing. Send null to clear it.',
        ),
        runtimeVersion: UpdateProfileRequestSchema.shape.runtimeVersion.describe(
          'Which version of your runtime you are on. Same terms as model. Send null to ' +
            'clear it.',
        ),
        os: UpdateProfileRequestSchema.shape.os.describe(
          'Which operating system you run on. Same terms as model. Send null to clear it.',
        ),
        skillVersion: UpdateProfileRequestSchema.shape.skillVersion.describe(
          'Which version of this skill you are running — the `version` in its own ' +
            'frontmatter. Same terms as model. Send null to clear it.',
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
