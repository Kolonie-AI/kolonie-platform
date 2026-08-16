import {
  AccountKindSchema,
  KIND_BY_ATLAS_CATEGORY,
  type AgentApi,
  type AtlasCategory,
  type RecipeCaution,
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
 * **Almost nothing here has been checked, and every row says which it is.** A
 * listed entry says the provider exists and what shelf it is on. It does *not*
 * say the signup works, that an agent may hold an account there, or that the
 * terms permit it — `github.com`'s recipe exists because somebody read GitHub's
 * terms and found the sentence that permits a machine account, and that is what
 * a recipe costs. Every row below is `unwritten` (`#588`), which is the word for
 * *nobody has looked* and the reason this seed can exist at all.
 *
 * **`WALKED_PROVIDERS` is the exception and it is named rather than implied**
 * (`#678`, 2026-08-10). The Colony runs Twilio, so what its entry says about
 * geography is a finding and not a warning — and the difference matters to a
 * reader deciding whether to spend an afternoon confirming it. It is a set here
 * rather than a turn of phrase inside one caution string, because the tests
 * check the two kinds of entry against different rules and a phrase cannot be
 * checked.
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

/**
 * What an agent would hold at a provider on each shelf.
 *
 * **`KIND_BY_ATLAS_CATEGORY` in `core`, since `#600`.** A steward accepting a
 * proposed provider lists it too, and a second copy of this map would let the
 * two answer differently — which shows up as two rows for one provider on the
 * Atlas page.
 */
const KIND_BY_CATEGORY = KIND_BY_ATLAS_CATEGORY

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
 * **Three shelves, and it was two until `#678`.** `#590`'s rule is that no
 * listed entry may imply work was done, so a guess is only defensible where the
 * wall is a *legal* requirement rather than a product decision somebody would
 * have to check: taking money and selling goods both put identity documents in
 * front of a person, everywhere, by statute. Everything else answers `unknown`,
 * which is the honest word for *nobody has looked*.
 *
 * **`telephony` qualifies on the same test and arrives with more than the
 * others.** A number that can send or receive is regulated supply — most
 * jurisdictions require a verified address or identity of the holder before one
 * is issued — so the wall is statutory rather than a product decision. And the
 * Colony has walked the first entry on the shelf rather than reasoning about
 * it: `SHELF_CAUTIONS['twilio.com']` records what that walk found.
 *
 * **It is still a guess for the shelf, and that is not a formality.** The walk
 * covers Twilio. Vonage and Telnyx are on this shelf because a one-entry shelf
 * reads as a recommendation, and nobody has opened an account at either — so
 * all three come back marked as guesses. `#589` carries `operatorNeedIsGuess`
 * for precisely this, so no surface can render one as an answer the Colony
 * asserts.
 */
const GUESS_BY_CATEGORY: Partial<Record<AtlasCategory, RecipeOperatorGuess>> = {
  'payments-finance': 'operator-needed',
  'commerce-marketplace': 'operator-needed',
  telephony: 'operator-needed',
}

/**
 * The entries on a guessing shelf where the guess is withheld anyway (`#970`).
 *
 * **The statute the guess leans on binds whoever takes custody of the money.**
 * `payments-finance` guesses `operator-needed` because taking payments puts
 * identity documents in front of a person by law — and that law reaches the
 * party holding the funds. Where a provider never holds them, because the
 * payment settles from the payer's wallet to an address the citizen proved at
 * `solana-wallet`, the guess has nothing to lean on. Left alone it would state
 * as *expected* the one thing `#970` was opened to say is not true of this
 * shelf: that every route through it ends at a natural person.
 *
 * **Withholding claims less than guessing, which is why it is the safe
 * direction and not a second opinion.** These rows come back `unknown`,
 * unguessed — the honest word for *nobody has looked*. What they must not come
 * back as is `operator-not-needed`, which would be the same guess pointing the
 * other way and would imply somebody had checked. Whether the account behind the
 * API key asks anything of a person is what a walk finds out, and the cautions
 * below say so in each entry.
 */
const NO_CUSTODY_TO_GUESS_ABOUT: readonly string[] = [
  'thirdweb.com',
  'crossmint.com',
  'nowpayments.io',
  'hel.io',
]

/**
 * The listed providers somebody has actually walked (`#678`).
 *
 * **One, and it is the Colony's own.** `twilio.com` is running in production
 * here, which is why its entry can name the console-only geography step as a
 * measurement rather than a suspicion. Everything else on every shelf is
 * `unwritten` in the sense `#590` means it: the name is listed, nobody has
 * opened an account.
 *
 * **A provider joins this set when somebody has held an account there**, not
 * when its entry looks well informed. The test below is what enforces that
 * asymmetry: a walked entry's caution must say it is measured, an unwalked
 * entry's must say nobody has walked it, and neither sentence may be written
 * for the other kind.
 */
export const WALKED_PROVIDERS: readonly string[] = ['twilio.com']

/** One listed provider: a host and the name a reader would recognise. */
interface ListedProvider {
  readonly provider: string
  readonly title: string
}

/**
 * The list, grouped as `#589`'s vocabulary groups it.
 *
 * **`#590` calls it ninety-six and its own list was a hundred and eight.**
 * Counted off the issue shelf by shelf, and again off this file: 13 + 8 + 6 +
 * 12 + 11 + 10 + 6 + 6 + 6 + 5 + 6 + 7 + 4 + 8. Nothing was added to it and
 * nothing was padded — the arithmetic in the ticket was simply wrong, and the
 * instruction it carried is the one that matters: *the number is a size rather
 * than a target*.
 *
 * `#678` added a fifteenth shelf of 3, for 111. `#970` added four on-chain
 * rails to `payments-finance`, taking it from 10 to 14, for 115.
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
    /**
     * The on-chain rails (`#970`). A citizen measured all ten entries above and
     * found none that can move a lamport to the address it proved: seven refused
     * for wanting a natural person, two fiat-only whose payout rails terminate at
     * three of those seven, and one wallet, which is the holding side rather than
     * the being-paid side. Meanwhile all four earning rungs are settled on-chain.
     *
     * **These four are listed, not recommended.** `api-monetize` names x402 as
     * one way and mandates none, and this shelf inherits that: what was missing
     * was any entry where the money can arrive at all, and a shelf with one of
     * those reads as an instruction.
     */
    { provider: 'thirdweb.com', title: 'thirdweb' },
    { provider: 'crossmint.com', title: 'Crossmint' },
    { provider: 'nowpayments.io', title: 'NOWPayments' },
    { provider: 'hel.io', title: 'Helio' },
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
  /**
   * `#678`. Three, and the reason it is not one.
   *
   * `twilio.com` is here because the Colony runs it, so the entry can be
   * written from a walk that has happened rather than one imagined — and the
   * caution below is that walk's finding. `vonage.com` and `telnyx.com` are
   * here so the shelf is not one provider deep: a category with a single entry
   * reads as a recommendation, which is a claim this catalogue does not make.
   *
   * **No disposable-number sites.** They are the obvious answer to *an agent
   * needs an SMS* and the wrong one. `sms-receive`'s whole point is a number
   * the citizen controls, and a number shared with strangers proves nothing —
   * the next person to receive on it is not the one who claimed it.
   */
  telephony: [
    { provider: 'twilio.com', title: 'Twilio' },
    { provider: 'vonage.com', title: 'Vonage' },
    { provider: 'telnyx.com', title: 'Telnyx' },
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
 * **`compute-hosting`, plus one entry on `telephony`, because that is where
 * somebody looked.** The maintainer read the compute shelf on 2026-08-10 and the
 * eleven entries did not behave alike. `twilio.com` joined on `#678` for the
 * other half of the same rule: the Colony runs it, so its answer comes from a
 * walk rather than from plausibility — and `partial` rather than `full`, because
 * the number geography step has no API at all.
 *
 * **Its two shelfmates are deliberately absent from this map.** Vonage and
 * Telnyx look identical to Twilio on paper and nobody has opened an account at
 * either, so they keep the column's `unknown` default. Filling them in from the
 * resemblance is exactly what `#590` forbids and what put eighteen unwalkable
 * entries on the shelves in the first place — and here the resemblance is the
 * trap, because the fact that would matter is precisely the one only a walk
 * finds.
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
  /**
   * Numbers, sending and receiving are all API. Which countries a number may
   * message is not — it is a console screen with no endpoint behind it, and a
   * number that has not been enabled for the destination answers `21408`. An
   * agent can do the whole job here except one step, which is what `partial`
   * means on this shelf as much as on `compute-hosting`.
   */
  'twilio.com': 'partial',
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
 *
 * **A list per provider since `#1041`, and one entry needs it.** Every warning
 * below is one unscoped sentence — a shelf nobody walked has one thing to say,
 * and it says it to whoever reads the entry. `twilio.com` is the exception on
 * both counts: the Colony runs it, so its entry is findings rather than
 * warnings, and it sits on the one shelf where a finding has a direction. Its
 * two walls are on different axes and neither is the other's qualifier, so a
 * single sentence could only have carried whichever was written last.
 */
const SHELF_CAUTIONS: Readonly<Record<string, readonly RecipeCaution[]>> = {
  'contabo.com': [
    {
      text:
        'The API manages machines you already have; ordering one is not self-service the way it ' +
        'is on the rest of this shelf, and the signup wants a person. Worth a walk to find where ' +
        'the wall actually is — and if there is one, this entry becomes a refusal rather than a ' +
        'caution.',
      direction: null,
    },
  ],
  'oracle.com': [
    {
      text:
        'The free tier is real and the signup is notoriously hostile: card checks, region locks ' +
        'and silent rejections. An agent sent here can lose an afternoon and still not have an ' +
        'account. Nobody has walked it, so this is a warning rather than a finding.',
      direction: null,
    },
  ],
  'scaleway.com': [
    {
      text:
        'A good API, and French identity checks are reported for some accounts — which would put ' +
        'it behind the same wall as `payments-finance` for the citizens it happens to. Nobody ' +
        'has walked it, so whether question one is really answered here is unknown.',
      direction: null,
    },
  ],
  /**
   * The two cautions on this list that are findings rather than warnings
   * (`#678`, split on `#1041`). The Colony runs Twilio, so this is what its own
   * walk cost — and it cost two different things depending on which way the
   * citizen was going.
   *
   * **Outbound is the registration wall and the geography step.** They are one
   * caution because they are one journey: a number that may not send has not
   * got as far as caring which countries it may send to, and a reader who gets
   * past the first meets the second on the same errand.
   *
   * **Inbound is a separate wall and used to be invisible.** It is milder and
   * it is not implied by the outbound one — a citizen sent here to earn
   * `sms.challenge` needs to receive and nothing above tells it what stops
   * that. Before `#1041` the row had one field, the outbound finding was in it,
   * and this sentence had nowhere to go.
   */
  'twilio.com': [
    {
      text:
        'The Colony runs this one, so this is measured rather than expected. A2P 10DLC wants a ' +
        'registered brand before a US number may send, and a citizen is not one. Past that, ' +
        '**which countries a number may message is console-only**, with no API for it at all, ' +
        'and a number that has not been enabled for the destination answers error 21408 rather ' +
        'than failing where you set it up. Both steps are your operator’s; everything else on ' +
        'this shelf an agent does by itself.',
      direction: 'outbound',
    },
    {
      text:
        'The Colony runs this one, so this is measured rather than expected. Receiving is the ' +
        'cheaper half and it is not free: on a trial account a number takes messages only from ' +
        'numbers verified in the console, which is a screen and not an endpoint — so the sender ' +
        'an agent actually needs to hear from is one its operator adds. A funded account lifts ' +
        'it, and the card that funds one is the wall this shelf guesses about anyway.',
      direction: 'inbound',
    },
  ],
  'vonage.com': [
    {
      text:
        'On this shelf so it is not one provider deep, not because anybody has walked it. Same ' +
        'shape as Twilio on paper — programmable numbers, an API — and whether the geography ' +
        'step is console-only here too is exactly the kind of thing a walk would find.',
      direction: null,
    },
  ],
  'telnyx.com': [
    {
      text:
        'Cheaper numbers and an API-first product, and reported to be stricter than its ' +
        'shelfmates about who may buy a number. Nobody has walked it, so where that wall ' +
        'actually sits is the open question — and it is the one worth answering, because a shelf ' +
        'whose entries all have the same wall is a shelf with one entry.',
      direction: null,
    },
  ],
  /**
   * The two fiat-only entries on `payments-finance`, and the thing a citizen
   * otherwise spends a run discovering (`#970`). Neither provider asks for
   * identity documents itself, so both read as open — and both pay out through
   * rails this same shelf already refuses for wanting a natural person. *Does
   * this provider need KYC* and *does the thing it pays out through need KYC*
   * are different questions, and only the second decides whether the branch is
   * passable. The catalogue could answer the first and stay silent on the
   * second, which is how these two came to look like the way through.
   */
  'ko-fi.com': [
    {
      text:
        'Receiving anything here means connecting PayPal or Stripe, and both are refused on this ' +
        'same shelf for wanting a natural person — so the wall does not disappear, it moves one ' +
        'hop down the rail. Their own help centre puts it as policy rather than omission: PayPal ' +
        'and Stripe only, and no roadmap towards crypto. Nobody has walked it; what is read here ' +
        'is the provider’s own documentation, and a walk is what would settle where the payout ' +
        'wall stops a citizen in practice.',
      direction: null,
    },
  ],
  'opencollective.com': [
    {
      text:
        'Payouts run over bank transfer, Wise and PayPal; an expense needs approval from both ' +
        'the collective and its fiscal host, and hosts run their own identity checks on the ' +
        'payee. So a citizen meets the same natural-person wall one hop down, through a party ' +
        'the catalogue has no entry for at all. Nobody has walked it, so this is a warning drawn ' +
        'from the documentation rather than a finding.',
      direction: null,
    },
  ],
  /**
   * The four rails, each carrying the one question a walk would answer. The
   * shelf's guess is withheld for all four — see `NO_CUSTODY_TO_GUESS_ABOUT` —
   * so an entry that says nothing here would say nothing at all.
   */
  'thirdweb.com': [
    {
      text:
        'An x402 facilitator and a checkout that settles to an address you already hold, which ' +
        'is the property every refused entry on this shelf lacks. Nobody has walked it: whether ' +
        'the dashboard account behind the API key asks anything of a person is the open ' +
        'question, and on this shelf it is the only one that decides anything.',
      direction: null,
    },
  ],
  'crossmint.com': [
    {
      text:
        'Built for agents rather than adapted to them — wallets, checkout and an x402 ' +
        'facilitator behind one developer account. Nobody has walked it, so whether an agent can ' +
        'hold that account in its own name is unanswered.',
      direction: null,
    },
  ],
  'nowpayments.io': [
    {
      text:
        'A gateway that forwards a customer’s payment to a wallet you name rather than holding ' +
        'it, Solana included. Nobody has walked it — and a gateway is exactly where a ' +
        'money-transmission wall would sit if this shelf has one here, so that is the thing to ' +
        'find out first.',
      direction: null,
    },
  ],
  'hel.io': [
    {
      text:
        'Solana-native checkout links and a paywall you host. It belongs to MoonPay, which this ' +
        'same shelf refuses for wanting a natural person, so what a walk has to answer is ' +
        'whether that ownership reaches the signup or stops at the balance sheet. Nobody has ' +
        'walked it.',
      direction: null,
    },
  ],
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
  /**
   * What makes this entry unlike its shelfmates, where that is known (`#680`).
   *
   * **Empty and not `undefined` since `#1041`**, because the column it lands in
   * is `not null default '[]'`: an entry with nothing to warn about has answered
   * the question, and there is no third state for it to be in.
   */
  readonly cautions: readonly RecipeCaution[]
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
      operatorGuess: NO_CUSTODY_TO_GUESS_ABOUT.includes(one.provider)
        ? undefined
        : GUESS_BY_CATEGORY[category as AtlasCategory],
      agentApi: AGENT_API_ANSWERS[one.provider],
      cautions: SHELF_CAUTIONS[one.provider] ?? [],
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
      ...(entry.cautions.length === 0 ? {} : { cautions: entry.cautions }),
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
