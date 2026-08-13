import {
  GatewayUnavailable,
  gatewayOnlyFetch,
  silentLog,
  type Finding,
  type Gateway,
  type Log,
} from '@kolonie-ai/core'

/**
 * The one place this process talks to a model, and the only place it reaches
 * anything outside its own database (`#840`).
 *
 * ## What the model is allowed to do
 *
 * **Write a sentence.** Nothing else. `apps/support-triage-runner/src/logs.ts`
 * states the rule this obeys — *"Detection is deterministic; the model only
 * writes"* — and here it is stricter than there: the triage runner's model
 * classifies and its answer is parsed. This one's output is stored as text
 * beside the finding and is parsed into nothing at all. If a sentence could
 * change a severity, the model would be deciding.
 *
 * ## What it is shown
 *
 * **The typed `Finding`, and nothing that came out of a database as text.** The
 * prompt builder below takes the structure the rules produced — kind, severity,
 * evidence numbers, route keys, the recommendation slug — and there is no
 * parameter through which a string could arrive. That is the rejection case in
 * `prose.test.ts`, and it is load-bearing rather than tidy: `#838` refuses free
 * text in stored evidence precisely so that this prompt cannot acquire an author
 * other than the Colony.
 *
 * It also cannot leak what it was never shown. No other citizen's data, no
 * address, no raw log line, and no identifier — the subject is not in the prompt
 * either, because a sentence addressed to *you* needs no name in it.
 *
 * ## When it runs, and when it deliberately does not
 *
 * In the runner's pass, out of band, and never inside `kolonie.doctor`'s request
 * path. The citizen surface must stay cheap and must not depend on a third party
 * being up.
 *
 * **Once per diagnosis, not once per pass.** A re-evaluation that only moves
 * `last_seen_at` does not rewrite the sentence; a severity change does. Otherwise
 * an open diagnosis would cost a model call every hour forever, and the Colony
 * would be paying to re-describe something nobody's view of has changed.
 *
 * ## A gateway outage costs a sentence and never a finding
 *
 * Everything below degrades: the diagnosis is stored with `prose: null`, the pass
 * completes, and the log says what the status was. A citizen then gets structured
 * findings with no sentence, which `#837`'s answer shape treats as complete —
 * because it was built that way before this file existed.
 */

/**
 * How long a sentence may be, in characters.
 *
 * **A bound rather than a preference.** It rides in a wake-up entry and in a
 * console row, and a model that answered with four paragraphs would be storing
 * something no surface can show — so an over-long completion is a failure and is
 * dropped, rather than truncated into a sentence that stops mid-clause and reads
 * as a bug in the Colony.
 *
 * Six hundred is about four sentences: enough to say what was seen, what it
 * probably means and what to do, and short enough that the numbers beside it
 * stay the thing being read.
 */
export const PROSE_MAX_LENGTH = 600

/** How much room the answer gets. Generous, because tokens are billed as generated. */
const MAX_TOKENS = 2_000

/**
 * What the model is told it is for.
 *
 * **Second person, addressed to the citizen, describing what was observed and
 * what to do.** Never accusatory and never speculating about intent, which is
 * the card's own principle — *"Ein ungewöhnlicher Agent ist nicht automatisch ein
 * Angreifer"* — carried into the one layer that could break it. The arithmetic
 * cannot call anybody an attacker; a sentence can, and this is where it is
 * forbidden to.
 */
const SYSTEM = `You write one short explanation for a citizen of Kolonie AI — an autonomous AI
agent, not a person — about something the Colony observed in its own traffic.

You are given a finding: what kind it is, how serious, the numbers behind it, the
routes involved, and a recommendation slug. That is everything you get and
everything there is.

Write at most four sentences, in the second person, addressed to the citizen.

- Say what was observed, using the numbers you were given. Do not invent any.
- Say what to do about it, following the recommendation.
- Never speculate about why the citizen did it, and never suggest it did anything
  wrong. An unusual agent is not automatically a misbehaving one, and several of
  these findings describe the Colony's own defects rather than the citizen's.
- Do not greet, do not sign off, do not use markdown, and do not restate the
  finding's name.

Answer with the explanation and nothing else.`

/** What a writer needs to be handed. Injectable so a test needs no network. */
export interface ProseOptions {
  readonly fetchImpl?: typeof fetch
  readonly log?: Log
}

/**
 * A sentence for one finding, or `null`.
 *
 * `null` covers every way this can fail, which is deliberate: the caller has one
 * behaviour for *no sentence* and does not branch on why. The reason is in the
 * log, where somebody looking into a Colony with no prose will find it.
 */
export interface ProseWriter {
  /** Whether a gateway was configured at all. `false` means nothing is ever asked. */
  readonly available: boolean
  /** The model version written onto the diagnosis, for audit (`#838`). */
  readonly model: string
  describe(finding: Finding): Promise<string | null>
}

/** A writer that writes nothing. Every diagnosis is stored complete, with no sentence. */
export const noProse: ProseWriter = {
  available: false,
  model: '',
  describe: async () => null,
}

/**
 * The writer, over the gateway and over nothing else (`#840`).
 *
 * **`gatewayOnlyFetch` rather than `gatewayRoutedFetch`**, which is the one
 * design choice here worth stating. The routed version replays a failed gateway
 * call against OpenRouter, and this runner holds no OpenRouter key and should not
 * — `#839` gives it no credential beyond the database, and a fallback to a second
 * vendor would be a second credential arriving through the back door for the sake
 * of a sentence. So there is one endpoint, and when it is down there is no
 * sentence.
 */
export function gatewayProse(gateway: Gateway, options: ProseOptions = {}): ProseWriter {
  const log = options.log ?? silentLog
  const doFetch = gatewayOnlyFetch(gateway, { fetch: options.fetchImpl ?? fetch, log })

  return {
    available: true,
    model: gateway.model,
    describe: async (finding) => {
      try {
        const response = await doFetch(`${gateway.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${gateway.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: gateway.model,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: promptFor(finding) },
            ],
            max_tokens: MAX_TOKENS,
            temperature: 0.2,
          }),
        })

        const body = (await response.json()) as {
          readonly choices?: ReadonlyArray<{
            readonly message?: { readonly content?: string | null }
            readonly finish_reason?: string
          }>
        }

        return acceptable(body.choices?.[0]?.message?.content ?? null, finding, log)
      } catch (thrown) {
        /**
         * **Every way the gateway can fail arrives here, including a 500.**
         * `gatewayOnlyFetch` turns a non-ok response into a `GatewayUnavailable`
         * whose `reason` is `status` and whose `detail` is the status code — so
         * there is no `!response.ok` branch above, because there is no path
         * through which a bad status reaches this code as a response.
         *
         * **The status and the message, and nothing else.** An error body from a
         * provider can echo the request back, and the request carries the key —
         * so nothing here logs the body, the prompt, the host or the headers.
         * `#840`'s second rejection case asserts exactly that.
         */
        const failure =
          thrown instanceof GatewayUnavailable
            ? { reason: thrown.reason, message: thrown.message }
            : { reason: 'transport', message: describe(thrown) }

        log.warn(
          `the gateway did not answer; this diagnosis gets no sentence: ${failure.message}`,
          {
            event: 'doctor.prose.refused',
            reason: failure.reason,
            kind: finding.kind,
          },
        )
        return null
      }
    },
  }
}

/**
 * An exception as one line, with nothing of its stack.
 *
 * A stack from this path can name a file, and a message from a provider client
 * can carry a URL. Neither is worth the risk for a failure whose whole content
 * is *the gateway did not answer*.
 */
function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : 'the call failed'
}

/**
 * Whether a completion is usable, or `null`.
 *
 * **An empty or over-long answer is a failure rather than something to store.**
 * Empty is what a model returns when it ran out of room mid-sentence — there is
 * no partial answer to salvage — and over-long is a sentence no surface can show.
 * Storing either would put something in the database that a later reader would
 * have to work out was never meant to be there.
 */
function acceptable(text: string | null, finding: Finding, log: Log): string | null {
  const sentence = (text ?? '').trim()

  if (sentence === '') {
    log.warn('the gateway returned nothing; this diagnosis gets no sentence', {
      event: 'doctor.prose.empty',
      kind: finding.kind,
    })
    return null
  }

  if (sentence.length > PROSE_MAX_LENGTH) {
    log.warn(
      `the gateway returned ${sentence.length} characters; this diagnosis gets no sentence`,
      {
        event: 'doctor.prose.too-long',
        length: sentence.length,
        limit: PROSE_MAX_LENGTH,
        kind: finding.kind,
      },
    )
    return null
  }

  return sentence
}

/**
 * The prompt, built from the finding's structured fields and from nothing else
 * (`#840`).
 *
 * **It takes a `Finding` and not a string, and that is the whole guarantee.**
 * There is no parameter here through which stored text could arrive, so there is
 * no path from a database column to a model's instructions — which is the
 * property `#838` refuses free text in evidence to protect, seen from the other
 * end.
 *
 * Exported so the rejection case can assert on what it produces rather than on
 * what the caller believes it produces.
 */
export function promptFor(finding: Finding): string {
  return [
    `kind: ${finding.kind}`,
    `severity: ${finding.severity}`,
    `recommendation: ${finding.recommendation}`,
    ...(finding.retryAfterSeconds === null
      ? []
      : [`a reasonable interval would be ${finding.retryAfterSeconds} seconds`]),
    `routes: ${finding.evidence.routeKeys.join(', ')}`,
    'numbers:',
    ...Object.entries(finding.evidence.figures).map(([name, value]) => `  ${name}: ${value}`),
    `observed between ${finding.since} and ${finding.until}`,
  ].join('\n')
}
