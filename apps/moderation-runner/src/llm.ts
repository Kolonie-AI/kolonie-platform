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

import { silentLog, type Log } from '@kolonie-ai/core'

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

/** What a classification prompt is allowed to answer. */
export interface Classification {
  readonly decision: string
  readonly reason: string
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

  const call = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${OPENROUTER_BASE}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(
        `OpenRouter answered ${response.status} for ${path}${await diagnose(response, apiKey)}`,
      )
    }

    return (await response.json()) as unknown
  }

  return {
    name: model,

    async classify({ system, user, choices }) {
      const body = await call('/chat/completions', {
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
        // The reason is read by a citizen whose entry was refused, so it has to
        // fit in a moderation note. See MODERATION_NOTE_MAX_LENGTH in core.
        max_tokens: 400,
        // Judging the same text twice should reach the same verdict. This is a
        // classification, not a composition.
        temperature: 0,
      })

      const content = (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]
        ?.message?.content

      if (typeof content !== 'string') {
        throw new Error('OpenRouter returned no message content')
      }

      const parsed = JSON.parse(content) as Partial<Classification>
      if (typeof parsed.decision !== 'string' || typeof parsed.reason !== 'string') {
        throw new Error('the model returned a verdict without a decision and a reason')
      }
      if (!choices.includes(parsed.decision)) {
        throw new Error(`the model answered '${parsed.decision}', which was not on offer`)
      }

      return { decision: parsed.decision, reason: parsed.reason }
    },

    async mark({ system, user, kinds }) {
      const body = await call('/chat/completions', {
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
        // Larger than `classify`'s ceiling because the answer is a list rather
        // than a sentence, and a report at the 2000-character limit can honestly
        // carry several spans. Still bounded: a reply that wanted more than this
        // is marking most of the text, which is the failure mode this stage is
        // most at risk of.
        max_tokens: 800,
        temperature: 0,
      })

      const content = (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]
        ?.message?.content

      if (typeof content !== 'string') {
        throw new Error('OpenRouter returned no message content')
      }

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
      const body = await call('/chat/completions', {
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
        /**
         * The largest ceiling in this file, because this is the only call whose
         * answer is a document rather than a verdict. Still bounded: a briefing
         * that wanted more than this is one claim per entry, which is the list it
         * was supposed to replace.
         */
        max_tokens: 2000,
        temperature: 0,
      })

      const content = (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]
        ?.message?.content

      if (typeof content !== 'string') {
        throw new Error('OpenRouter returned no message content')
      }

      const parsed = JSON.parse(content) as { claims?: unknown }
      if (!Array.isArray(parsed.claims)) {
        throw new Error('the model returned a briefing without a claims array')
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
      const kept = parsed.claims.flatMap((claim) => {
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

      const body = await call('/embeddings', { model: embeddingModel, input: [...inputs] })
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
