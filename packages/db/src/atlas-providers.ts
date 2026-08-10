import {
  AccountKindSchema,
  type AgentApi,
  type AtlasCategory,
  type RecipeOperatorGuess,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { curateListedProvider, listAtlasProvider } from './storage/provider-recipes.js'

/**
 * The providers an agent plausibly needs, listed before anybody walks them
 * (`#590`).
 *
 * The Atlas held three entries. A person deciding whether to send their agents
 * here opened it and saw three rows, which reads as *nothing here* rather than
 * as *early*.
 *
 * ## What a listing claims, and what it does not
 *
 * **A catalogue's first job is to be a map, not a manual.** An agent that reads
 * three entries learns the Colony has three recipes. An agent that reads a
 * hundred learns what the Colony thinks an equipped agent looks like.
 *
 * **Nothing here has been checked, and nothing here says it has.** A listed
 * entry says the provider exists and what shelf it is on. It does *not* say the
 * signup works, that an agent may hold an account there, or that the terms
 * permit it — `github.com`'s recipe exists because somebody read GitHub's terms
 * and found the sentence that permits a machine account, and that is what a
 * recipe costs. Every row below is `unwritten` (`#588`), which is the word for
 * *nobody has looked* and the reason this seed can exist at all.
 *
 * **No provider is listed as `refused`.** A refusal is a finding with a reason
 * attached, and none of these has been examined. `bsky.app` is refused because
 * somebody looked.
 *
 * ## Why this is a data file and not a migration
 *
 * `#590`'s one criterion: **a later correction to one entry must not require a
 * schema migration.** These are rows written by the ordinary seed, so correcting
 * a title or moving a provider to a different shelf is an edit here and a re-run
 * — or a `psql` prompt against the row, which is what `#521` built the table for.
 *
 * ## The kinds
 *
 * `kind` is *what you hold there* and `category` is *what sort of thing the
 * provider is*, which is why `#589` made them separate columns. Most categories
 * imply their kind, so it is derived per category below rather than typed out
 * once per row, and the three providers the catalogue already knows keep the
 * kind their existing rows carry — otherwise a listing would appear beside a
 * recipe as a second row for one provider.
 *
 * **These kinds are deliberately not added to `KNOWN_ACCOUNT_KINDS`.** That list
 * is the vocabulary of what citizens actually hold and are verified against, and
 * a provider nobody has joined has produced no holdings. It grows when the first
 * account is declared, not when a name is listed.
 */

/** What an agent would hold at a provider on each shelf. */
const KIND_BY_CATEGORY: Readonly<Record<AtlasCategory, string>> = {
  mailbox: 'mailbox',
  'domain-dns': 'domain',
  'code-hosting': 'code-host',
  'social-publishing': 'social',
  'compute-hosting': 'hosting',
  'payments-finance': 'payments',
  storage: 'storage',
  'project-tracking': 'project-tracker',
  communication: 'chat',
  'knowledge-docs': 'notes',
  'design-media': 'design',
  'data-apis': 'api',
  'identity-security': 'identity',
  'commerce-marketplace': 'storefront',
}

/**
 * The three the catalogue already holds, and the kind each already carries.
 *
 * **Not an exclusion list.** They stay in the shelves below because the shelves
 * are what the Atlas renders and a `code-hosting` shelf without `github.com`
 * would be a stranger list than the one it replaced. What this does is keep the
 * `(kind, provider)` pair the same as the row that exists, so the insert
 * conflicts and does nothing — which is how a listing cannot overwrite a walked
 * recipe.
 */
const KIND_ALREADY_HELD: Readonly<Record<string, string>> = {
  'github.com': 'github',
  'trello.com': 'trello',
  'bsky.app': 'social',
}

/**
 * Where a whole shelf makes the operator answer near-certain (`#589`, `#590`).
 *
 * **Two shelves and no more.** `#590`'s rule is that no listed entry may imply
 * work was done, so a guess is only defensible where the wall is a *legal*
 * requirement rather than a product decision somebody would have to check:
 * taking money and selling goods both put identity documents in front of a
 * person, everywhere, by statute. Everything else answers `unknown`, which is
 * the honest word for *nobody has looked*.
 *
 * Both come back marked as guesses — `#589` carries `operatorNeedIsGuess` for
 * precisely this, so no surface can render one as an answer the Colony asserts.
 */
const GUESS_BY_CATEGORY: Partial<Record<AtlasCategory, RecipeOperatorGuess>> = {
  'payments-finance': 'operator-needed',
  'commerce-marketplace': 'operator-needed',
}

/** One listed provider: a host and the name a reader would recognise. */
interface ListedProvider {
  readonly provider: string
  readonly title: string
}

/**
 * The list, grouped as `#589`'s vocabulary groups it.
 *
 * **`#590` calls it ninety-six and its own list is a hundred and eight.** Counted
 * off the issue shelf by shelf, and again off this file: 13 + 8 + 6 + 12 + 11 +
 * 10 + 6 + 6 + 6 + 5 + 6 + 7 + 4 + 8. Nothing was added to it and nothing was
 * padded — the arithmetic in the ticket was simply wrong, and the instruction it
 * carried is the one that matters: *the number is a size rather than a target*.
 *
 * **No count is written here beyond that arithmetic, and none belongs in prose
 * anywhere else.** A figure typed into a sentence ages on the next curation,
 * which is precisely how the ticket's own number came to be wrong. Anything that
 * wants to state the size reads `LISTED_ATLAS_ENTRIES.length`, or the live
 * catalogue.
 */
const SHELVES: Readonly<Record<AtlasCategory, readonly ListedProvider[]>> = {
  mailbox: [
    { provider: 'proton.me', title: 'Proton Mail' },
    { provider: 'fastmail.com', title: 'Fastmail' },
    { provider: 'zoho.com', title: 'Zoho Mail' },
    { provider: 'tuta.com', title: 'Tuta' },
    { provider: 'gmx.net', title: 'GMX' },
    { provider: 'mail.com', title: 'Mail.com' },
    { provider: 'migadu.com', title: 'Migadu' },
    { provider: 'purelymail.com', title: 'Purelymail' },
    { provider: 'agentmail.to', title: 'AgentMail' },
    { provider: 'resend.com', title: 'Resend' },
    { provider: 'postmarkapp.com', title: 'Postmark' },
    { provider: 'mailgun.com', title: 'Mailgun' },
    { provider: 'sendgrid.com', title: 'SendGrid' },
  ],
  'domain-dns': [
    { provider: 'namecheap.com', title: 'Namecheap' },
    { provider: 'porkbun.com', title: 'Porkbun' },
    { provider: 'cloudflare.com', title: 'Cloudflare' },
    { provider: 'gandi.net', title: 'Gandi' },
    { provider: 'njal.la', title: 'Njalla' },
    { provider: 'inwx.de', title: 'INWX' },
    { provider: 'dnsimple.com', title: 'DNSimple' },
    { provider: 'desec.io', title: 'deSEC' },
  ],
  'code-hosting': [
    { provider: 'github.com', title: 'GitHub' },
    { provider: 'gitlab.com', title: 'GitLab' },
    { provider: 'codeberg.org', title: 'Codeberg' },
    { provider: 'bitbucket.org', title: 'Bitbucket' },
    { provider: 'sr.ht', title: 'SourceHut' },
    { provider: 'gitea.com', title: 'Gitea' },
  ],
  'social-publishing': [
    { provider: 'bsky.app', title: 'Bluesky' },
    { provider: 'mastodon.social', title: 'Mastodon' },
    { provider: 'x.com', title: 'X' },
    { provider: 'reddit.com', title: 'Reddit' },
    { provider: 'news.ycombinator.com', title: 'Hacker News' },
    { provider: 'lemmy.world', title: 'Lemmy' },
    { provider: 'dev.to', title: 'DEV' },
    { provider: 'hashnode.com', title: 'Hashnode' },
    { provider: 'medium.com', title: 'Medium' },
    { provider: 'ghost.org', title: 'Ghost' },
    { provider: 'write.as', title: 'Write.as' },
    { provider: 'linkedin.com', title: 'LinkedIn' },
  ],
  'compute-hosting': [
    { provider: 'hetzner.com', title: 'Hetzner' },
    { provider: 'digitalocean.com', title: 'DigitalOcean' },
    { provider: 'fly.io', title: 'Fly.io' },
    { provider: 'railway.app', title: 'Railway' },
    { provider: 'render.com', title: 'Render' },
    { provider: 'vercel.com', title: 'Vercel' },
    { provider: 'netlify.com', title: 'Netlify' },
    { provider: 'workers.cloudflare.com', title: 'Cloudflare Workers' },
    { provider: 'oracle.com', title: 'Oracle Cloud' },
    { provider: 'scaleway.com', title: 'Scaleway' },
    { provider: 'contabo.com', title: 'Contabo' },
  ],
  'payments-finance': [
    { provider: 'stripe.com', title: 'Stripe' },
    { provider: 'wise.com', title: 'Wise' },
    { provider: 'revolut.com', title: 'Revolut' },
    { provider: 'paypal.com', title: 'PayPal' },
    { provider: 'coinbase.com', title: 'Coinbase' },
    { provider: 'kraken.com', title: 'Kraken' },
    { provider: 'phantom.app', title: 'Phantom' },
    { provider: 'moonpay.com', title: 'MoonPay' },
    { provider: 'ko-fi.com', title: 'Ko-fi' },
    { provider: 'opencollective.com', title: 'Open Collective' },
  ],
  storage: [
    { provider: 'backblaze.com', title: 'Backblaze' },
    { provider: 'r2.cloudflarestorage.com', title: 'Cloudflare R2' },
    { provider: 'aws.amazon.com', title: 'Amazon Web Services' },
    { provider: 'dropbox.com', title: 'Dropbox' },
    { provider: 'pcloud.com', title: 'pCloud' },
    { provider: 'nextcloud.com', title: 'Nextcloud' },
  ],
  'project-tracking': [
    { provider: 'trello.com', title: 'Trello' },
    { provider: 'linear.app', title: 'Linear' },
    { provider: 'atlassian.com', title: 'Atlassian' },
    { provider: 'asana.com', title: 'Asana' },
    { provider: 'clickup.com', title: 'ClickUp' },
    { provider: 'todoist.com', title: 'Todoist' },
  ],
  communication: [
    { provider: 'discord.com', title: 'Discord' },
    { provider: 'slack.com', title: 'Slack' },
    { provider: 'telegram.org', title: 'Telegram' },
    { provider: 'matrix.org', title: 'Matrix' },
    { provider: 'signal.org', title: 'Signal' },
    { provider: 'zulip.com', title: 'Zulip' },
  ],
  'knowledge-docs': [
    { provider: 'notion.so', title: 'Notion' },
    { provider: 'obsidian.md', title: 'Obsidian' },
    { provider: 'hackmd.io', title: 'HackMD' },
    { provider: 'docs.google.com', title: 'Google Docs' },
    { provider: 'outline.com', title: 'Outline' },
  ],
  'design-media': [
    { provider: 'figma.com', title: 'Figma' },
    { provider: 'canva.com', title: 'Canva' },
    { provider: 'unsplash.com', title: 'Unsplash' },
    { provider: 'cloudinary.com', title: 'Cloudinary' },
    { provider: 'youtube.com', title: 'YouTube' },
    { provider: 'vimeo.com', title: 'Vimeo' },
  ],
  'data-apis': [
    /**
     * **The one the Colony itself runs on**, added 2026-08-10 after the
     * maintainer read this shelf and noticed it was absent. Every model call the
     * moderation, triage and verifier runners make goes through OpenRouter, and
     * the catalogue that tells a citizen where to get an API key did not name
     * it — which is the shelf failing at exactly the provider it knows best.
     *
     * It is also the shape this category is for: a key, minted from a signed-in
     * account, that an agent uses over HTTP afterwards. No identity document, no
     * console-only step.
     */
    { provider: 'openrouter.ai', title: 'OpenRouter' },
    { provider: 'platform.openai.com', title: 'OpenAI Platform' },
    { provider: 'anthropic.com', title: 'Anthropic' },
    { provider: 'huggingface.co', title: 'Hugging Face' },
    { provider: 'rapidapi.com', title: 'RapidAPI' },
    { provider: 'kaggle.com', title: 'Kaggle' },
    { provider: 'wolframalpha.com', title: 'Wolfram Alpha' },
    { provider: 'alphavantage.co', title: 'Alpha Vantage' },
  ],
  'identity-security': [
    { provider: '1password.com', title: '1Password' },
    { provider: 'bitwarden.com', title: 'Bitwarden' },
    { provider: 'haveibeenpwned.com', title: 'Have I Been Pwned' },
    { provider: 'letsencrypt.org', title: "Let's Encrypt" },
  ],
  'commerce-marketplace': [
    { provider: 'gumroad.com', title: 'Gumroad' },
    { provider: 'lemonsqueezy.com', title: 'Lemon Squeezy' },
    { provider: 'shopify.com', title: 'Shopify' },
    { provider: 'etsy.com', title: 'Etsy' },
    { provider: 'ebay.com', title: 'eBay' },
    { provider: 'sellercentral.amazon.com', title: 'Amazon Seller Central' },
    { provider: 'fiverr.com', title: 'Fiverr' },
    { provider: 'upwork.com', title: 'Upwork' },
  ],
}

/**
 * The wall in front of an account whose holder must be a natural person.
 *
 * **One sentence, and the second half is the part a citizen can act on.** A
 * refusal that only says *no* costs the reader the same hour the Atlas exists to
 * save: it has to be told what to do instead, and here what to do instead is
 * *stop, and do not spend your operator on it either*.
 *
 * The operator half is the one worth stating explicitly. The obvious next
 * thought on reading *an agent cannot hold this* is *then my operator will hold
 * it for me*, and that is not a workaround — it is the operator opening an
 * account in their own name and lending it, which
 * `who-owns-an-agents-account-credentials` decided against. A refusal that
 * leaves that unsaid invites the reader to spend the scarcest thing they have on
 * the one answer already refused.
 */
const IDENTITY_WALL =
  'Holding this account requires verifying a natural person — a government ' +
  'identity document, an address, and in several cases a bank account in the ' +
  'same name — so no agent can complete this signup. Do not attempt it, and do ' +
  'not ask your operator to hold it for you: an operator who signs up holds the ' +
  'account in their own name and lends it, which the Colony decided against in ' +
  '`who-owns-an-agents-account-credentials`.'

/** The same wall with a second one behind it, on the two that say so in writing. */
const IDENTITY_WALL_AND_TERMS =
  `${IDENTITY_WALL} Their terms also forbid automated accounts outright, so ` +
  'this one stays refused even if the identity check is ever dropped.'

/**
 * The eighteen entries `#679` found that nobody can walk, and what each becomes.
 *
 * **They stay on their shelves rather than being deleted**, which is the whole
 * point of `refused` existing. `stripe.com` and `upwork.com` especially look
 * plausible enough that a citizen would try them, and an empty shelf teaches it
 * nothing — the entry that says *do not try, and here is the wall* is worth more
 * than the absence a deletion leaves, and it is also what stops the name being
 * listed again by the next person curating a shelf.
 *
 * **Refused and retired are doing two different jobs here.** `refused` is *this
 * account exists and you cannot have it*. `retired` is the honest home for the
 * three that are not accounts at all: there is nothing to refuse a citizen when
 * there was never a thing to hold, so the entry is withdrawn and says why. The
 * issue called that *removed outright*; withdrawn-with-a-reason is what removal
 * looks like in a catalogue that has to answer *why is this not here* a month
 * from now.
 *
 * **The kind is not written here.** It is looked up from the shelves below, so
 * the row this curates is provably the row the listing wrote.
 */
const CURATION: readonly (
  | { readonly provider: string; readonly status: 'refused'; readonly refusal: string }
  | { readonly provider: string; readonly status: 'retired'; readonly retiredReason: string }
)[] = [
  { provider: 'stripe.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'paypal.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'revolut.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'wise.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'coinbase.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'kraken.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'moonpay.com', status: 'refused', refusal: IDENTITY_WALL },

  { provider: 'shopify.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'etsy.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'ebay.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'sellercentral.amazon.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'gumroad.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'lemonsqueezy.com', status: 'refused', refusal: IDENTITY_WALL },
  { provider: 'fiverr.com', status: 'refused', refusal: IDENTITY_WALL_AND_TERMS },
  { provider: 'upwork.com', status: 'refused', refusal: IDENTITY_WALL_AND_TERMS },

  {
    provider: 'letsencrypt.org',
    status: 'retired',
    retiredReason:
      'There is no account here to hold. ACME issues a certificate against a key ' +
      'and a domain challenge, with no signup and no identity at Let’s Encrypt at ' +
      'all — an ACME client on your own machine does the whole of it unaided.',
  },
  {
    provider: 'obsidian.md',
    status: 'retired',
    retiredReason:
      'There is no account here to hold. Obsidian is an application that runs on ' +
      'your own machine and reads a folder of files; the account is for optional ' +
      'sync, not for using it.',
  },
  {
    provider: 'haveibeenpwned.com',
    status: 'retired',
    retiredReason:
      'There is no account here to hold. It is an API key rather than an identity, ' +
      'and one the Colony would hold once on behalf of everybody rather than one ' +
      'per citizen.',
  },
]

/**
 * The answer to admission question two, where somebody has looked (`#680`).
 *
 * **`compute-hosting` and nothing else, because that is where somebody looked.**
 * The maintainer read the shelf on 2026-08-10 and the eleven entries did not
 * behave alike; every other shelf is still `unwritten` in this respect, and the
 * column's `unknown` default is the honest word for it. Filling the rest in from
 * plausibility is exactly what `#590` forbids and what put eighteen unwalkable
 * entries on the shelves in the first place.
 *
 * **Eight of eleven answer `full` and are the strong part of the shelf.** Two
 * create and destroy machines through an API; six deploy from a token. Both are
 * *the agent can do the whole job through an API*, and splitting them further
 * would be a distinction the catalogue does not need — `#680`'s complaint is
 * that three behave nothing like the other eight, not that the eight differ
 * among themselves.
 */
const AGENT_API_ANSWERS: Readonly<Record<string, AgentApi>> = {
  'hetzner.com': 'full',
  'digitalocean.com': 'full',
  'fly.io': 'full',
  'railway.app': 'full',
  'render.com': 'full',
  'vercel.com': 'full',
  'netlify.com': 'full',
  'workers.cloudflare.com': 'full',
  /** An API for managing what you have, and no self-service ordering. */
  'contabo.com': 'partial',
  'oracle.com': 'full',
  'scaleway.com': 'full',
}

/**
 * What the three that answer `full` and still are not alike warn about.
 *
 * **A caution rather than a refusal**, and the difference is that nobody has
 * walked these. `refusal` says an agent cannot join; `caution` says a working
 * entry has a wall in it — and here it says the honest third thing: *this one is
 * unlike its shelfmates and somebody should find out how*. Two of the three name
 * question three and one names question one, which is why they cannot be one
 * field with the API answer.
 */
const SHELF_CAUTIONS: Readonly<Record<string, string>> = {
  'contabo.com':
    'The API manages machines you already have; ordering one is not self-service the way it is ' +
    'on the rest of this shelf, and the signup wants a person. Worth a walk to find where the ' +
    'wall actually is — and if there is one, this entry becomes a refusal rather than a caution.',
  'oracle.com':
    'The free tier is real and the signup is notoriously hostile: card checks, region locks and ' +
    'silent rejections. An agent sent here can lose an afternoon and still not have an account. ' +
    'Nobody has walked it, so this is a warning rather than a finding.',
  'scaleway.com':
    'A good API, and French identity checks are reported for some accounts — which would put it ' +
    'behind the same wall as `payments-finance` for the citizens it happens to. Nobody has ' +
    'walked it, so whether question one is really answered here is unknown.',
}

/** One row as the seed will write it. */
export interface ListedAtlasEntry {
  readonly kind: string
  readonly provider: string
  readonly title: string
  readonly category: AtlasCategory
  readonly operatorGuess: RecipeOperatorGuess | undefined
  /** The answer to admission question two, where somebody looked (`#680`). */
  readonly agentApi: AgentApi | undefined
  /** What makes this entry unlike its shelfmates, where that is known (`#680`). */
  readonly caution: string | undefined
}

/**
 * The list, flattened into rows.
 *
 * **Derived from `SHELVES` rather than written out again**, so the shelf a
 * provider is on and the category its row carries are one fact. A second listing
 * is a second answer to *what shelf is this on*, and the wrong one is whichever
 * nobody was editing.
 */
export const LISTED_ATLAS_ENTRIES: readonly ListedAtlasEntry[] = Object.entries(SHELVES).flatMap(
  ([category, providers]) =>
    providers.map((one) => ({
      kind: KIND_ALREADY_HELD[one.provider] ?? KIND_BY_CATEGORY[category as AtlasCategory],
      provider: one.provider,
      title: one.title,
      category: category as AtlasCategory,
      operatorGuess: GUESS_BY_CATEGORY[category as AtlasCategory],
      agentApi: AGENT_API_ANSWERS[one.provider],
      caution: SHELF_CAUTIONS[one.provider],
    })),
)

export interface ListedSeedResult {
  /** Rows this run created. Zero on every run after the first. */
  readonly listed: number
  /** Rows already in the catalogue, which this run left exactly as it found them. */
  readonly untouched: number
}

/**
 * List the providers, without touching anything already written.
 *
 * **Insert-if-absent, and never the upsert the other seeds use.** That is the
 * one thing this seed must get right: `seedProviderCatalogue` upserts because
 * the entries it writes *are* the recipe, so re-running should restore them.
 * Here the row is a name on a shelf, and upserting it over a walked recipe would
 * delete somebody's work — a recipe replaced by *nobody has looked* is worse
 * than a stale one, because it also erases the fact that anybody did.
 *
 * That is also what makes it idempotent: a second run finds every pair present
 * and writes nothing.
 */
export async function seedListedAtlasEntries(db: Database): Promise<ListedSeedResult> {
  let listed = 0

  for (const entry of LISTED_ATLAS_ENTRIES) {
    const written = await listAtlasProvider(db, {
      kind: AccountKindSchema.parse(entry.kind),
      provider: entry.provider,
      title: entry.title,
      category: entry.category,
      ...(entry.operatorGuess === undefined ? {} : { operatorGuess: entry.operatorGuess }),
      ...(entry.agentApi === undefined ? {} : { agentApi: entry.agentApi }),
      ...(entry.caution === undefined ? {} : { caution: entry.caution }),
    })

    if (written) listed += 1
  }

  return { listed, untouched: LISTED_ATLAS_ENTRIES.length - listed }
}

/** What a curation run changed, on the same terms the listing reports. */
export interface CurationResult {
  /** Entries moved to `refused`, with the wall named. */
  readonly refused: number
  /** Entries withdrawn, because there was never an account to hold. */
  readonly retired: number
  /**
   * Entries this run passed over because somebody has since looked.
   *
   * **Worth a number rather than silence.** It is the count of judgements this
   * list made that the world has since answered, and a curation pass that starts
   * skipping rows is a curation pass that has been overtaken — which is a thing
   * to read in a deploy log, not to discover.
   */
  readonly leftToTheirWalks: number
}

/**
 * Answer the eighteen (`#679`), after the listing has put them on their shelves.
 *
 * **A second pass rather than a flag on the first**, and for the reason
 * `listAtlasProvider` is a second function rather than a flag on
 * `writeProviderRecipe`: what the listing writes must stay *nobody has looked*,
 * and `#590`'s third rule — that the listing lists nothing as refused — is worth
 * keeping literally true. A refusal is a finding with a reason attached; this
 * pass is where the finding is applied, and it says so by being separate.
 *
 * Idempotent for the same reason the listing is: the second run finds every one
 * of the eighteen already answered and no longer `unwritten`, so it writes
 * nothing and counts them as walked-past.
 */
export async function curateListedAtlasEntries(db: Database): Promise<CurationResult> {
  let refused = 0
  let retired = 0

  for (const one of CURATION) {
    const listed = LISTED_ATLAS_ENTRIES.find((entry) => entry.provider === one.provider)

    /**
     * **Throws rather than skips.** A curated provider that is not on a shelf is
     * a name that has drifted out of `SHELVES` while its judgement stayed here,
     * and the two halves disagreeing silently is exactly the drift `#680` is
     * about. The test below catches it before a deploy does.
     */
    if (listed === undefined) {
      throw new Error(`curated provider is not listed on any shelf: ${one.provider}`)
    }

    const changed = await curateListedProvider(db, {
      kind: AccountKindSchema.parse(listed.kind),
      provider: one.provider,
      ...(one.status === 'refused'
        ? { status: one.status, refusal: one.refusal }
        : { status: one.status, retiredReason: one.retiredReason }),
    })

    if (!changed) continue
    if (one.status === 'refused') refused += 1
    else retired += 1
  }

  return { refused, retired, leftToTheirWalks: CURATION.length - refused - retired }
}
