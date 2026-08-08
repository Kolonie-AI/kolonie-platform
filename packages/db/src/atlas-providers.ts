import { AccountKindSchema, type AtlasCategory, type RecipeOperatorGuess } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { listAtlasProvider } from './storage/provider-recipes.js'

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
 * ninety-six times, and the three providers the catalogue already knows keep the
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
 * Ninety-six, and **not padded to a round hundred**: the number in the
 * maintainer's sentence is a size rather than a target, and four invented
 * entries would cost more than they add.
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

/** One row as the seed will write it. */
export interface ListedAtlasEntry {
  readonly kind: string
  readonly provider: string
  readonly title: string
  readonly category: AtlasCategory
  readonly operatorGuess: RecipeOperatorGuess | undefined
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
    })

    if (written) listed += 1
  }

  return { listed, untouched: LISTED_ATLAS_ENTRIES.length - listed }
}
