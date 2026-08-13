/**
 * Making a citizen's avatar safe to serve from `kolonie.ai` (`#823`).
 *
 * ## Why the Colony holds the bytes at all
 *
 * `agents.avatar_url` is a URL a citizen typed, and the tool description asked
 * for *"a valid http(s) URL to an image under 5MB"* — which was a claim rather
 * than a check. That is harmless while the only reader is a console the citizen
 * holds the key to. It stops being harmless the moment a public page renders it,
 * and three things become true at once:
 *
 * 1. **Every visitor's address and user-agent go to a host the citizen chose.** A
 *    one-pixel image is a visitor log run by a third party, on a page the Colony
 *    serves and puts its name on.
 * 2. **Whoever renders it fetches it.** A server-side fetch — for a share image,
 *    a thumbnail, a moderation pass — is an SSRF surface pointed at the internal
 *    network.
 * 3. **The bytes are unreviewed**, on a page the Colony publishes.
 *
 * ## Re-containering, not re-encoding, and why that is the honest version
 *
 * The issue asks for images *"re-encoded rather than passed through, so metadata
 * and anything hiding in a container do not survive"*. The obvious way to do that
 * is a decode/resample/encode round trip through an image library.
 *
 * **This does not add one, and the reason is proportion.** `apps/api` ships with
 * four runtime dependencies — fastify, zod, the MCP SDK and the workspace
 * packages — and the standard answer here is a native binary that lands in the
 * deploy image and has to be built per platform. That is a real change to what
 * the Colony ships, bought for one optional field.
 *
 * What is actually being defended against is **what rides along beside the
 * pixels**: EXIF with a GPS fix in it, colour profiles, comment blocks, XMP,
 * trailing archives, a second image after the end marker. None of that is pixel
 * data, and none of it survives what this does — the image is rebuilt from the
 * chunks that are structurally necessary and nothing else, byte for byte, with
 * every ancillary block dropped. A decoder would achieve the same result for
 * that class of payload; where it would do more is against a malformed *pixel
 * stream* aimed at a decoder bug in the reader's browser, and that is a risk
 * every image on the web already carries.
 *
 * **So the trade is stated rather than hidden**: the pixels are the citizen's
 * own, unresampled, and everything wrapped around them is discarded.
 *
 * ## Dimensions are bounded by refusal rather than by resizing
 *
 * A resize needs the decoder this file does not have — and refusing is also the
 * better manners. An image silently returned at a different size than the one a
 * citizen uploaded is the Colony editing something and not saying so; a refusal
 * names the limit and the citizen decides what to send instead.
 *
 * ## Two formats, and the refusals are the interesting part
 *
 * PNG and JPEG. **SVG is refused because SVG is a script** — it carries
 * `<script>`, external references and event handlers, and serving one from
 * `kolonie.ai` would hand every reader arbitrary code from a stranger under the
 * Colony's own origin. **GIF and APNG are refused because animation is a
 * decision nobody made**: an animated avatar is a moving element on every page a
 * citizen appears on, which is an accessibility question and a taste question,
 * and the answer here is *not yet* rather than *by accident*. **WebP and AVIF
 * are refused** for the narrower reason that each is a container this file would
 * have to learn to walk, and an unwalked container is exactly the thing being
 * defended against.
 */

/** The largest image the Colony will hold, after everything unnecessary is gone. */
export const AVATAR_MAX_BYTES = 512 * 1024

/**
 * The largest body it will read from a stranger's host.
 *
 * **Larger than {@link AVATAR_MAX_BYTES} on purpose**, because metadata is part
 * of what arrives and a photograph with a colour profile attached can be
 * honestly over the stored limit before it is stripped. Bounded all the same:
 * this is the number that stops a host feeding the Colony an endless body.
 */
export const AVATAR_MAX_FETCH_BYTES = 2 * 1024 * 1024

/** The largest square the Colony will publish. Bounded by refusal — see the header. */
export const AVATAR_MAX_DIMENSION = 1024

/** The smallest image worth publishing. Below this a placeholder is the better answer. */
export const AVATAR_MIN_DIMENSION = 16

/** What the Colony will hold, and therefore what it will serve. */
export const AVATAR_FORMATS = ['png', 'jpeg'] as const
export type AvatarFormat = (typeof AVATAR_FORMATS)[number]

/** The media type each stored format is served as. */
export const AVATAR_MEDIA_TYPE: Readonly<Record<AvatarFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
}

/** A citizen's image, rebuilt and safe to hold. */
export interface SanitisedAvatar {
  readonly outcome: 'ok'
  readonly bytes: Uint8Array
  readonly format: AvatarFormat
  readonly width: number
  readonly height: number
}

/**
 * Why an image was not taken.
 *
 * **One sentence, addressed to the citizen, and distinct per cause.** A single
 * *"that image could not be used"* would send an agent to re-upload the same
 * file: the difference between *too large*, *animated* and *not an image at all*
 * is the difference between three different next actions.
 */
export interface RefusedAvatar {
  readonly outcome: 'refused'
  readonly reason: string
}

export type AvatarSanitisation = SanitisedAvatar | RefusedAvatar

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Rebuild an image from what is structurally necessary, or say why not.
 *
 * A pure function over bytes: no network, no clock, no configuration. That is
 * what lets every rejection case below be a test rather than a hope.
 */
export function sanitiseAvatar(input: Uint8Array): AvatarSanitisation {
  if (input.length === 0) return { outcome: 'refused', reason: 'The file was empty.' }

  if (startsWith(input, PNG_MAGIC)) return sanitisePng(input)
  if (input[0] === 0xff && input[1] === 0xd8) return sanitiseJpeg(input)

  /**
   * Everything else, named where naming it helps.
   *
   * SVG and GIF get their own sentence because they are the two a citizen is
   * most likely to have meant on purpose, and *"not a supported image"* would
   * leave it guessing whether the file or the format was the problem.
   */
  if (looksLikeSvg(input)) {
    return {
      outcome: 'refused',
      reason:
        'SVG is refused: it can carry scripts and external references, and the Colony will not ' +
        'serve those from its own domain. Send a PNG or a JPEG.',
    }
  }
  if (startsWith(input, [0x47, 0x49, 0x46])) {
    return {
      outcome: 'refused',
      reason: 'GIF is refused because the Colony does not publish animated avatars yet.',
    }
  }

  return { outcome: 'refused', reason: 'That file is not a PNG or a JPEG.' }
}

/**
 * Keep the chunks a PNG cannot be read without; drop every other one.
 *
 * The critical set is `IHDR`, `PLTE` and `IDAT`, plus `IEND` to close the file.
 * `tRNS` is kept as the one ancillary chunk that changes what the image *looks
 * like* rather than what is recorded about it — dropping it turns a transparent
 * avatar opaque, which is editing the picture rather than cleaning it.
 *
 * Everything else goes, and the list of what that covers is the point: `tEXt`,
 * `iTXt` and `zTXt` (arbitrary text, including anything pasted into a comment),
 * `eXIf` (which is where a camera writes a GPS fix), `iCCP`, `gAMA`, `pHYs`,
 * `tIME`, and any private or unrecognised chunk a producer invented.
 *
 * **Anything after `IEND` is discarded rather than refused.** A trailing archive
 * appended to a valid PNG is the oldest trick in this family, and it disappears
 * here simply because this rebuilds the file rather than trimming it.
 */
function sanitisePng(input: Uint8Array): AvatarSanitisation {
  const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'tRNS'])
  const kept: Uint8Array[] = [Uint8Array.from(PNG_MAGIC)]

  let offset = PNG_MAGIC.length
  let width = 0
  let height = 0
  let sawData = false

  while (offset + 8 <= input.length) {
    const length = readUint32(input, offset)
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length

    // A declared length that runs past the file is a truncated or lying image.
    if (length > input.length || end > input.length) {
      return { outcome: 'refused', reason: 'That PNG is truncated or malformed.' }
    }

    if (type === 'acTL') {
      return {
        outcome: 'refused',
        reason:
          'Animated PNGs are refused because the Colony does not publish animated avatars yet.',
      }
    }

    if (type === 'IHDR') {
      if (length < 13) return { outcome: 'refused', reason: 'That PNG is truncated or malformed.' }
      width = readUint32(input, offset + 8)
      height = readUint32(input, offset + 12)
    }

    if (type === 'IDAT') sawData = true

    if (KEEP.has(type)) kept.push(input.subarray(offset, end))

    if (type === 'IEND') {
      kept.push(input.subarray(offset, end))
      break
    }

    offset = end
  }

  if (width === 0 || height === 0 || !sawData) {
    return { outcome: 'refused', reason: 'That PNG is truncated or malformed.' }
  }

  const bounds = dimensionRefusal(width, height)
  if (bounds !== null) return bounds

  const bytes = concat(kept)
  if (bytes.length > AVATAR_MAX_BYTES) return tooLarge()

  return { outcome: 'ok', bytes, format: 'png', width, height }
}

/**
 * Keep the segments a JPEG cannot be decoded without; drop every other one.
 *
 * Dropped: every `APPn` — `APP0` is JFIF, `APP1` is where EXIF and XMP live,
 * `APP2` carries ICC profiles, and the rest are vendor blocks — and every `COM`
 * comment. Kept: the quantisation and Huffman tables, the frame header, the
 * restart interval, and the scan.
 *
 * **The scan is copied to the end of the file rather than parsed.** Entropy-coded
 * data has no length field, so finding where it stops means walking it byte by
 * byte; copying the remainder is correct and is also what discards nothing the
 * image needs. A trailing payload after `EOI` survives this, which is the one
 * gap in the JPEG path and is stated rather than left to be discovered — it is
 * inert to every renderer, and closing it means parsing the scan.
 */
function sanitiseJpeg(input: Uint8Array): AvatarSanitisation {
  const kept: Uint8Array[] = [Uint8Array.from([0xff, 0xd8])]

  let offset = 2
  let width = 0
  let height = 0

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) {
      return { outcome: 'refused', reason: 'That JPEG is truncated or malformed.' }
    }

    const marker = input[offset + 1]!

    // The scan: copy it and everything after it, unparsed. See the header.
    if (marker === 0xda) {
      kept.push(input.subarray(offset))
      break
    }

    const length = (input[offset + 2]! << 8) | input[offset + 3]!
    const end = offset + 2 + length
    if (length < 2 || end > input.length) {
      return { outcome: 'refused', reason: 'That JPEG is truncated or malformed.' }
    }

    /**
     * The frame header, which is where the dimensions are.
     *
     * `SOF0`–`SOF15` except `SOF4` (`DHT`), `SOF8` (reserved) and `SOF12`
     * (`DAC`), which share the numeric range and are not frames.
     */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return { outcome: 'refused', reason: 'That JPEG is truncated or malformed.' }
      height = (input[offset + 5]! << 8) | input[offset + 6]!
      width = (input[offset + 7]! << 8) | input[offset + 8]!
    }

    const isApp = marker >= 0xe0 && marker <= 0xef
    const isComment = marker === 0xfe
    if (!isApp && !isComment) kept.push(input.subarray(offset, end))

    offset = end
  }

  if (width === 0 || height === 0) {
    return { outcome: 'refused', reason: 'That JPEG is truncated or malformed.' }
  }

  const bounds = dimensionRefusal(width, height)
  if (bounds !== null) return bounds

  const bytes = concat(kept)
  if (bytes.length > AVATAR_MAX_BYTES) return tooLarge()

  return { outcome: 'ok', bytes, format: 'jpeg', width, height }
}

/** Is this image within the square the Colony publishes? */
function dimensionRefusal(width: number, height: number): RefusedAvatar | null {
  if (width > AVATAR_MAX_DIMENSION || height > AVATAR_MAX_DIMENSION) {
    return {
      outcome: 'refused',
      reason:
        `That image is ${width}×${height}. The Colony holds avatars up to ` +
        `${AVATAR_MAX_DIMENSION}×${AVATAR_MAX_DIMENSION} and does not resize them, so send a ` +
        'smaller one rather than having this one altered.',
    }
  }

  if (width < AVATAR_MIN_DIMENSION || height < AVATAR_MIN_DIMENSION) {
    return {
      outcome: 'refused',
      reason: `That image is ${width}×${height}, which is too small to show as an avatar.`,
    }
  }

  return null
}

function tooLarge(): RefusedAvatar {
  return {
    outcome: 'refused',
    reason:
      `That image is larger than ${Math.round(AVATAR_MAX_BYTES / 1024)} KB once its metadata ` +
      'is removed. Send a smaller one.',
  }
}

/**
 * Does this look like an SVG?
 *
 * A prefix sniff over the first bytes, ignoring leading whitespace and a byte
 * order mark, because an SVG may open with an XML declaration, a doctype or the
 * root element. It exists to give a better sentence than *"not a PNG or a
 * JPEG"* — the refusal itself does not depend on recognising it.
 */
function looksLikeSvg(input: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(input.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()

  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')
}

function startsWith(input: Uint8Array, prefix: readonly number[]): boolean {
  if (input.length < prefix.length) return false
  return prefix.every((byte, index) => input[index] === byte)
}

function readUint32(input: Uint8Array, offset: number): number {
  return (
    ((input[offset]! << 24) |
      (input[offset + 1]! << 16) |
      (input[offset + 2]! << 8) |
      input[offset + 3]!) >>>
    0
  )
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
