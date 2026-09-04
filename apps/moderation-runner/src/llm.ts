/**
 * The one place this process talks to a model.
 *
 * Everything that decides anything — what counts as a duplicate, what counts as
 * useful, what crosses a red line — is in `dedup.ts`, `quality.ts` and
 * `redline.ts`, and each of those is a pure function over a model's answer. This
 * file is transport: it sends a prompt and returns a parsed reply, and it knows
 * nothing about struggles or tips.
 *
 * That division is the same one `verifier-runner` draws between its loop and
 * `verifySubmission`, and it exists for the same reason: this is the code path
 * that decides what one citizen is allowed to say to another, and every part of
 * it that can be tested without a network should be.
 */

import {
  TIER_1,
  chatRequestBody,
  maxTokensFromEnvironment,
  readModelCall,
  silentLog,
  throwIfTruncated,
  type CapabilityTier,
  type Log,
  type ModelCall,
} from '@kolonie-ai/core'

/** The environment variable the key arrives in. Never a literal, anywhere. */
export const OPENROUTER_API_KEY_VAR = 'OPENROUTER_API_KEY'

/**
 * The tier that judges (`#1694`).
 *
 * **`tier-1`, because this is the one judgement the Colony cannot take back.**
 * Since `#693` a quest that clears moderation is published *by* that verdict, so
 * there is no later stage that would catch a weak one — which is the same
 * argument `gatewayOnlyFetch` makes about falling back, one layer up. Every
 * other call in this file rides the same client, and paying tier-1 for answer
 * moderation is cheaper than a second key set and a second client to separate
 * them.
 *
 * **What a tier buys here is the thing the old constant could not.** The model
 * that served this before was chosen by the maintainer against a real corpus and
 * then had to be *changed in code* every time that judgement was revisited — and
 * it had been, twice: `xiaomi/mimo-v2.5` was replaced for being served from a
 * shared free pool, rate-limited hard enough that four of four briefing
 * syntheses failed in one hour, and for degenerating into repeated fragments
 * until it exhausted the token budget. Those are gateway-side facts about a
 * model, and they now change a preset rather than this file.
 *
 * **The tier-1 preset must not carry an internal fallback chain**, for the
 * reason `CAPABILITY_TIERS` states beside the tier: a preset that silently
 * substitutes a weaker model defeats the rule above from inside the gateway,
 * where no test here can see it.
 *
 * It must still support strict JSON schema output — every prompt in this file
 * asks for a shape rather than prose, and a moderator whose verdict has to be
 * extracted with a regular expression is one that will eventually approve
 * something because it wrote the word "approve" in an explanation.
 */
export const MODERATION_TIER: CapabilityTier = TIER_1

/**
 * Where the model that measures similarity is named — configuration, and never a
 * constant here (`#1694`).
 *
 * A different model from the one that judges, and necessarily so: judging is a
 * chat completion and similarity is an embedding, and no model does both. This
 * one only ever narrows the field — **it never decides a merge**. See `dedup.ts`
 * for why that separation is the whole design rather than an implementation
 * detail.
 *
 * **An embedding has no tier, and cannot have one.** A tier is a preset on a
 * chat endpoint; embeddings do not route through the gateway at all — D-122 §1,
 * and the gateway answers 404 for `/embeddings`. So the slug that used to sit
 * here is read from the environment instead, and there is no default.
 *
 * **Unset means no embeddings, which is not an outage.** `embed` answers with
 * nothing, `findDuplicate` reads the short answer and returns `distinct`, and
 * entries are published without being compared. That is the direction `dedup.ts`
 * already documents as safe: the failure shows up as nothing ever being merged,
 * which is visible and reversible, rather than as a merge onto the wrong pair.
 */
export const EMBEDDING_MODEL_VAR = 'OPENROUTER_EMBEDDING_MODEL'

/**
 * The operator's ceiling for this service, or nothing at all (`#1694`).
 *
 * **Four named ceilings used to live here and all four are gone.** They were
 * `BRIEFING_MAX_TOKENS`, `CLASSIFY_MAX_TOKENS`, `MARK_MAX_TOKENS` and
 * `CEILING_ESCALATION`, and the history they carried is the argument for
 * removing them rather than against it: 2000 was too low and briefings came back
 * empty (`#416`), 400 was too low and verdicts came back empty (`#437`), 4000
 * was too low and a walk-prose pass came back empty (`#1192`). Each was raised
 * with a correct paragraph attached and each was too small again, because
 * **reasoning tokens are charged against the ceiling and never appear in the
 * reply**, and how much a model reasons is a property of the page in front of it
 * and of a model somebody else may swap under us.
 *
 * `max_tokens` is a ceiling and not a reservation: the model stops on its own,
 * so a number set here can only ever be too small, and setting one very high is
 * omitting it plus a figure a later reader mistakes for a considered limit and
 * adjusts. Unset, the field is absent from the request body entirely.
 *
 * **What replaces the escalation is not another number.** A reply the model said
 * it did not finish is a failed call, at any ceiling — including one the gateway
 * imposes that nothing here can see. `throwIfTruncated` raises it and
 * `TruncatedCompletion` carries a stable code, so the row stays in its queue and
 * the next poll tries again, which is what every other failure in this file
 * already does.
 */
export const moderationCeiling = (
  env: Record<string, string | undefined> = process.env,
): number | undefined => maxTokensFromEnvironment('moderation', env)

/** What a marking pass may be told about one span. Unchanged by `#1694`. */

/** What a classification prompt is allowed to answer. */
export interface Classification {
  readonly decision: string
  readonly reason: string
  /** Present on real transports; fakes may omit it when accounting is irrelevant. */
  readonly call?: ModelCall
}

/** What this process needs a model for. Injected, so nothing here needs a network. */
export interface Model {
  /**
   * Which model this is, as configured — recorded on every verdict it reaches.
   *
   * On the interface rather than read from `MODERATION_MODEL` at the point of the
   * write, because the constant is a default and not the answer: `OPENROUTER_MODEL`
   * overrides it, and a `moderations` row naming the default while a different
   * model judged would be an audit trail that lies in exactly the case somebody is
   * auditing. The same argument `verifications.task_type` makes about a task type
   * corrected after the fact.
   */
  readonly name: string

  /**
   * Ask for one structured judgement.
   *
   * `choices` is the closed set of answers. It reaches the model as a JSON
   * schema enum rather than as a sentence in the prompt, so an answer outside it
   * is refused by the transport rather than by a string comparison here.
   */
  classify(input: {
    readonly system: string
    readonly user: string
    readonly choices: readonly string[]
  }): Promise<Classification>

  /**
   * Ask for a list of spans rather than one verdict.
   *
   * A second shape and not a variant of {@link classify}, because the two answer
   * differently: a classification is one of a closed set and a marking is zero or
   * more findings, and squeezing a list into `decision`/`reason` would mean
   * parsing prose back out of a field the schema promised was an enum.
   *
   * `kinds` closes the label set the same way `choices` does, and for the same
   * reason — an answer outside it is refused by the transport rather than by a
   * comparison somewhere downstream.
   */
  mark(input: {
    readonly system: string
    readonly user: string
    readonly kinds: readonly string[]
  }): Promise<readonly MarkedSpan[]>

  /**
   * Ask for written claims over a closed set of sources.
   *
   * The third shape, and the only one whose answer is prose the Colony
   * publishes. `sections` and `sourceIds` are both closed sets in the schema, for
   * the reason `choices` is: a section outside the three, or a citation of an
   * entry that is not in the corpus, is refused by the transport rather than
   * discovered downstream.
   */
  compose(input: {
    readonly system: string
    readonly user: string
    readonly sections: readonly string[]
    readonly sourceIds: readonly string[]
    /** The ceiling on one claim's text, enforced in the schema rather than asked for. */
    readonly maxClaimLength: number
  }): Promise<readonly ComposedClaim[]>

  /** Embed several strings at once. Order in, order out. */
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>
}

/**
 * One claim as the transport parsed it — text and provenance, no arithmetic.
 *
 * There are no counts here and that is not an omission: the model is never asked
 * for one. `synthesis.ts` derives every number from the entries this cites, so a
 * count is true about the corpus even when the sentence above it is not.
 */
export interface ComposedClaim {
  readonly section: string
  readonly text: string
  readonly sources: readonly string[]
}

/**
 * One span a marking prompt found, as the transport parsed it.
 *
 * `kind` is a plain string here rather than core's enum: this file knows nothing
 * about struggles, tips or confidentiality, and the schema it sends is built from
 * whatever `kinds` the caller passed. `confidentiality.ts` is what narrows it.
 */
export interface MarkedSpan {
  readonly text: string
  readonly kind: string
}

/**
 * Why a call failed, in as much detail as is safe to write down.
 *
 * **The status alone was not enough, and finding that out cost an hour.** Four
 * briefing syntheses failed against `OpenRouter answered 429`, which reads as
 * ordinary rate limiting; the body said `xiaomi/mimo-v2.5 is temporarily
 * rate-limited upstream … limit_source: upstream_provider_shared_pool`, which
 * says something quite different — the Colony's moderation depended on a shared
 * free pool. Nobody could have learned that from a log line, and it took a hand-
 * built probe against production to see it.
 *
 * **Whitelisted rather than passed through**, because the original caution was
 * right: a vendor's error body can echo the request back, and the request
 * carries the key. So this names the fields it wants — all of them short,
 * structured and about the *provider* rather than about the request — and
 * nothing else survives.
 *
 * **And then the key is scrubbed anyway.** A whitelist is a claim about a shape
 * somebody else controls; the substitution is a fact about the string that is
 * actually thrown. Two defences, because a credential in a log survives every
 * rotation of the log.
 */
/**
 * A completion the provider said was finished, with no usable offered fields.
 *
 * Distinct from {@link ProviderUnreachable}: the bytes arrived. Distinct from a
 * product defect: nothing here was invented, and a later valid completion still
 * writes the ordinary verdict. `#1826` is this class existing so the runner can
 * back off instead of filing `entry.moderate.failed` every minute.
 */
export class ProviderResponseAnomaly extends Error {
  readonly finishReason: string | undefined
  readonly missing: readonly string[]

  constructor(finishReason: string | undefined, missing: readonly string[]) {
    const stopped = finishReason === undefined ? 'without a finish reason' : `with ${finishReason}`
    super(`OpenRouter returned an unusable completion ${stopped}; missing ${missing.join(', ')}`)
    this.name = 'ProviderResponseAnomaly'
    this.finishReason = finishReason
    this.missing = [...missing]
  }
}

/**
 * The request never reached OpenRouter (`#449`).
 *
 * **A class rather than a message, because the two failures need opposite
 * reactions.** A `429`, a `500` or an empty reply is the provider answering
 * badly: it is about this call, this prompt, this ceiling, and it belongs in a
 * log line a person reads. A connection that never opened is about the network
 * between here and there, it is the same for every task in the batch, and one
 * occurrence of it is the system working — the flag stays set and the next poll
 * writes the briefing. `packages/verifiers/src/support.ts` states the rule this
 * follows: *"A single transient failure that clears on retry is the system
 * working."*
 *
 * ## Why the cause is unwrapped rather than left on the error
 *
 * `fetch` rejects with `TypeError: fetch failed` and puts everything that says
 * *what* failed on `error.cause` — the DNS answer, the reset, the timeout. A
 * structured log carries the message and the stack, so what reached Loki on
 * 2026-08-06 was:
 *
 *     "err": { "name": "TypeError", "message": "fetch failed", "stack": … }
 *
 * — a line naming neither the host nor the reason. The issue filed from it
 * closes with *"the lines alone are insufficient to determine the root cause
 * beyond a fetch failure"*, which is the detector saying the log line did not do
 * its job. This walks the chain and puts it in the message, where it survives
 * every transport that keeps a message.
 *
 * **The path, not the URL.** The endpoint root is supplied by the configured
 * transport, and naming it in every failure adds no information. `/chat/completions` is
 * what distinguishes a synthesis from an embedding, and that is the part a
 * reader is missing.
 */
export class ProviderUnreachable extends Error {
  /** The OpenRouter path that was being called — `/chat/completions`, `/embeddings`. */
  readonly endpoint: string

  constructor(endpoint: string, cause: unknown) {
    super(`OpenRouter could not be reached for ${endpoint}: ${describeCause(cause)}`, { cause })
    this.name = 'ProviderUnreachable'
    this.endpoint = endpoint
  }
}

/**
 * Everything the rejection says about itself, flattened into one sentence.
 *
 * **Bounded on purpose.** A cause chain is a linked list and nothing promises it
 * is short; three links is past every case undici produces and stops a cyclic
 * one from being written into a log for ever. Codes are included because
 * `ENOTFOUND` and `ECONNRESET` are different problems with different owners, and
 * they are the half that `message` alone never carries.
 */
function describeCause(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error

  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    parts.push(typeof code === 'string' ? `${current.message} (${code})` : current.message)
    current = current.cause
  }

  return parts.length === 0 ? String(error) : parts.join(' — caused by ')
}

async function diagnose(response: Response, apiKey: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        message?: unknown
        metadata?: { provider_name?: unknown; limit_source?: unknown; raw?: unknown }
      }
    }

    const meta = body.error?.metadata
    const parts = [
      typeof body.error?.message === 'string' ? body.error.message : undefined,
      typeof meta?.provider_name === 'string' ? `provider ${meta.provider_name}` : undefined,
      typeof meta?.limit_source === 'string' ? `limit ${meta.limit_source}` : undefined,
      typeof meta?.raw === 'string' ? meta.raw.slice(0, 200) : undefined,
    ].filter((part): part is string => part !== undefined && part !== '')

    if (parts.length === 0) return ''
    return `: ${redact(parts.join(' — ').slice(0, 400), apiKey)}`
  } catch {
    // A body that is not JSON, or a stream already consumed. The status is still
    // in the message above, and a diagnosis that threw must not replace the
    // error it was trying to explain.
    return ''
  }
}

/** Remove the credential from anything about to be thrown, whatever else is in it. */
function redact(text: string, apiKey: string): string {
  return apiKey === '' ? text : text.split(apiKey).join('[redacted]')
}

/**
 * The reply text, or an error that says what arrived instead of it.
 *
 * `OpenRouter returned no message content` was the whole of what this said, and
 * it names the one thing that is *not* there rather than any of the things that
 * are. The reply carries two fields that answer *why* directly: `finish_reason`,
 * which separates an answer cut off at the token ceiling from one the model
 * declined to give, and `refusal`, which a model that will not produce a
 * structured output fills in **instead of** `content`. Neither reached a log
 * line. Thirteen failures over twenty-five minutes on 2026-08-05 were read as an
 * OpenRouter outage on the strength of the absence alone (`#408`), and the
 * absence is the one part of a reply that cannot say which failure it is.
 *
 * **Safe to quote, unlike an error body.** `diagnose()` whitelists fields
 * because a vendor's error body can echo the request back, and the request
 * carries the key. These two are the model's own words about its own answer;
 * the request is not in them. Bounded anyway, because a field somebody else
 * controls is a field that can be arbitrarily long.
 *
 * A blank string now throws where it used to be returned. That is not a new
 * refusal: the parse a line later threw on it, less usefully.
 */
function messageContent(body: unknown, ceiling?: number): string {
  const choice = (
    body as {
      choices?: {
        message?: { content?: unknown; refusal?: unknown }
        finish_reason?: unknown
      }[]
    }
  ).choices?.[0]

  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim() !== '') return content

  const refusal = choice?.message?.refusal
  const finishReason = choice?.finish_reason
  const why = [
    choice === undefined ? 'the reply carried no choices' : undefined,
    typeof refusal === 'string' && refusal !== ''
      ? `the model refused: ${refusal.slice(0, 200)}`
      : undefined,
    typeof finishReason === 'string'
      ? // The ceiling is named because it is the number somebody reading this line
        // would otherwise have to come into this file to find, and it is the one
        // they can change. `#416` was two log lines that said `finish_reason
        // length` and nothing about what the length was.
        finishReason === 'length' && ceiling !== undefined
        ? `finish_reason length — the whole ${ceiling}-token ceiling went on reasoning, and nothing was written`
        : `finish_reason ${finishReason}`
      : undefined,
    typeof content === 'string' && content.trim() === '' ? 'content was blank' : undefined,
  ].filter((part): part is string => part !== undefined)

  throw new Error(
    why.length === 0
      ? 'OpenRouter returned no message content'
      : `OpenRouter returned no message content — ${why.join('; ')}`,
  )
}

/** Why the model stopped, when it said. */
function finishReason(body: unknown): string | undefined {
  const reason = (body as { choices?: { finish_reason?: unknown }[] }).choices?.[0]?.finish_reason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * A reply that said nothing at all: no content, and no refusal either.
 *
 * On its own this is not a diagnosis — it is half of one. What turns it into a
 * diagnosis is `finish_reason`, which is why the two predicates below differ
 * only in that word and share this.
 */
function withoutContent(body: unknown): boolean {
  const choice = (body as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] })
    .choices?.[0]
  const content = choice?.message?.content
  const refusal = choice?.message?.refusal

  return (
    choice !== undefined &&
    !(typeof content === 'string' && content.trim() !== '') &&
    !(typeof refusal === 'string' && refusal !== '')
  )
}

/** The transient empty completion observed in #599, and no wider failure class. */
function stoppedWithoutContent(body: unknown): boolean {
  return finishReason(body) === 'stop' && withoutContent(body)
}

type ResponseAnomaly = {
  readonly finishReason: string | undefined
  readonly missing: readonly string[]
}

function missingVerdictFields(body: unknown): ResponseAnomaly | undefined {
  const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    ?.message?.content
  if (typeof content !== 'string' || content.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const verdict = parsed as Partial<Classification>
  const missing = [
    typeof verdict.decision === 'string' ? undefined : 'decision',
    typeof verdict.reason === 'string' ? undefined : 'reason',
  ].filter((field): field is string => field !== undefined)

  return missing.length === 0 ? undefined : { finishReason: finishReason(body), missing }
}

/**
 * One request to the completions endpoint.
 *
 * **No `max_tokens` field** (`#1694`). The operator's ceiling, when one is set
 * at all, is applied by `chatRequestBody` at the point of the send — so no
 * caller in this file names a number, and with nothing set the field is absent
 * from the body entirely.
 */
interface ChatRequest {
  readonly model: string
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly response_format?: unknown
  readonly temperature?: number
}

/**
 * A verdict, from JSON or from a model that answered the enum and nothing else.
 *
 * **A strict schema is the vendor's promise, and it is not always kept.** On
 * 2026-08-05 a reply was the seven characters `approve` — not JSON, not quoted,
 * the enum value on its own — and `JSON.parse` threw `Unexpected token 'a'`.
 * That latches: at `temperature: 0` a reply malformed once is malformed every
 * time, so the entry is retried on every poll for ever rather than judged
 * (`#408`). It is the same failure `compose` already carries a comment about,
 * one stage earlier — *the failure has to degrade rather than latch.*
 *
 * So an answer that is **exactly** one of the offered choices is taken, whether
 * it arrived bare or as a JSON string, and everything else still throws.
 *
 * **This is not the prose-parsing the header of this file warns against.** That
 * warning is about *"a moderator that will eventually approve something because
 * it wrote the word approve in an explanation"*, and it stands: a sentence
 * containing `approve` is not equal to `approve`, and only equality is read
 * here. Nothing is accepted that the enum would not have accepted.
 *
 * The reason is what is lost, and it is stated rather than invented — a citizen
 * reading the note learns that the model gave none, which is true and is more
 * than it learns from an entry that is never judged at all.
 */
function parseVerdict(
  content: string,
  choices: readonly string[],
  stopped?: string,
  ceiling?: number,
): Classification {
  const bare = content.trim()

  /**
   * **Why the reply is unusable, when the reply itself cannot say** (`#437`).
   *
   * The third of the three failures logged on 2026-08-06 was *the model returned
   * a verdict without a decision and a reason*, which reads as a model that
   * answered badly. A reply cut off at the ceiling reaches this function looking
   * exactly like one: what arrives is short, and whether it is short because the
   * model had nothing to say or because it was interrupted is a fact only
   * `finish_reason` holds.
   *
   * Naming it here is the difference between an error that points at the model
   * and one that points at the number — and `#416` is this file already having
   * learned that the second is the one somebody can act on.
   */
  const cutOff =
    stopped === 'length'
      ? ceiling === undefined
        ? ' — the reply was cut off at the token ceiling'
        : ` — the reply was cut off at the ${ceiling}-token ceiling`
      : ''

  let parsed: unknown
  try {
    parsed = JSON.parse(bare)
  } catch {
    if (choices.includes(bare)) {
      return { decision: bare, reason: 'the model answered without a reason' }
    }
    throw new Error(`the model did not answer with JSON${cutOff}: ${bare.slice(0, 120)}`)
  }

  // `"approve"` — valid JSON, and still not the object the schema promised.
  if (typeof parsed === 'string' && choices.includes(parsed)) {
    return { decision: parsed, reason: 'the model answered without a reason' }
  }

  const verdict = parsed as Partial<Classification>
  if (typeof verdict.decision !== 'string' || typeof verdict.reason !== 'string') {
    throw new Error(`the model returned a verdict without a decision and a reason${cutOff}`)
  }
  if (!choices.includes(verdict.decision)) {
    throw new Error(`the model answered '${verdict.decision}', which was not on offer`)
  }

  return { decision: verdict.decision, reason: verdict.reason }
}

/**
 * A model whose calls all fail, for a process started without a key.
 *
 * **The runner starts anyway**, which is the rule `createVerifiers` follows and
 * the reason it does: a moderator that cannot decide leaves entries `pending`,
 * and pending entries are never served. The failure mode is that nothing gets
 * published — visible, reversible, and safe. The alternative, refusing to start,
 * takes down a process whose health endpoint is how anyone would find out.
 */
export function unavailableModel(reason: string): Model {
  const fail = (): never => {
    throw new Error(`no model configured: ${reason}`)
  }
  // A name it can never write, because every call above throws before a verdict
  // exists. Named anyway rather than left empty: if it ever appears in a
  // `moderations` row, that row is the bug report.
  return { name: 'unconfigured', classify: fail, mark: fail, compose: fail, embed: fail }
}

/**
 * The real thing, over OpenRouter's HTTP API.
 *
 * **The key is never logged and never returned.** It is captured in this
 * closure and read from `process.env` in `main.ts` — the same arrangement the
 * GitHub verifier token uses, and for the same reason: a credential named in one
 * file is a credential whose blast radius is one file.
 */
export function openRouterModel(apiKey: string, options: ModelOptions = {}): Model {
  const model = options.model ?? MODERATION_TIER
  const embeddingModel = options.embeddingModel
  const ceiling = options.maxTokens
  const fetchImpl = options.fetch ?? fetch
  const log = options.log ?? silentLog
  /**
   * `http` is the response the body came out of, and it is what says which
   * provider answered (`#674`) — this runner's `fetch` may have been wrapped to
   * try the LLM gateway first, and the row must name what did the work rather
   * than what the code was written against.
   */
  const account = (body: unknown, http?: Response): ModelCall | undefined =>
    readModelCall(body, log, http)

  const call = async (
    path: string,
    body: unknown,
  ): Promise<{ readonly body: unknown; readonly accounting: ModelCall | undefined }> => {
    let response: Response
    try {
      response = await fetchImpl(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new ProviderUnreachable(path, error)
    }

    if (!response.ok) {
      throw new Error(
        `OpenRouter answered ${response.status} for ${path}${await diagnose(response, apiKey)}`,
      )
    }

    /**
     * **The body is read inside the same guard as the request** (`#734`).
     *
     * `fetch` resolves as soon as the headers arrive; everything after that is a
     * stream that can still die. When it does, undici rejects the `.json()` with
     * `TypeError: terminated` from `Fetch.onAborted` — a different call site
     * from the one above, so before this the rejection escaped unclassified,
     * reached `loop.ts` as an ordinary error and was logged as `briefing.failed`
     * at `error`. The log detector files one GitHub issue per `error` signature,
     * so a dropped connection arrived as a defect report: `#734`, filed
     * 2026-08-11, a regression of `#640` on the same signature for a different
     * cause.
     *
     * **A connection that dies mid-body is the same event as one that never
     * opened**, from every angle that decides what to do about it. Nothing was
     * learned about this task, this prompt or this ceiling; it is the network
     * between here and there; it is the same for every task in the batch; and
     * the correct reaction is the one `#449` already built — defer, leave the
     * flag set, let the next poll write the briefing. Classifying it as
     * anything else asks a maintainer to read a network hiccup.
     *
     * **A `SyntaxError` is the one rejection here that is not this**, and it is
     * let through unchanged. Malformed JSON means the bytes arrived and were not
     * what they claimed to be — the provider answering badly, which is about
     * this call and belongs in a log line a person reads. The distinction is the
     * same one `ProviderUnreachable`'s own comment draws between a `429` and a
     * connection that never opened; only the boundary moved.
     *
     * `diagnose` above reads a body too, and deliberately stays outside this: a
     * failure while reading a `429`'s body is already inside a path that ends in
     * an error, and it swallows its own — the status is the fact worth keeping.
     */
    let result: unknown
    try {
      result = (await response.json()) as unknown
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      throw new ProviderUnreachable(path, error)
    }
    return { body: result, accounting: account(result, response) }
  }

  /**
   * One completion, with the empty reply this file has been bitten by handled.
   *
   * **A truncated reply throws rather than escalating a ceiling** (`#1694`). The
   * escalation this used to do — retry once at four times the ceiling — was a
   * fix for one instance of a failure whose cause is that a ceiling exists at
   * all, and it was written after the third time a named constant turned out to
   * be too small. There is no ceiling to raise now unless an operator set one,
   * and `throwIfTruncated` catches the cut-off answer at whatever ceiling the
   * gateway itself imposes, which no constant here could ever see.
   *
   * A throw here leaves the row in the queue that selected it and the next poll
   * tries again, which is what every other failure in this file already does.
   */
  const chat = async (
    request: ChatRequest,
    responseAnomaly?: (body: unknown) => ResponseAnomaly | undefined,
  ): Promise<{
    readonly body: unknown
    readonly accounting: ModelCall | undefined
  }> => {
    const body = chatRequestBody({
      ...request,
      ...(ceiling === undefined ? {} : { maxTokens: ceiling }),
    })
    const response = await call('/chat/completions', body)
    throwIfTruncated(response.body)
    const anomaly = stoppedWithoutContent(response.body)
      ? { finishReason: 'stop', missing: ['content'] }
      : responseAnomaly?.(response.body)
    const answered = anomaly === undefined ? response : await call('/chat/completions', body)

    if (anomaly !== undefined) {
      throwIfTruncated(answered.body)
      const repeated = stoppedWithoutContent(answered.body)
        ? { finishReason: 'stop', missing: ['content'] }
        : responseAnomaly?.(answered.body)
      if (repeated !== undefined) {
        throw new ProviderResponseAnomaly(repeated.finishReason, repeated.missing)
      }
    }

    // Cut off before it finished — at the operator's ceiling if one is set, and
    // at the gateway's own otherwise. Either way it is a failed call and never a
    // verdict: a truncated reply is well-formed, which is what makes accepting
    // one a judgement nobody finished writing.
    throwIfTruncated(answered.body)

    return answered
  }

  return {
    name: model,

    async classify({ system, user, choices }) {
      const { body, accounting } = await chat(
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          /**
           * Strict schema, not a request in prose. The `decision` field is an enum
           * of exactly the answers the caller will act on, so "approve, I think"
           * and "APPROVED" are impossible rather than handled.
           */
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'verdict',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: [...choices] },
                  reason: { type: 'string' },
                },
                required: ['decision', 'reason'],
                additionalProperties: false,
              },
            },
          },
          // Judging the same text twice should reach the same verdict. This is a
          // classification, not a composition.
          temperature: 0,
        },
        missingVerdictFields,
      )

      /**
       * **No ceiling to name any more** (`#1694`). `messageContent` still
       * reports `finish_reason`, and a reply cut off at a ceiling never reaches
       * here at all — `chat` throws on it, because a truncated verdict is a
       * verdict nobody finished writing.
       */
      return {
        ...parseVerdict(messageContent(body), choices, finishReason(body)),
        call: accounting,
      }
    },

    async mark({ system, user, kinds }) {
      const { body } = await chat({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        /**
         * An array of objects, with `kind` an enum of exactly the labels the
         * caller offered. The wrapping object is not decoration — a top-level
         * array is not expressible as a strict JSON schema response here, and
         * `spans` gives the model somewhere to put an empty list rather than
         * treating *nothing found* as a case it has to describe in prose.
         */
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'marked_spans',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                spans: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      kind: { type: 'string', enum: [...kinds] },
                    },
                    required: ['text', 'kind'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['spans'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0,
      })
      const content = messageContent(body)

      const parsed = JSON.parse(content) as { spans?: unknown }
      if (!Array.isArray(parsed.spans)) {
        throw new Error('the model returned a marking without a spans array')
      }

      return parsed.spans.map((span) => {
        const { text, kind } = span as Partial<MarkedSpan>
        if (typeof text !== 'string' || typeof kind !== 'string') {
          throw new Error('the model returned a span without a text and a kind')
        }
        if (!kinds.includes(kind)) {
          throw new Error(`the model marked a span as '${kind}', which was not on offer`)
        }
        return { text, kind }
      })
    },

    async compose({ system, user, sections, sourceIds, maxClaimLength }) {
      const { body } = await chat({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'briefing',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                claims: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      section: { type: 'string', enum: [...sections] },
                      /**
                       * **Bounded in the schema, not merely asked for in prose.**
                       *
                       * Without this the model ran away: given one short tip it
                       * wrote a correct opening sentence and then degenerated
                       * into `(1 local) (1 immediate) (1 one shot) …` repeated
                       * until it exhausted `max_tokens` — and the reply was cut
                       * off *inside* `text`, so `sources` was never emitted at
                       * all. A claim citing nothing is dropped downstream, so a
                       * runaway on one claim silently produced an empty
                       * briefing over a corpus that had something in it.
                       *
                       * The prompt already said "one or two sentences". A length
                       * a model is asked to respect is a length it sometimes
                       * respects; this one it cannot exceed.
                       */
                      text: { type: 'string', maxLength: maxClaimLength },
                      // The corpus, as an enum. A model cannot cite an entry that
                      // is not in front of it, so a claim attributed to something
                      // invented is impossible rather than filtered.
                      sources: {
                        type: 'array',
                        items: { type: 'string', enum: [...sourceIds] },
                      },
                    },
                    required: ['section', 'text', 'sources'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['claims'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0,
      })
      const content = messageContent(body)

      /**
       * **A truncated briefing is no longer salvaged, and that is a behaviour
       * this issue changed on purpose** (`#1694`).
       *
       * What stood here read a reply the model said was cut off, scanned it for
       * the claims that were complete, and published those. It was right while
       * the alternative was a task whose briefing was never written again — at
       * `temperature: 0` the same corpus produced the same truncated reply on
       * every poll, so the failure latched.
       *
       * It cannot stand beside the rule this issue sets: *a reply with
       * `finish_reason: length` is a failed call and is never returned as a
       * successful answer.* A salvaged briefing is exactly that — a successful
       * answer assembled from a call that failed, published under the Colony's
       * own name with however much the model had got to. And the reason it
       * latched is gone with the ceiling: there is no number here to be too
       * small, so a retry is no longer guaranteed to reproduce the cut.
       *
       * `chat` throws before this line on a truncated reply. What is left here
       * is the ordinary malformed case, which still throws and always did.
       */
      const parsed = JSON.parse(content) as { claims?: unknown }
      if (!Array.isArray(parsed.claims)) {
        throw new Error('the model returned a briefing without a claims array')
      }
      const claims: readonly unknown[] = parsed.claims

      /**
       * A malformed claim is dropped; a malformed *reply* throws.
       *
       * **The difference cost a production round trip.** This filtered nothing
       * and threw on the first claim missing a field, which discards every good
       * claim beside it — and at `temperature: 0` a reply that is malformed once
       * is malformed every time, so the task retried every ten minutes forever
       * rather than publishing the four claims the model got right.
       *
       * Strict schemas are the vendor's promise and this is what happens when
       * one is not kept, so the failure has to degrade rather than latch. The
       * shape of the reply is still load-bearing: `claims` not being an array
       * means nothing usable came back at all, and that still throws.
       *
       * **Dropping is counted since `#230`**, which is what the comment here
       * used to say could not be done: *"dropping is silent here because this
       * file has no logger"*. A model quietly losing half of every reply and a
       * model answering perfectly looked identical, and only the case where it
       * lost *everything* was visible — one level up, in `briefingTick`.
       */
      let dropped = 0
      const kept = claims.flatMap((claim) => {
        const { section, text, sources } = claim as Partial<ComposedClaim>
        if (typeof section !== 'string' || typeof text !== 'string') {
          dropped++
          return []
        }
        if (!sections.includes(section)) {
          dropped++
          return []
        }
        // A claim with no usable sources is dropped by `synthesise`, which is
        // where that rule and its reasoning already live.
        const cited = Array.isArray(sources) ? sources.map(String) : []
        return [{ section, text, sources: cited }]
      })

      if (dropped > 0) {
        log.warn(`${model} returned ${dropped} claim(s) this could not read`, {
          event: 'model.claims.dropped',
          model,
          dropped,
          kept: kept.length,
        })
      }

      return kept
    },

    async embed(inputs) {
      if (inputs.length === 0) return []

      /**
       * No embedding model configured is no comparison, and the caller reads a
       * short answer as `distinct` (`#1694`). Loud, because a Colony that
       * silently stopped de-duplicating looks exactly like one where nothing has
       * been published twice yet.
       */
      if (embeddingModel === undefined || embeddingModel.trim() === '') {
        log.warn(
          `${EMBEDDING_MODEL_VAR} is not set. Entries are published without being compared.`,
          { event: 'config.missing', variable: EMBEDDING_MODEL_VAR },
        )
        return []
      }

      const { body } = await call('/embeddings', { model: embeddingModel, input: [...inputs] })
      const data = (body as { data?: { embedding?: number[]; index?: number }[] }).data

      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error('OpenRouter returned a different number of embeddings than inputs')
      }

      // Ordered by `index` rather than by arrival. The API documents them in
      // order and returns the field anyway; trusting the field costs nothing and
      // a silently transposed pair here would compare the wrong two texts.
      return [...data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((entry) => {
          if (!Array.isArray(entry.embedding)) throw new Error('an embedding came back empty')
          return entry.embedding
        })
    },
  }
}

export interface ModelOptions {
  readonly model?: string
  readonly embeddingModel?: string
  /**
   * The operator's ceiling, or nothing — which is the ordinary state and means
   * `max_tokens` is absent from every request body (`#1694`). Read from
   * `LLM_GATEWAY_MAX_TOKENS_MODERATION` in the runner's wiring, like the key.
   */
  readonly maxTokens?: number
  /** Injectable so tests need no network. */
  readonly fetch?: typeof fetch
  /**
   * Where a dropped claim is recorded (`#230`).
   *
   * This file used to have no logger, and said so in a comment beside a failure
   * it was discarding. It has one now, and it is optional for the same reason
   * every other logger here is: a test that does not care must not have to say
   * so, and a default of silence is what `silentLog` is for.
   */
  readonly log?: Log
}
