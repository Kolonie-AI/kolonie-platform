import { z } from 'zod'
import { type GatewayService } from './gateway.js'

/**
 * What a service asks for, instead of naming a model (`#1694`).
 *
 * ## Why a tier and not a slug
 *
 * The operator's decision of 2026-08-25: the Colony talks only to
 * OpenAI-compatible gateways, and **the model choice lives at the gateway**. A
 * slug compiled into this repository makes changing which model answers cost a
 * release; a tier makes it cost a dashboard edit. What travels in the request is
 * the tier string, and which model serves it is configured where the gateway is.
 *
 * ## Why the string is sent unchanged
 *
 * Both gateways express a tier as a **preset referenced as a model id**.
 * Measured 2026-08-25 against both live gateways with six service keys each,
 * `@preset/tier-1`, `@preset/tier-2` and `@preset/tier-3` returned HTTP 200 with
 * a correct answer on both, 12 of 12. So there is no per-gateway prefix, no
 * spelling table and no normalisation function: a gateway needing a different
 * spelling would be a gateway configuration question, and it is not one today.
 *
 * ## A tier-1 preset must not carry its own fallback chain
 *
 * A preset can hold an internal `models` array that silently substitutes a
 * weaker model. For `tier-1` that would defeat D-122 §4 **from inside the
 * gateway**, where no test in this repository can see it: quest moderation
 * refuses to fall back precisely because since `#693` that verdict is the
 * publication, and a substitution the code cannot observe is that fallback
 * happening anyway. Whoever configures a `tier-1` preset reads this here.
 */
export const CAPABILITY_TIERS = ['@preset/tier-1', '@preset/tier-2', '@preset/tier-3'] as const

/**
 * The closed set, as a schema with its type derived — `AGENTS.md` §3.
 *
 * A service naming a tier outside the set is a compile error rather than a
 * request the gateway answers 400 to at three in the morning.
 */
export const CapabilityTierSchema = z.enum(CAPABILITY_TIERS)

/** One of the three tiers the Colony asks for. */
export type CapabilityTier = z.infer<typeof CapabilityTierSchema>

/**
 * The strongest model available, for judgements the Colony cannot take back.
 *
 * Quest moderation and the red-line pass: since `#693` a quest that clears
 * moderation is published by that verdict, so a weaker judgement here is paid
 * work published on a judgement nobody chose.
 */
export const TIER_1: CapabilityTier = '@preset/tier-1'

/** A capable general model — the ordinary working tier, and the one to reach for by default. */
export const TIER_2: CapabilityTier = '@preset/tier-2'

/** The cheap, fast model: classification and high-volume passes, where a wrong answer is cheap. */
export const TIER_3: CapabilityTier = '@preset/tier-3'

/** The service-level capability assignment used by every gateway. */
export const SERVICE_TIERS: Record<GatewayService, CapabilityTier> = {
  moderation: TIER_1,
  worker: TIER_1,
  verifier: TIER_2,
  triage: TIER_2,
  doctor: TIER_2,
  reviewer: TIER_2,
}

/**
 * The operator's ceiling for one service, and it is unset in the ordinary case
 * (`#1694`).
 *
 * **`max_tokens` is a ceiling, not a reservation.** The model stops on its own,
 * so a number set here can only ever be too small — and the damage is silent,
 * because a truncated reply is still well-formed. What replaces it is
 * {@link throwIfTruncated}, which catches a cut-off answer at *any* ceiling,
 * including one the gateway imposes that no constant here can see.
 *
 * This exists so the cost lever is still available to somebody containing an
 * incident, without putting a figure in the normal path. Named per service for
 * the reason `GATEWAY_API_KEY_VARS` is: containing one service's runaway
 * loop must not cap the other five with it.
 */
export const GATEWAY_MAX_TOKENS_VARS: Record<GatewayService, string> = {
  verifier: 'LLM_GATEWAY_MAX_TOKENS_VERIFIER',
  moderation: 'LLM_GATEWAY_MAX_TOKENS_MODERATION',
  triage: 'LLM_GATEWAY_MAX_TOKENS_TRIAGE',
  reviewer: 'LLM_GATEWAY_MAX_TOKENS_REVIEWER',
  doctor: 'LLM_GATEWAY_MAX_TOKENS_DOCTOR',
  worker: 'LLM_GATEWAY_MAX_TOKENS_WORKER',
} as const

/**
 * The ceiling an operator set for this service, or nothing at all.
 *
 * **Unset means the field is absent from the request body**, never a default
 * number: a figure in the normal path is one a later reader mistakes for a
 * considered limit and adjusts.
 *
 * A value that is not a positive whole number reads as unset rather than as a
 * ceiling of zero. Compose writes `${VAR:-}` for every optional variable, so
 * unset arrives as an empty string, and a ceiling of zero would refuse every
 * call in the name of containing an incident.
 */
export function maxTokensFromEnvironment(
  service: GatewayService,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = (env[GATEWAY_MAX_TOKENS_VARS[service]] ?? '').trim()
  if (raw === '') return undefined

  const ceiling = Number(raw)
  if (!Number.isInteger(ceiling) || ceiling <= 0) return undefined
  return ceiling
}
