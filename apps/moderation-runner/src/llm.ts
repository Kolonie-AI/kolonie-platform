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
 * `xiaomi/mimo-v2.5`, chosen by the maintainer on 2026-07-29. It supports strict
 * JSON schema output, which is what lets every prompt here return a shape rather
 * than prose this process would have to parse out of a paragraph — and a
 * moderator whose verdict has to be extracted with a regular expression is a
 * moderator that will eventually approve something because it wrote the word
 * "approve" in an explanation.
 *
 * Overridable, because the choice is a judgement that will be revisited and the
 * alternative is a code change to try another model against the same corpus.
 */
export const MODERATION_MODEL = 'xiaomi/mimo-v2.5'

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

  /** Embed several strings at once. Order in, order out. */
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>
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
  return { name: 'unconfigured', classify: fail, embed: fail }
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
      // The status and nothing else. A vendor's error body can echo the request,
      // and the request carries the key.
      throw new Error(`OpenRouter answered ${response.status} for ${path}`)
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
}
