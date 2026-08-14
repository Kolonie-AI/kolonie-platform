import {
  MAX_OPEN_ACCOUNT_PROOFS,
  OpenAccountProofRequestSchema,
  SubmitAccountProofRequestSchema,
  walkAsk,
  walkAskAsText,
  type AccountProofRefusal,
  type AgentId,
  type ApiError,
  type OpenAccountProof,
  type WalkAsk,
} from '@kolonie-ai/core'
import type {
  Database,
  SettingsReader,
  InboundProofOutcome,
  MintOutcome,
  OpenProofRow,
  ProofRedemption,
} from '@kolonie-ai/db'
import {
  mintAccountProof,
  openAccountProof,
  recordInboundProof,
  redeemPostProof,
} from '@kolonie-ai/db'
import { fetchPage, type PageRead, type PageReader } from '@kolonie-ai/verifiers'
import { fieldErrors } from './validation.js'

/**
 * Two proofs, hundreds of providers (`#520`).
 *
 * ## The gap this closes
 *
 * `proved = true` on an `accounts` row could only be set by a rung, so the number
 * of account kinds the Colony can vouch for was capped by the number of verifiers
 * it had written. An agent holding a Trello account, a Notion workspace and a
 * Discord login had three assertions and no proof.
 *
 * The data model was already free of this — `AccountKindSchema` takes any
 * kebab-case slug and `KNOWN_ACCOUNT_KINDS` is documented as a vocabulary rather
 * than a constraint. What cost something was proving it.
 *
 * ## Why two, and why these two
 *
 * D-059 for quests: *one verifier serves every quest, so a new quest costs a form
 * and not a deploy.* Almost every provider demonstrates possession one of two
 * ways, and the Colony already reads both:
 *
 * - **It sends mail to an address you control.** `recordInboundMail` reads inbound
 *   mail for the mailbox badge. Here the same machinery reads a provider's message
 *   the citizen forwarded on.
 * - **It lets you publish something.** `kolonie.operator.claim` reads a minted
 *   string at a named URL. Here the same shape, pointed at a profile page or a
 *   public paste rather than at a post on X.
 *
 * ## What a generic proof is worth, said in the code and not only in a comment
 *
 * **It is weaker than a rung and the register records which it is.** A rung's
 * verifier read something the Colony chose; these read something the citizen
 * arranged. `accounts.proved_by` carries the answer, a check constraint keeps it
 * present on every proved row, and no read surface returns `proved` without it.
 *
 * **No capability is claimed by either.** `capabilities` is what a verdict proved
 * an account can *do*; possession is not one of those, and writing `publish`
 * because a citizen published something would be the conflation this issue is
 * about wearing a different costume.
 *
 * **No credential is asked for.** Proving possession never means handing over a
 * password. The vault exists and is the citizen's; nothing here touches it.
 */

/** The proofs' half of storage, behind a port so this app's tests need no PostgreSQL. */
export interface AccountProofs {
  mint(
    agentId: AgentId,
    input: {
      kind: string
      identifier: string
      method: 'provider-mail' | 'provider-post'
      provider?: string | null
    },
  ): Promise<MintOutcome>
  open(agentId: AgentId, id: string): Promise<OpenProofRow | undefined>
  redeemPost(agentId: AgentId, id: string, url: string): Promise<ProofRedemption>
  inbound(token: string, from: string): Promise<InboundProofOutcome>
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseAccountProofs(db: Database, settings?: SettingsReader): AccountProofs {
  return {
    mint: (agentId, input) =>
      mintAccountProof(
        db,
        agentId,
        {
          kind: input.kind as never,
          identifier: input.identifier,
          method: input.method,
          provider: (input.provider ?? null) as never,
        },
        // The pace cap (`#532`). Absent means no cap rather than a cap of zero.
        settings,
      ),
    open: (agentId, id) => openAccountProof(db, agentId, id),
    redeemPost: (agentId, id, url) => redeemPostProof(db, agentId, id, url),
    inbound: (token, from) => recordInboundProof(db, token, from),
  }
}

export interface AccountProofDependencies {
  readonly proofs: AccountProofs
  /** The host the forwarding addresses live on. This app composes them; `db` holds no host names. */
  readonly challengeDomain: string
  /**
   * How the Colony reads the page, behind the port the website rung already has.
   *
   * **{@link fetchPage} and not a fetcher of this module's own**, which is the
   * whole of `#520`'s claim that nothing new is built: that function is the one
   * SSRF-guarded reader in the codebase — resolving before connecting, refusing
   * every private range, re-checking after each redirect — and it already sorts its
   * failures into *the page is not there* and *nothing answered*, which are exactly
   * the two a citizen needs told apart.
   */
  readonly reader?: PageReader
}

export type ProofOutcome<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * What a refusal says, in one place so the wording cannot drift between the route
 * and the tool.
 *
 * The same arrangement `claimRefusal` has in `operator-claim.ts`, and for the
 * reason stated there: an agent reads one of these and not the set, so each has to
 * name what is missing and what to do instead.
 */
export function proofRefusal(reason: AccountProofRefusal, detail = ''): ApiError {
  if (reason === 'no-proved-mailbox') {
    return {
      code: 'conflict',
      message:
        'A mail proof arrives from the mailbox you proved at email-inbox, and the Colony has ' +
        'none on record for you. Earn `mailbox` first, or prove this account by publishing ' +
        'instead — open the proof again with method `provider-post`.',
    }
  }

  if (reason === 'no-open-proof') {
    return {
      code: 'conflict',
      message:
        'There is no proof outstanding under that id for you. A proof is single-use and ' +
        'expires, so one already spent or timed out cannot be presented twice — open a new one ' +
        'and publish the new string.',
    }
  }

  if (reason === 'wrong-method') {
    return {
      code: 'validation_failed',
      message:
        'That proof is a mail proof, and a mail proof has nothing to submit: forward the ' +
        "provider's message to the address you were given and the arrival closes it.",
    }
  }

  if (reason === 'secret-not-at-url') {
    return {
      code: 'validation_failed',
      message:
        'The Colony read that address and did not find your string in it. It has to appear in ' +
        'the page itself, exactly as it was issued — not behind a login, not rendered by ' +
        'JavaScript after loading, and not shortened. Anything else on the page is yours.',
    }
  }

  if (reason === 'url-refused') {
    return {
      code: 'validation_failed',
      message: `The Colony will not fetch that address, and this will not change on a retry: ${detail}`,
    }
  }

  if (reason === 'url-unavailable') {
    /**
     * **Never `not_found` or `validation_failed`.** A page being unreachable is not
     * evidence that the string is absent, and telling a citizen who published
     * correctly that its string could not be found sends it to look for a mistake
     * that is not its own. The same distinction `claimRefusal` draws for X being
     * down, and `internal` carries a 503 at the route for the same reason.
     */
    return {
      code: 'internal',
      message: `The Colony could not read that address, and this is not your problem: ${detail} Nothing has been spent — try the same address again later.`,
    }
  }

  if (reason === 'too-many-open') {
    return {
      code: 'conflict',
      message:
        `You already have ${MAX_OPEN_ACCOUNT_PROOFS} proofs open. Finish one or let it expire ` +
        'before opening another — this is a bound on minting strings, not a limit on how many ' +
        'accounts you may hold.',
    }
  }

  return {
    code: 'conflict',
    message:
      'Another citizen has already proved that account, and one instrument names one citizen. ' +
      'If it is genuinely yours, open a support ticket rather than trying again — nothing here ' +
      'can resolve it.',
  }
}

/**
 * Open a proof.
 *
 * Authenticated as the citizen, because the string has to bind to *this* agent: a
 * string anybody could request would be evidence about nobody, which is the
 * argument `openOperatorClaimChallenge` makes in the same words.
 */
export async function openProof(
  agentId: AgentId,
  body: unknown,
  deps: AccountProofDependencies,
): Promise<ProofOutcome<OpenAccountProof>> {
  const parsed = OpenAccountProofRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Name the kind of account, the identifier you hold it under, and how you want to ' +
          'prove it — `provider-mail` to forward a message the provider sent you, or ' +
          '`provider-post` to publish a string somewhere the account controls. The kind can be ' +
          'anything the Colony has never heard of: `trello`, `notion`, whatever it is.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  /**
   * A mail proof needs somewhere to receive the forwarded message, and a
   * deployment without `EMAIL_CHALLENGE_DOMAIN` has none.
   *
   * **Refused rather than answered with an address that has no host**, which is
   * what composing against an empty string would produce: `kol_acct_…@`, a value a
   * citizen would spend an afternoon trying to forward to. The post proof needs no
   * host and stays available, so this refuses one method rather than the surface.
   */
  if (parsed.data.method === 'provider-mail' && deps.challengeDomain === '') {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The Colony cannot receive forwarded mail on this deployment, so a mail proof cannot ' +
          'be opened here. A post proof needs nothing configured — open it again with method ' +
          '`provider-post`.',
      },
    }
  }

  const minted = await deps.proofs.mint(agentId, {
    kind: parsed.data.kind,
    identifier: parsed.data.identifier,
    method: parsed.data.method,
    provider: parsed.data.provider ?? null,
  })

  if (minted.outcome === 'no-proved-mailbox') {
    return { outcome: 'rejected', error: proofRefusal('no-proved-mailbox') }
  }

  if (minted.outcome === 'too-many-open') {
    return { outcome: 'rejected', error: proofRefusal('too-many-open') }
  }

  if (minted.outcome === 'already-proved-by-another') {
    return { outcome: 'rejected', error: proofRefusal('already-proved-by-another') }
  }

  /**
   * The pace cap, answered as a wait rather than as a failure (`#532`).
   *
   * **`conflict` and not `rate_limited`**, which is the near-miss worth explaining: a
   * rate limit is about protecting the Colony from a caller, and this is the Colony
   * protecting the *caller's own register* from a pattern that gets accounts flagged.
   * The message says whose limit it is and what happens next, because an agent told
   * only *slow down* will read it as having done something wrong.
   */
  if (minted.outcome === 'defer') {
    const hours = Math.max(1, Math.round(minted.retryAfterMs / 3_600_000))

    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your operator has had ${minted.used} of ${minted.ceiling} accounts at this provider ` +
          `in the last day, so this one waits about ${hours} hour${hours === 1 ? '' : 's'}. ` +
          'Nothing is lost and nothing is spent — come back and open it then, and the recipe ' +
          'continues where it stopped.\n\n' +
          'This is not a limit on you and not something you did wrong. A provider does not see ' +
          'agents; it sees one responsible party, so a swarm signing up in parallel looks like ' +
          'one party signing up many times — and that is the pattern that gets every account ' +
          'flagged, including the ones already working.',
      },
    }
  }

  return {
    outcome: 'ok',
    response: {
      id: minted.proof.id,
      kind: minted.proof.kind,
      identifier: minted.proof.identifier,
      method: minted.proof.method,
      secret: minted.proof.secret,
      forwardTo:
        minted.proof.token === null ? null : `${minted.proof.token}@${deps.challengeDomain}`,
      expiresAt: minted.proof.expiresAt,
    },
  }
}

/** What a closed proof says back. */
export type ProvedAccount = {
  readonly kind: string
  readonly identifier: string
  /** Named in the response, because the strength is part of what was granted. */
  readonly provedBy: 'provider-mail' | 'provider-post'
  /**
   * The walk, asked for at the one moment it can still be answered (`#907`).
   *
   * **Absent where the citizen named no provider**, which is the honest answer
   * rather than a guessed one: a walk is keyed on `(kind, provider)` and an ask
   * the Colony cannot prefill is the form-filling this is built to remove.
   *
   * **An offer and never a gate.** The proof above it is complete, recorded and
   * paid for whether or not this is answered — see {@link WALK_ASK_COSTS_NOTHING},
   * which the ask carries so that no surface has to remember to say it.
   */
  readonly walk?: WalkAsk
}

/**
 * Submit a `provider-post` proof: the Colony fetches the address and looks.
 *
 * **The fetch happens before the spend and the spend happens in one transaction.**
 * A proof is not consumed by an attempt that found nothing — a citizen whose page
 * had not deployed yet would otherwise lose the string and have to open another,
 * which is the failure `reachability.check` exists to spare the web rungs.
 */
export async function submitPostProof(
  agentId: AgentId,
  proofId: string,
  body: unknown,
  deps: AccountProofDependencies,
): Promise<ProofOutcome<ProvedAccount>> {
  const parsed = SubmitAccountProofRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send the address where you published the string, as an http or https URL — the page ' +
          'itself rather than the profile it hangs off.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const proof = await deps.proofs.open(agentId, proofId)
  if (proof === undefined) return { outcome: 'rejected', error: proofRefusal('no-open-proof') }
  if (proof.method !== 'provider-post') {
    return { outcome: 'rejected', error: proofRefusal('wrong-method') }
  }

  const reader: PageReader = deps.reader ?? { read: (url: string) => fetchPage(url) }
  const page: PageRead = await reader.read(parsed.data.url)

  /**
   * **`missing` and `unavailable` are answered differently, and this is the whole
   * reason the reader distinguishes them** (`#401`). A 4xx is the site answering
   * that there is no such page — the citizen's own address, just as true in five
   * minutes. Anything else is weather, and a citizen that published correctly must
   * not be told its string was absent because a name server shrugged.
   */
  if (page.outcome === 'missing') {
    return { outcome: 'rejected', error: proofRefusal('url-refused', page.reason) }
  }

  if (page.outcome === 'unavailable') {
    return { outcome: 'rejected', error: proofRefusal('url-unavailable', page.reason) }
  }

  if (!page.html.includes(proof.secret)) {
    return { outcome: 'rejected', error: proofRefusal('secret-not-at-url') }
  }

  const redeemed = await deps.proofs.redeemPost(agentId, proofId, parsed.data.url)

  if (redeemed.outcome === 'no-open-proof') {
    return { outcome: 'rejected', error: proofRefusal('no-open-proof') }
  }

  if (redeemed.outcome === 'already-proved-by-another') {
    return { outcome: 'rejected', error: proofRefusal('already-proved-by-another') }
  }

  return {
    outcome: 'ok',
    response: {
      kind: redeemed.kind,
      identifier: redeemed.identifier,
      provedBy: 'provider-post',
      ...(redeemed.provider === null
        ? {}
        : { walk: walkAsk({ kind: redeemed.kind, provider: redeemed.provider }) }),
    },
  }
}

/**
 * The instruction that goes with a minted string.
 *
 * **A string with no instruction beside it is the shape every agent gets wrong
 * once**, and the two methods want opposite next actions — one waits for a message
 * to arrive, the other names an address. Written here rather than in the tool's
 * description because it is about *this* proof: it carries the address, the string
 * and the deadline.
 */
export function openProofAsText(proof: OpenAccountProof): string {
  const shared =
    `It expires at ${proof.expiresAt} and is single-use. Nothing about this asks for a password: ` +
    `if the provider gave you one, it belongs in your vault and nowhere else.`

  if (proof.method === 'provider-mail') {
    return (
      `Forward a message ${proof.identifier}'s provider sent you to ${proof.forwardTo ?? ''}, ` +
      `from the mailbox you proved. The message has to carry ${proof.secret} — put it in the body ` +
      `if forwarding does not carry it for you. **It must come from your proved mailbox**: that ` +
      `is what makes the forward evidence rather than a mail anybody could send, and a message ` +
      `from any other address is dropped without a reply. ${shared}`
    )
  }

  return (
    `Publish ${proof.secret} somewhere your ${proof.kind} account ${proof.identifier} ` +
    `demonstrably controls — its own profile page, its bio, a paste it owns — then call ` +
    `kolonie.accounts.prove-submit with the address. The string has to be in the page as served: ` +
    `not behind a login, and not written in by JavaScript after it loads. Anything else on the ` +
    `page is yours. ${shared}`
  )
}

/**
 * What the Colony says about a closed proof, written for the citizen that opened
 * it.
 *
 * **It names the strength out loud.** A citizen told only *proved* would carry a
 * belief the register does not: `proved_by` says the Colony read something the
 * citizen arranged, and a rung is a different claim. Saying so here is cheaper
 * than a citizen discovering it from a refusal later.
 */
export function proofAsText(proved: ProvedAccount): string {
  const how =
    proved.provedBy === 'provider-mail'
      ? 'a message you forwarded from the mailbox you proved'
      : 'a string you published at an address you named'

  return (
    `Your ${proved.kind} account ${proved.identifier} is now in the register as proved, on ${how}. ` +
    `That is recorded as a ${proved.provedBy} proof and not as a rung: a rung's verifier reads ` +
    `something the Colony chose, and this read something you arranged. Both are worth having and ` +
    `anything reading the register can tell them apart. No capability is claimed by it — it says ` +
    `you hold the account, and nothing about what it can do.` +
    /**
     * **The ask rides on the response and is the last thing in it** (`#907`),
     * after everything the citizen was actually owed. An ask above the verdict
     * reads as a condition of it, which is the one thing this must never be.
     */
    (proved.walk === undefined ? '' : walkAskAsText(proved.walk))
  )
}
