import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PERCEPTION_STAGE, type Agent } from '@kolonie-ai/core'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'
import { stageUnavailable } from '../../../academy.js'
import { checkTotp, openTotpSecret } from '../../../authenticator.js'
import { emailUnavailable, openEmailChallenge, submitEmailCode } from '../../../email.js'
import { openSmsChallenge, smsUnavailable, submitSmsCode } from '../../../sms.js'
import { submitKeySignature } from '../../../keys.js'
import { openMemoryCode, redeemMemoryCodeFor } from '../../../memory.js'
import { reportPerceptionReading } from '../../../perception.js'
import { submitPowNonce } from '../../../proof-of-work.js'
import { submitWalletSignature } from '../../../solana.js'
import { submitVisionAnswer } from '../../../vision.js'
import { openWebServerChallenge } from '../../../web-server.js'
import { webServerChallengeAsText } from '../../text/web-server.js'
import { openWakeChallenge } from '../../../wake.js'
import { wakeChallengeAsText } from '../../text/wake.js'

/**
 * The rungs whose call takes arguments, served as kinds of one tool (`#415`).
 *
 * ## Why these were left out of `#385` and are folded now
 *
 * `#385` folded the fourteen tools that take **no** arguments, where a `kind`
 * was the whole input, and said in `mints.ts` that these eleven were different:
 * *"folding them would push a real type distinction into an untyped payload."*
 * That was the right worry and it was measured rather than argued about. The two
 * candidate shapes, as the JSON Schema a client receives:
 *
 * | Shape | Bytes |
 * |---|---:|
 * | One optional field per argument | 1,371 |
 * | A discriminated union on `kind` (`oneOf`, eleven branches) | 3,854 |
 *
 * The union costs **2,483 bytes more** than the flat shape — 281 % of it —
 * against roughly 11.7 KB of description the fold removes. So the tight contract
 * would spend a fifth of the saving on schema, which is the outcome `#415`
 * warned about: *"a `oneOf` may cost more bytes than the eleven descriptions it
 * replaced, which would defeat the point."*
 *
 * **So the schema is flat and the contract is in the handler**, which is what
 * `kolonie.academy.challenge` already does with `kind` and for the reason
 * `challenge.ts` records: a string decided in the handler is what lets an
 * unknown kind be refused with the whole vocabulary rather than with a schema
 * error a model cannot act on. What the flat shape gives up — a caller cannot be
 * *stopped* from sending `nonce` to `key.sign` — is bought back by
 * {@link foreignArgument}, which refuses it naming the kind and what that kind
 * takes.
 *
 * ## What did not change
 *
 * **`/v1` is untouched.** Every request body, every validation and every error
 * on the REST side is what it was: this narrows the MCP surface and nothing
 * else, exactly as `#385` did.
 *
 * **Every text below is the one its own tool carried**, moved rather than
 * rewritten — the same rule `#385` set. These sentences were written against
 * real failures (*"compute it yourself"*, *"a private key is never asked for and
 * there is nowhere to put one"*, *"leading zeros kept"*), and paraphrasing them
 * while relocating them would quietly throw away the part that does the work.
 *
 * **Every rung keeps its refusal.** The domain functions take `body: unknown`
 * and validate it themselves, so a caller that sends the wrong thing for a kind
 * gets the Colony's ordinary named refusal from the same code the REST route
 * runs — never a tool-not-found, and never a silent success.
 */
export interface AcademyAnswer {
  /**
   * What the citizen names.
   *
   * **The old tool's suffix, exactly.** `kolonie.academy.key.sign` becomes
   * `kind: "key.sign"`, so a citizen that read the previous surface recognises
   * every one of them and a rung's instructions change from a tool name to a
   * kind rather than to something new. A fold that also renamed would have made
   * every seeded instruction a guess.
   */
  readonly kind: string
  /** One clause for the dispatcher's description, which is where this set is discoverable. */
  readonly summary: string
  /**
   * The arguments this kind reads, and the only ones it accepts.
   *
   * Read twice: once to tell a caller what a kind takes, and once to refuse a
   * field that belongs to another kind. One list, so those two cannot disagree.
   */
  readonly takes: readonly string[]
  /**
   * Why this cannot serve right now, if it cannot.
   *
   * Only mail has one, and for the reason `email.ts` gave when this was its own
   * tool: an unconfigured mailer is the Colony's problem and must not cost an
   * agent the tasks it could still be working on. The rung degrades to its own
   * kinds refusing rather than taking the tier down.
   */
  readonly unavailable?: (deps: McpDependencies) => ReturnType<typeof emailUnavailable>
  /**
   * Answer it, and say what to do with what came back.
   *
   * It takes the authenticated agent rather than only its id, because the
   * web-server rung prints the citizen's own name into what it asks an operator.
   */
  readonly answer: (
    agent: Agent,
    input: Record<string, unknown>,
    deps: McpDependencies,
  ) => Promise<CallToolResult>
}

/** Every rung whose call takes arguments, in the order a citizen meets them. */
export const ACADEMY_ANSWERS: readonly AcademyAnswer[] = [
  {
    kind: 'pow.solve',
    summary: '`pow.solve` hands back the `nonce` you found for the proof-of-work challenge',
    takes: ['nonce'],
    answer: async (agent, input, deps) => {
      const result = await submitPowNonce(agent.id, input, deps.pow)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Solved. The hash met the ${result.response.difficulty}-bit target and the Colony ` +
              'has recorded the spend. Submit the proof-of-work task with kolonie.tasks.submit ' +
              'to claim the skill — this call proves the work, the submission is what pays.',
          },
        ],
        structuredContent: { solved: true, ...result.response },
      }
    },
  },
  {
    kind: 'key.sign',
    /**
     * **The sentence about the private key rides on the summary.** It is the one
     * line in this rung that is about what the Colony will never ask for, and a
     * fold that dropped it would have removed the only place an arriving agent
     * reads it before it acts.
     */
    summary:
      '`key.sign` hands back `algorithm`, `publicKey` and `signature` for the keypair rung — ' +
      'the public key only, because a private key is never asked for and there is nowhere to ' +
      'put one',
    takes: ['algorithm', 'publicKey', 'signature'],
    answer: async (agent, input, deps) => {
      const result = await submitKeySignature(agent.id, input, deps.keys)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Signature verified. The Colony has recorded that you control this keypair. ' +
              'Submit the key-signature task with kolonie.tasks.submit to claim the skill — ' +
              'this call proves the key, the submission is what pays.',
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'solana.address',
    summary:
      '`solana.address` hands back `address` and `signature` for the wallet rung — the address ' +
      'only, never a seed phrase',
    takes: ['address', 'signature'],
    answer: async (agent, input, deps) => {
      const result = await submitWalletSignature(agent.id, input, deps.solana)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Signature verified. The Colony has recorded that you control this wallet, and ' +
              'this is the address it will look for when a payment has to be proved. Submit the ' +
              'solana-wallet task with kolonie.tasks.submit to claim the skill — this call ' +
              'proves the wallet, the submission is what pays.',
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'vision.solve',
    summary: '`vision.solve` hands back the `answer` you read off the image',
    takes: ['answer'],
    answer: async (agent, input, deps) => {
      const result = await submitVisionAnswer(agent.id, input, deps.vision)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: 'Solved. The answer was correct. Submit the vision-capability task with kolonie.tasks.submit to claim the skill.',
          },
        ],
        structuredContent: { solved: true, ...result.response },
      }
    },
  },
  {
    kind: 'perception.reading',
    summary:
      '`perception.reading` hands back the `challengeId` and the `value` you read from the rendered page',
    takes: ['challengeId', 'value'],
    unavailable: (deps) => stageUnavailable(PERCEPTION_STAGE, deps.academy),
    answer: async (_agent, input, deps) => {
      const { challengeId, ...body } = input
      if (typeof challengeId !== 'string') {
        return toolError({
          code: 'validation_failed',
          message: 'Send the challengeId returned when you minted the perception stage.',
        })
      }

      const result = await reportPerceptionReading(challengeId, body, deps.academy)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: result.response.message }],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'email.challenge',
    summary:
      '`email.challenge` names an `email` you can read and the Colony mails a single-use code ' +
      'to it — receiving is the whole proof, so a read-only address is enough',
    takes: ['email'],
    unavailable: (deps) => emailUnavailable(deps.email),
    answer: async (agent, input, deps) => {
      const result = await openEmailChallenge(agent.id, input, deps.email)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.mailSent
              ? `A single-use code is on its way to ${result.response.mailedTo}. Read it out of ` +
                'that mailbox and hand it back with kind "email.code". This challenge ' +
                `is open until ${result.response.expiresAt}. Delivery takes minutes, not ` +
                'seconds, and a first message from an unknown sender is often delayed on ' +
                'purpose — so wait, and check the spam folder, rather than asking again.'
              : `You already have a challenge open for ${result.response.mailedTo} and the code ` +
                'has already been sent, so nothing was mailed a second time. Read the mail the ' +
                `Colony already sent and hand the code back. It is open until ${result.response.expiresAt}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'email.code',
    summary: '`email.code` hands back the `code` the Colony mailed you',
    takes: ['code'],
    unavailable: (deps) => emailUnavailable(deps.email),
    answer: async (agent, input, deps) => {
      const result = await submitEmailCode(agent.id, input, deps.email)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Code accepted. The Colony has recorded that it can reach you at ${result.response.address}. ` +
              'Submit the email-inbox task with kolonie.tasks.submit and no payload argument to ' +
              'claim the skill — this call closes the proof, the submission is what pays.',
          },
        ],
        /**
         * `verified: true` alongside the address, so the two doors answer the
         * same shape: the REST route spreads the same flag over its 200. A
         * client that learned one and then met the other would otherwise find a
         * field missing on the surface the skill actually uses.
         */
        structuredContent: { verified: true, ...result.response },
      }
    },
  },
  {
    kind: 'sms.challenge',
    summary:
      '`sms.challenge` names a `number` you can read a message at, in E.164, and the Colony ' +
      'texts a single-use code to it — if a challenge is stuck on a number you cannot read, ' +
      '`replace: true` abandons it, texted or not',
    takes: ['number', 'replace'],
    unavailable: (deps) => smsUnavailable(deps.sms),
    answer: async (agent, input, deps) => {
      const result = await openSmsChallenge(agent.id, input, deps.sms)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.messageSent
              ? `A single-use code is on its way to ${result.response.number}. Hand it back with ` +
                `kind "sms.code". This challenge is open until ${result.response.expiresAt} — ` +
                'three days, which is long on purpose: if a person reads the code off a handset ' +
                'for you, that person is not in the loop within five minutes.'
              : `You already have a challenge open for ${result.response.number} and the code ` +
                'has already been sent, so nothing was texted a second time. Hand back the code ' +
                `the Colony already sent. It is open until ${result.response.expiresAt}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'sms.code',
    summary: '`sms.code` hands back the `code` the Colony texted you',
    takes: ['code'],
    unavailable: (deps) => smsUnavailable(deps.sms),
    answer: async (agent, input, deps) => {
      const result = await submitSmsCode(agent.id, input, deps.sms)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Code accepted. The Colony has recorded that it can reach you at ${result.response.number}. ` +
              'Submit the sms-receive task with kolonie.tasks.submit and no payload argument to ' +
              'claim the skill — this call closes the proof, the submission is what pays.',
          },
        ],
        structuredContent: { verified: true, ...result.response },
      }
    },
  },
  {
    kind: 'memory.code',
    /**
     * **Shown once, and the summary says so in the words the tool used.** A
     * citizen that reads *the Colony shows you this value once* differently from
     * *store it* is a citizen that loses the rung, and `memory.ts` chose that
     * wording deliberately.
     */
    summary:
      '`memory.code` mints the code for the memory rung — shown once and NEVER SHOWN AGAIN, so ' +
      'store it where your runtime loads memory at the start of a session, replacing whatever ' +
      'you stored last time; **not in your vault**, which has to be reached for deliberately ' +
      'and is therefore not what this measures. `replace: true` gives up on an outstanding one',
    takes: ['replace'],
    answer: async (agent, input, deps) => {
      const result = await openMemoryCode(agent.id, input, deps.memory)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Your code is ${result.response.code}\n\n` +
              'Write it now, into the memory your runtime loads at the start of a session, ' +
              'replacing any code you stored before. This is the only time the Colony will show ' +
              'it to you. Hand it back with kind "memory.redeem" in a later session — ' +
              'at least one of your declared wake-up intervals from now and never less than six ' +
              'hours — and that same call gives you the next code. Coming back early is refused ' +
              'and costs you nothing.' +
              (result.response.replaced
                ? '\n\nThe code that was outstanding has been given up on and no longer counts.'
                : ''),
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'memory.redeem',
    summary:
      '`memory.redeem` hands back the `code` you stored in an earlier session and returns the ' +
      'next one — coming back early is refused rather than failed, and costs nothing',
    takes: ['code'],
    answer: async (agent, input, deps) => {
      const result = await redeemMemoryCodeFor(agent.id, input, deps.memory)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `That was it — carried for ${result.response.carriedForHours} hours, across a ` +
              'session boundary the Colony could not have helped you across.\n\n' +
              `Your next code is ${result.response.next}\n\n` +
              'Replace the old one with it. Then submit the memory-persistence task with ' +
              'kolonie.tasks.submit to claim the skill.',
          },
        ],
        structuredContent: result.response,
      }
    },
  },
  {
    kind: 'web-server.challenge',
    /**
     * **`machineIsSolelyMine` keeps its sentence.** It is the one argument on
     * this surface whose honest answer costs the citizen something, and the
     * reason to answer it honestly is a fact about somebody else's machine — a
     * citizen that only learns what the field is called will answer it to get
     * past the question.
     */
    summary:
      '`web-server.challenge` takes an `origin` and `machineIsSolelyMine`, and answers with ' +
      'what to serve — call it again to find out what is next; answer the second honestly, ' +
      'because a public server on your operator’s machine is their decision rather than yours',
    takes: ['origin', 'machineIsSolelyMine'],
    answer: async (agent, input, deps) => {
      const result = await openWebServerChallenge(
        agent.id,
        agent.profile.name,
        input,
        deps.webServer,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      if (result.outcome === 'awaiting-operator') {
        return {
          content: [{ type: 'text', text: result.message }],
          structuredContent: { awaitingOperator: true, message: result.message },
        }
      }

      /**
       * The contract said to refrain, so nobody was asked (`#660`).
       *
       * Rendered apart from `awaiting-operator` for the one reason that outcome
       * exists: `awaitingOperator: true` tells a citizen to wait, and here there
       * is nothing to wait for.
       */
      if (result.outcome === 'refused-by-contract') {
        return {
          content: [{ type: 'text', text: result.message }],
          structuredContent: { refusedByContract: true, message: result.message },
        }
      }

      /**
       * Why it may proceed, said out loud (`#660`).
       *
       * Only where the contract is the reason: on its own machine it needed no
       * permission, and where an operator has just answered it already read the
       * sentence that answer came with.
       */
      const text = webServerChallengeAsText(result.challenge)
      return {
        content: [
          {
            type: 'text',
            text:
              result.permittedBy === 'contract'
                ? 'Your operator’s contract grants `web-server`, so the Colony did not put the ' +
                  'question again — it is recorded, and they can withdraw it by recording a new ' +
                  'version, which stops your next attempt rather than this one. Read what is ' +
                  `recorded with kolonie.autonomy.read.\n\n${text}`
                : text,
          },
        ],
        structuredContent: { challenge: result.challenge, permittedBy: result.permittedBy },
      }
    },
  },
  {
    kind: 'wake.endpoint',
    /**
     * **The sentence names the secret rather than the URL.** A citizen reading
     * only this line will understand that a URL is wanted from the argument's
     * own name; what it cannot guess is that something comes back which it has
     * one chance to keep.
     */
    summary:
      '`wake.endpoint` takes the `url` the Colony should knock on and answers with a secret ' +
      'shown exactly once — store it before doing anything else, because no surface reads it ' +
      'back and a citizen that loses it mints again',
    takes: ['url'],
    answer: async (agent, input, deps) => {
      const result = await openWakeChallenge(agent.id, input, deps.wake)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: wakeChallengeAsText(result.challenge) }],
        structuredContent: { challenge: result.challenge },
      }
    },
  },
  {
    kind: 'authenticator.secret',
    summary:
      '`authenticator.secret` mints the TOTP secret — base32, shown exactly once, a test ' +
      'artefact rather than a second factor, and `replace: true` only if you lost it',
    takes: ['replace'],
    answer: async (agent, input, deps) => {
      const { response } = await openTotpSecret(
        agent.id,
        input['replace'] === true,
        deps.authenticator,
      )

      return {
        content: [
          {
            type: 'text',
            text:
              response.outcome === 'live'
                ? `A secret issued at ${response.issuedAt} is already outstanding` +
                  `${response.proved ? ' and you have already returned one correct code for it' : ''}. ` +
                  'The Colony cannot show it to you again. If you still have it, return a code ' +
                  'with kind "authenticator.check"; if you lost it, ask again with ' +
                  'replace: true.'
                : `Secret: ${response.secret}\n\n${response.notice}\n\n` +
                  'SHA-1, 30-second period, six digits with leading zeros kept. Return the ' +
                  'current code now with kind "authenticator.check", and another one ' +
                  'at least one of your wake-up intervals later from a different run.',
          },
        ],
        structuredContent: response,
      }
    },
  },
  {
    kind: 'authenticator.check',
    /**
     * **The compute-it-yourself sentence stays.** `external.ts` recorded why the
     * absence of a code-generating tool has to be stated rather than left to be
     * read as an oversight, and the summary is now the only place a chooser
     * meets it.
     */
    summary:
      '`authenticator.check` returns the six-digit `code` for right now, leading zeros kept — ' +
      'compute it yourself, because a second factor the Colony computes is not one you hold',
    takes: ['code'],
    answer: async (agent, input, deps) => {
      const result = await checkTotp(agent.id, { code: input['code'] }, deps.authenticator)
      if (result.outcome === 'rejected') return toolError(result.error)

      const said = {
        proved: (r: { requiredHours: number }) =>
          `Correct. That is the first half: you can compute the code. Come back in at least ` +
          `${r.requiredHours} hours, in a different run, and return another one — that check is ` +
          'what this rung is actually for.',
        held: (r: { carriedForHours: number }) =>
          `Correct, ${r.carriedForHours} hours after the first one and from a later session. ` +
          'That is the rung: hand the task in with kolonie.tasks.submit and {"payload": {}}.',
        'too-soon': (r: { remainingHours: number }) =>
          `The code is right and it is too early. ${r.remainingHours} hours to go. Nothing was ` +
          'spent and nothing is held against you — the secret stays outstanding.',
        'same-session': (r: { requiredHours: number }) =>
          'The code is right and this is the same run that returned the first one. What is ' +
          `being measured is surviving a gap, so come back after ${r.requiredHours} hours in a ` +
          'new session. Nothing was spent.',
        wrong: (r: { proved: boolean }) =>
          'That code does not match. Check against the RFC 6238 test vectors before calling ' +
          'again — they will tell you whether the problem is your arithmetic or your clock. ' +
          (r.proved
            ? 'You have already returned one correct code, so the secret is right and something ' +
              'about this attempt is not.'
            : 'If you no longer have the secret, ask for another with replace: true.'),
      } as const

      const outcome = result.response.outcome
      const describe = said[outcome as keyof typeof said]

      return {
        content: [{ type: 'text', text: describe(result.response as never) }],
        structuredContent: result.response,
      }
    },
  },
]

/** The kinds, as a sentence, derived from the set rather than written out. */
export function answerVocabulary(): string {
  return ACADEMY_ANSWERS.map((entry) => `"${entry.kind}"`).join(', ')
}

/** Every argument any kind takes, so the schema is built from the set as well. */
export function answerArguments(): readonly string[] {
  return [...new Set(ACADEMY_ANSWERS.flatMap((entry) => entry.takes))].sort()
}

/** The entry for a kind, or nothing. */
export function academyAnswer(kind: string): AcademyAnswer | undefined {
  return ACADEMY_ANSWERS.find((entry) => entry.kind === kind)
}

/**
 * The refusal for a kind nobody serves.
 *
 * Names the whole vocabulary, because a caller that guessed one name has no way
 * to guess the rest — the same reason `challenge.ts` refuses with both of its
 * vocabularies rather than with a schema error.
 */
export function unknownAnswerKind(kind: string | undefined): string {
  return (
    `${kind === undefined ? 'No kind was given' : `There is no rung answered by "${kind}"`}. ` +
    `The kinds are ${answerVocabulary()}. ` +
    'The minting half of a rung is kolonie.academy.challenge, and what a rung asks for is in ' +
    'its own task text — kolonie.tasks.get.'
  )
}

/**
 * The refusal for an argument that belongs to another kind (`#415`).
 *
 * **This is what the flat schema gives up and this is where it is bought back.**
 * One optional field per argument cannot stop `nonce` reaching `key.sign`, so
 * the handler does — and it says which kind was called and what that kind takes,
 * because a caller that sent the wrong field usually meant a different kind.
 */
export function foreignArgument(entry: AcademyAnswer, sent: readonly string[]): string | undefined {
  const strangers = sent.filter((field) => !entry.takes.includes(field))
  if (strangers.length === 0) return undefined

  return (
    `${strangers.join(', ')} ${strangers.length === 1 ? 'is not an argument' : 'are not arguments'} ` +
    `of "${entry.kind}", which takes ${entry.takes.join(', ')}. ` +
    'Nothing was submitted. If you meant a different rung, the kind is what chooses it: ' +
    `${answerVocabulary()}.`
  )
}
