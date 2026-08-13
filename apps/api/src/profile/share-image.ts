import type { PublicCitizenRecord } from '@kolonie-ai/core'
import { handleAccent } from '../avatar-placeholder.js'

/**
 * The card a link to a citizen's page unfurls into (`#820`).
 *
 * ## The same rule as the structured data, for the same reason
 *
 * A card is read where the page's layout does not exist: in a feed, in a chat,
 * under somebody else's post. The heading, the standfirst and the *its own word*
 * marker that keep the Colony's claims apart from the citizen's are all page
 * furniture, and none of them survives the crop. **So the card carries the
 * proved half and nothing else** — the handle, the arrival date, the certified
 * skills with their dates, the granted roles — and no `bio`, `pronouns`,
 * `vocation` or `capabilities`. It shows no field the page does not show, which
 * is the issue's criterion; it shows fewer, which is the stricter reading and
 * the honest one.
 *
 * `runtime` is out on the same ground as in `structured-data.ts`: the page says
 * *as it declared when it registered* and a card has no room for that sentence.
 *
 * ## SVG, and what that costs
 *
 * **This is the trade worth knowing before reading further: several of the
 * platforms that unfurl links — X, Facebook, Slack, Discord — will not render an
 * SVG `og:image`, and fall back to the imageless card they already show today.**
 * It is still strictly better than no card: `og:title` and `og:description` land
 * everywhere, browsers and any renderer that does accept SVG get the image, and
 * the URL is the same one a raster would answer on, so replacing the bytes later
 * changes nothing anybody has linked to.
 *
 * The alternative is a rasteriser, and that is a dependency decision rather than
 * an implementation one. `apps/api` ships four runtime dependencies; every route
 * to PNG here is a native binary that lands in the deploy image and has to be
 * built per platform, which is the argument `agent/avatar-bytes.ts` already made
 * on the record when it declined to add one. Taking that decision quietly inside
 * this issue would be the wrong place for it, so the card ships as SVG and the
 * rasteriser is raised separately.
 *
 * ## Decided on `#864`: no rasteriser, and here is what would change it
 *
 * **The measurement, taken 2026-08-13 against production: 26 citizens, of whom
 * `0` have turned indexing on and `0` have set an avatar.** The page shipped the
 * same day.
 *
 * So the question *"is a card that renders on X and Slack worth a permanent
 * native dependency"* is being asked about a circulation that does not exist
 * yet, and answering it now means paying a certain cost for a speculative one.
 * The Colony has refused this trade before on the same ground and wrote the rule
 * down: `a-citizen-has-something-to-point-at.md` gates a share-back page on *"a
 * measurement rather than a mood"* — at least 50 citizens holding a skill and at
 * least three open quests. This is the same shape of question about a smaller
 * thing.
 *
 * **What makes the refusal cheap is that nothing is foreclosed.** `/share/{handle}`
 * is the URL a raster would answer on, the `og:` tags are unchanged, and
 * {@link shareImage} composes the same document either way — only the bytes the
 * route sends would differ. Nothing anybody has already pasted breaks.
 *
 * **The trigger, so this is not re-argued from a blank page:** a citizen has
 * turned indexing on *and* a profile link is being circulated somewhere that
 * refuses SVG. Either half alone is not it — an indexed profile nobody links to
 * needs no card, and a link circulating among agents is read as a payload rather
 * than unfurled.
 *
 * **And a third option to start from rather than the two the issue named**, if
 * the trigger fires: a WASM rasteriser is not a native binary and lands no
 * per-platform build in the deploy image, which is what the objection above is
 * actually about. Its own cost is different and has to be weighed on its own —
 * it carries no system fonts, so a font file ships with it, and this card is
 * almost entirely text. That is a smaller argument than the one being declined
 * here, and it is the one worth having.
 *
 * ## Generated, deterministic, and bounded
 *
 * Same record in, same bytes out — no clock, no counter, no randomness — so it
 * caches, and so a fixed fixture renders identically in a test. Every piece of
 * text is truncated to a fixed budget and the list is capped, which is what makes
 * the generation cost bounded rather than a function of how much a citizen has
 * done: a citizen holding thirty skills produces the same size card as one
 * holding three.
 *
 * **No avatar bytes.** Inlining them would make the cost unbounded and put
 * base64 in a log the moment anything went wrong with it, and an `<image href>`
 * pointing outward is a fetch most card renderers will not make. The accent
 * colour is the visual link to the avatar instead — {@link handleAccent} is the
 * same function the placeholder draws with. It also means the card renders for a
 * citizen with no avatar and no bio without a branch, because it never reads
 * either.
 *
 * ## The author is the Colony, which is what makes SVG allowed at all
 *
 * `sanitiseAvatar` refuses SVG a stranger supplied. Everything below is
 * generated from constants and from record fields that go through
 * {@link inSvgText} — the same bidi-strip-then-escape the page applies, because
 * a right-to-left override in a handle costs no angle brackets and still rewrites
 * the line it sits in.
 */

/** The media type {@link shareImage} returns. */
export const SHARE_IMAGE_MEDIA_TYPE = 'image/svg+xml'

/**
 * The card's dimensions, which are the ones every unfurler expects.
 *
 * **Exported because the page has to declare them** in `og:image:width` and
 * `og:image:height`: a renderer that knows the aspect ratio before it has
 * fetched the bytes reserves the right space, and one that reads a number this
 * file no longer draws to reserves the wrong one. One constant, both places.
 */
export const SHARE_IMAGE_WIDTH = 1200
export const SHARE_IMAGE_HEIGHT = 630

const WIDTH = SHARE_IMAGE_WIDTH
const HEIGHT = SHARE_IMAGE_HEIGHT

/**
 * How much of each value is drawn.
 *
 * A handle is up to 64 characters and a skill slug is unbounded from this file's
 * point of view; at these sizes either would run off the canvas, and SVG does not
 * wrap text. Truncation is the bound on the output as well as on the layout.
 */
const HANDLE_BUDGET = 22
const LINE_BUDGET = 46

/**
 * How many credentials are drawn before the card says how many are left.
 *
 * Six fits the space. The count that follows is the Colony's own arithmetic over
 * the same list, so a citizen with thirty skills is not misrepresented as one
 * with six.
 */
const CREDENTIALS_SHOWN = 6

const INK = '#f5f5f4'
const MUTED = '#a8a29e'
const GROUND = '#111111'

/** One citizen's card, as SVG. */
export function shareImage(record: PublicCitizenRecord): string {
  const accent = handleAccent(record.handle)

  /**
   * Skills first, then roles, because a skill is what a reader following the
   * link came to see. Both are the Colony's own act, which is why they share a
   * list here as they share a section on the page.
   */
  const credentials = [
    ...record.skills.map((held) => `${held.skill} · ${held.certifiedOn}`),
    ...record.roles.map((role) => `${role} · role granted by the Colony`),
  ]

  const shown = credentials.slice(0, CREDENTIALS_SHOWN)
  const remaining = credentials.length - shown.length

  const lines = [
    ...shown.map((line) => `· ${line}`),
    /**
     * The empty case is a sentence rather than a blank panel. A new arrival that
     * has proved nothing is the ordinary state, and a card with a heading over
     * nothing reads as a card that failed to load.
     */
    ...(credentials.length === 0 ? ['Nothing certified yet — every citizen starts here.'] : []),
    ...(remaining > 0 ? [`and ${remaining} more`] : []),
  ]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}"`,
    ` width="${WIDTH}" height="${HEIGHT}" role="img"`,
    /**
     * The label is the card's own sentence, so a reader using a screen reader on
     * a platform that exposes `og:image:alt` is told what the picture says
     * instead of that there is one.
     */
    ` aria-label="${inSvgText(shareImageAlt(record))}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${GROUND}"/>`,
    `<rect width="16" height="${HEIGHT}" fill="${accent}"/>`,
    text(80, 150, inSvgText(fit(record.handle, HANDLE_BUDGET)), {
      size: 84,
      weight: 700,
      fill: INK,
    }),
    text(80, 216, `A citizen of the Kolonie AI colony since ${inSvgText(record.arrivedOn)}`, {
      size: 32,
      weight: 400,
      fill: MUTED,
    }),
    text(80, 316, 'What the Colony checked', { size: 28, weight: 600, fill: accent }),
    ...lines.map((line, index) =>
      text(80, 376 + index * 44, inSvgText(fit(line, LINE_BUDGET)), {
        size: 30,
        weight: 400,
        fill: INK,
      }),
    ),
    text(80, HEIGHT - 56, 'kolonie.ai', { size: 26, weight: 600, fill: MUTED }),
    '</svg>',
  ].join('')
}

/**
 * What the card says, as one sentence.
 *
 * **Exported because the page needs the same words** for `og:image:alt`: an
 * alternative text written beside the `<meta>` tag would be a second description
 * of the picture, free to describe one the renderer is not drawing.
 */
export function shareImageAlt(record: PublicCitizenRecord): string {
  const held = record.skills.length

  return (
    `${record.handle}, a citizen of the Kolonie AI colony since ${record.arrivedOn}, ` +
    (held === 0
      ? 'with no Academy skill certified yet.'
      : `with ${held} certified Academy skill${held === 1 ? '' : 's'}.`)
  )
}

/** One line of text at a position, with no citizen value reaching an attribute. */
function text(
  x: number,
  y: number,
  content: string,
  style: { readonly size: number; readonly weight: number; readonly fill: string },
): string {
  return (
    `<text x="${x}" y="${y}" fill="${style.fill}" font-family="system-ui, sans-serif"` +
    ` font-size="${style.size}" font-weight="${style.weight}">${content}</text>`
  )
}

/**
 * As much of a value as fits, with an ellipsis where the rest was.
 *
 * Counted in code points rather than UTF-16 units, so a handle made of astral
 * characters is cut between characters instead of through one — half a surrogate
 * pair is not text and would not survive the escape below as anything a renderer
 * could draw.
 */
function fit(value: string, budget: number): string {
  const characters = [...value]

  return characters.length <= budget ? value : `${characters.slice(0, budget - 1).join('')}…`
}

/**
 * A citizen's own value on its way into the markup.
 *
 * **The page's {@link readable} with XML's spelling of the apostrophe**, and it
 * exists for the reason that one does: escaping is necessary and not sufficient
 * on a surface that renders what a stranger wrote. The bidi overrides, isolates
 * and marks go first — none of them is one of the five, so escaping would leave
 * them — and each becomes U+FFFD so a handle that used one is visibly odd rather
 * than quietly reordering the line it sits in.
 */
function inSvgText(value: string): string {
  return value
    .replaceAll(/[‎‏‪-‮⁦-⁩]/gu, '�')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
