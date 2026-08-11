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

import { readModelCall, silentLog, type Log, type ModelCall } from '@kolonie-ai/core'

/** The environment variable the key arrives in. Never a literal, anywhere. */
export const OPENROUTER_API_KEY_VAR = 'OPENROUTER_API_KEY'

/**
 * Where OpenRouter is. A constant rather than configuration: it is a vendor's
 * public API root, not a host of ours, so `AGENTS.md` §9 does not reach it — and
 * making it configurable would invite pointing this at something else.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

/**
 * The model that judges.
 *
 * `deepseek/deepseek-v4-flash`, chosen by the maintainer on 2026-07-30. It
 * supports strict JSON schema output, which is what lets every prompt here
 * return a shape rather than prose this process would have to parse out of a
 * paragraph — and a moderator whose verdict has to be extracted with a regular
 * expression is a moderator that will eventually approve something because it
 * wrote the word "approve" in an explanation.
 *
 * **It replaced `xiaomi/mimo-v2.5`, and the reasons are worth keeping.** That
 * model was served from a shared free pool — `limit_source:
 * upstream_provider_shared_pool` — and rate-limited hard enough that four of
 * four briefing syntheses failed or degraded in one hour. It also degenerated:
 * given one short tip it wrote a correct opening sentence and then repeated
 * `(1 local) (1 immediate) (1 one shot) …` until it exhausted the token budget,
 * truncating the reply inside a field and losing the one after it. Same price
 * per token, one megabyte of context, structured outputs on both.
 *
 * Overridable, because the choice is a judgement that will be revisited and the
 * alternative is a code change to try another model against the same corpus.
 */
export const MODERATION_MODEL = 'deepseek/deepseek-v4-flash'

/**
 * The model that measures similarity.
 *
 * A different model from the one that judges, and necessarily so: judging is a
 * chat completion and similarity is an embedding, and no model does both. This
 * one only ever narrows the field — **it never decides a merge**. See `dedup.ts`
 * for why that separation is the whole design rather than an implementation
 * detail.
 */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'

/**
 * The token ceiling on a synthesis, which is the only call here whose answer is a
 * document rather than a verdict.
 *
 * **2000 was too low, and the way it failed is the reason this is a named
 * constant rather than a literal.** `briefing.failed` fired on two seeded tasks
 * on 2026-08-05 with `finish_reason length` and **no content at all** — not a
 * truncated briefing, an empty one. A reply cut off inside its own JSON is at
 * least partly salvageable; a reply that never began is not.
 *
 * What was not accounted for is that **reasoning tokens are charged against this
 * ceiling and do not appear in the reply.** The model reasons first and writes
 * afterwards, so a budget sized for the document alone can be spent before the
 * first character of it is emitted — and from outside, that is indistinguishable
 * from a model that answered nothing.
 *
 * 8000 is four times the document this call has ever needed, deliberately: the
 * cost of a ceiling that is too high is tokens on a call that runs a few times an
 * hour, and the cost of one that is too low is a task whose briefing never gets
 * written, retried every poll for ever. Those are not the same size of mistake.
 *
 * Still bounded, for the reason the old comment gave and which still holds: a
 * briefing that wanted more than this is one claim per entry, which is the list
 * it was supposed to replace.
 */
export const BRIEFING_MAX_TOKENS = 8000

/**
 * The token ceiling on one verdict.
 *
 * **400 was too low, and it failed exactly the way the briefing ceiling above
 * failed one day earlier** (`#437`). `entry.moderate.failed` fired three times on
 * one advice entry between 01:24 and 01:26 on 2026-08-06, twice with
 * `finish_reason length` and no content at all.
 *
 * **The old number was sized for the answer, which is the mistake.** Its comment
 * reasoned entirely about the reply — *"the reason is read by a citizen whose
 * entry was refused, so it has to fit in a moderation note"* — and that is a true
 * sentence about a field that is capped at {@link MODERATION_NOTE_MAX_LENGTH}
 * characters elsewhere. It is not what `max_tokens` bounds. **Reasoning tokens
 * are charged against this ceiling and never appear in the reply**, so a budget
 * sized for a 500-character sentence is spent before the first character of it is
 * written, and from outside that is indistinguishable from a model that answered
 * nothing.
 *
 * That is the same paragraph {@link BRIEFING_MAX_TOKENS} already carries. The
 * lesson was learned on the one call whose answer is a document and not applied
 * to the two whose answers are short — and *short answer* is precisely the
 * argument that makes a ceiling look safe when it is not.
 *
 * **Raising it is close to free, which is why the headroom is generous.**
 * `max_tokens` caps what may be generated; it is not a spend. A verdict that
 * needed 300 tokens costs 300 whether this reads 400 or 4000. What the old number
 * bought was not economy, it was a deterministic failure: at `temperature: 0` the
 * same entry produces the same empty reply on every poll, the row stays
 * `pending`, and `loop.ts` tries it again for ever.
 */
export const CLASSIFY_MAX_TOKENS = 4000

/**
 * The token ceiling on one marking pass.
 *
 * Raised from 800 with {@link CLASSIFY_MAX_TOKENS} and for its reason rather than
 * for evidence of its own: this call has not been seen to fail, and it is the same
 * model reasoning against the same ceiling with a budget sized for the list it
 * writes. Waiting for it to fail too would be waiting for something already
 * understood.
 *
 * Still bounded, for the reason the old comment gave and which still holds: a
 * reply that wanted more than this is marking most of the text, which is the
 * failure mode this stage is most at risk of. That bound is now well clear of the
 * reasoning rather than sharing a budget with it.
 */
export const MARK_MAX_TOKENS = 4000

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
 * **The path, not the URL.** {@link OPENROUTER_BASE} is a constant in this file
 * and naming it again in every failure adds no information, while `AGENTS.md`
 * §9 is about not putting hosts of ours in logs at all. `/chat/completions` is
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

/** The transient empty completion observed in #599, and no wider failure class. */
function stoppedWithoutContent(body: unknown): boolean {
  const choice = (
    body as {
      choices?: {
        message?: { content?: unknown; refusal?: unknown }
        finish_reason?: unknown
      }[]
    }
  ).choices?.[0]
  const content = choice?.message?.content
  const refusal = choice?.message?.refusal

  return (
    choice?.finish_reason === 'stop' &&
    !(typeof content === 'string' && content.trim() !== '') &&
    !(typeof refusal === 'string' && refusal !== '')
  )
}

/**
 * The claims that were complete when the reply was cut off.
 *
 * **A truncated briefing is worth more than no briefing, and it used to be worth
 * nothing.** A reply cut off at the token ceiling ends mid-object, `JSON.parse`
 * throws on the whole string, and every claim the model finished writing — which
 * may be all but the last — was discarded with the fragment. At `temperature: 0`
 * that is not a bad hour: the same corpus produces the same truncated reply on
 * every poll, so the task's briefing is never written again.
 *
 * This is the same rule the rest of this file already follows in two other
 * places: **the failure has to degrade rather than latch.**
 *
 * It scans rather than repairs — no brace is added and no string is closed. Every
 * balanced object inside the array is handed to `JSON.parse` on its own, and one
 * that does not parse is dropped rather than guessed at. So the worst case is
 * fewer claims than the model wrote, never a claim it did not write.
 */
function salvageClaims(content: string): readonly unknown[] {
  const start = content.indexOf('[')
  if (start === -1) return []

  const claims: unknown[] = []
  let depth = 0
  let objectStart = -1
  let inString = false
  let escaped = false

  for (let i = start; i < content.length; i++) {
    const character = content[i]

    // A brace inside a string is text, and a claim's text may contain one.
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') inString = true
    else if (character === '{') {
      if (depth === 0) objectStart = i
      depth++
    } else if (character === '}') {
      depth--
      if (depth === 0 && objectStart !== -1) {
        try {
          claims.push(JSON.parse(content.slice(objectStart, i + 1)))
        } catch {
          // Balanced but not parseable. Dropped, for the reason above.
        }
        objectStart = -1
      }
    }
  }

  return claims
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
  const model = options.model ?? MODERATION_MODEL
  const embeddingModel = options.embeddingModel ?? EMBEDDING_MODEL
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
      response = await fetchImpl(`${OPENROUTER_BASE}${path}`, {
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

  const chat = async (
    body: unknown,
  ): Promise<{ readonly body: unknown; readonly accounting: ModelCall | undefined }> => {
    const response = await call('/chat/completions', body)
    // `stop` ordinarily means a complete answer. One empty response is a
    // provider anomaly; one immediate retry avoids delaying the entry until the
    // next poll, while a second empty response still fails visibly.
    return stoppedWithoutContent(response.body) ? call('/chat/completions', body) : response
  }

  return {
    name: model,

    async classify({ system, user, choices }) {
      const { body, accounting } = await chat({
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
        // Sized for the reasoning and not for the sentence — see
        // CLASSIFY_MAX_TOKENS, which is what `#437` was.
        max_tokens: CLASSIFY_MAX_TOKENS,
        // Judging the same text twice should reach the same verdict. This is a
        // classification, not a composition.
        temperature: 0,
      })

      /**
       * **The ceiling is passed so the refusal can name it** (`#437`). Without it
       * `messageContent` says only `finish_reason length`, which is the symptom
       * with the actionable half left out — the briefing call has passed it since
       * `#416` and these two never did, so the one log line that would have
       * pointed straight at the number did not carry it.
       */
      return {
        ...parseVerdict(
          messageContent(body, CLASSIFY_MAX_TOKENS),
          choices,
          finishReason(body),
          CLASSIFY_MAX_TOKENS,
        ),
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
        // See MARK_MAX_TOKENS. Sized clear of the reasoning rather than sized to
        // the list, which is what `#437` corrected here and in `classify`.
        max_tokens: MARK_MAX_TOKENS,
        temperature: 0,
      })
      const content = messageContent(body, MARK_MAX_TOKENS)

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
        // The largest ceiling in this file, because this is the only call whose
        // answer is a document rather than a verdict. See BRIEFING_MAX_TOKENS for
        // why the number is what it is and what happened at the previous one.
        max_tokens: BRIEFING_MAX_TOKENS,
        temperature: 0,
      })
      const content = messageContent(body, BRIEFING_MAX_TOKENS)
      const truncated = finishReason(body) === 'length'

      let claims: readonly unknown[]
      try {
        const parsed = JSON.parse(content) as { claims?: unknown }
        if (!Array.isArray(parsed.claims)) {
          throw new Error('the model returned a briefing without a claims array')
        }
        claims = parsed.claims
      } catch (error) {
        // Only a reply the model itself said was cut off is salvaged. Anything
        // else that will not parse is malformed rather than incomplete, and
        // reading a malformed reply optimistically is how a briefing ends up
        // saying something nobody wrote.
        if (!truncated) throw error

        claims = salvageClaims(content)
        if (claims.length === 0) {
          throw new Error(
            `the briefing was cut off at the ${BRIEFING_MAX_TOKENS}-token ceiling before one claim was complete`,
            { cause: error },
          )
        }

        log.warn(`${model} was cut off mid-briefing; kept ${claims.length} complete claim(s)`, {
          event: 'model.briefing.truncated',
          model,
          kept: claims.length,
          ceiling: BRIEFING_MAX_TOKENS,
        })
      }

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
