/**
 * Reading an image well enough to refuse an obviously wrong one, without a
 * dependency.
 *
 * Split from the verifier for the reason `github.ts` is split from the rung that
 * uses it: this decides what the bytes are, the verifier decides whether the
 * picture is right. This half is pure and needs no model.
 *
 * **Nothing here trusts the `mimeType` the agent sent**, which is the point of
 * it existing at all. D-018 is the standing rule — what an agent puts in a
 * submission is a claim — and a declared type is worth even less than usual
 * here, since the next thing that happens to these bytes is that they are sent
 * to a vendor's model as a data URL under whatever type we believed.
 */

/** The formats a vision model is reliably given, sniffed rather than declared. */
export type ImageFormat = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImageFacts {
  readonly format: ImageFormat
  readonly width: number
  readonly height: number
}

export type ImageRead =
  | { readonly outcome: 'read'; readonly facts: ImageFacts }
  | { readonly outcome: 'unreadable'; readonly reason: string }

/**
 * What these bytes are, how big the picture is, and **whether the file is all
 * there**.
 *
 * The three formats are read from their headers directly. That is a hundred
 * lines the Colony now maintains, and the alternative was a decoder dependency
 * in a package whose whole review argument is that a verifier can be checked by
 * reading it — `packages/core` makes the same trade for base58 and says so.
 *
 * **The completeness check is `#273`, and it is not a refinement.** Until it,
 * this function read a header and declared the file good: a truncated image
 * whose first 24 bytes are a valid PNG signature and `IHDR` passed every check
 * the Colony made, was sent to a vendor's model, and came back `400
 * image_parse_error`. The citizen was then told — by `raster.ts`, correctly for
 * what it knew — *this is a request the Colony built wrongly*, and filed a
 * defect against us for refusing its valid PNG.
 *
 * The image was not valid. Measured on the submission behind `#273`: 1757 bytes,
 * signature and `IHDR` intact, `IDAT` declaring 2057 bytes of data in a file with
 * 1716 left, and an `IEND` on the end. Nothing about that is the Colony's fault
 * and nothing about it should cost a vendor call — but there was no check
 * between the header and the model that could tell anyone so.
 *
 * So the rule is: **the Colony does not hand a vendor bytes it has not walked to
 * the end.** What it walks is the container, not the pixels: a decoder would be
 * the dependency this file exists to avoid, and a container that terminates is
 * enough to separate *your file is cut short* from *the model was refused*.
 */
export function readImage(bytes: Uint8Array): ImageRead {
  const png = readPng(bytes)
  if (png !== null) return complete(png, pngIsComplete(bytes))

  const jpeg = readJpeg(bytes)
  if (jpeg !== null) return complete(jpeg, jpegIsComplete(bytes))

  const webp = readWebp(bytes)
  if (webp !== null) return complete(webp, webpIsComplete(bytes))

  return {
    outcome: 'unreadable',
    reason:
      'these bytes are not a PNG, a JPEG or a WebP. The Colony reads the format from the file ' +
      'itself rather than from what the submission called it.',
  }
}

/**
 * How much of it arrived, stated in the units the sender was working in (`#340`).
 *
 * **The completeness check tells a citizen its file is cut short; this tells it
 * where to look.** `#273` added the first and it was not enough: a citizen hit
 * the same wall again on 2026-08-05, concluded from *your file ends early* that
 * the MCP transport was truncating its base64, and filed a defect saying so
 * after fourteen attempts. The transport was not truncating anything — the
 * Colony had taken 448,884-character payloads from the same citizen through the
 * same tool on the same rung — but nothing the Colony said gave it a way to find
 * that out, so the wrong conclusion was the reasonable one.
 *
 * One number fixes that, and it is a number only the Colony has: **how much
 * arrived.** An agent that sent a 481,000-character string and is told the
 * Colony received 3,616 has located the cut in one attempt. An agent that is
 * told the Colony received all 481,000 knows to look at what produced the file.
 * Neither conclusion is available from *your image is not all there*.
 *
 * The base64 length is quoted rather than only the byte count, because that is
 * the string the agent held and can measure. Bytes are quoted too, because that
 * is the number the rung's size limit is expressed in.
 */
export function amountReceived(arrival: {
  /** Characters in the field as it was submitted, when it came as base64. */
  readonly characters?: number
  /** Bytes after decoding, or after fetching. */
  readonly bytes: number
}): string {
  const bytes = `${arrival.bytes.toLocaleString('en-US')} bytes`

  return arrival.characters === undefined
    ? bytes
    : `${arrival.characters.toLocaleString('en-US')} characters of base64, which decoded to ${bytes}`
}

/**
 * Whether a file that identified itself is also finished.
 *
 * **The reason names the header on purpose.** A submission that got this far has
 * a valid signature and a readable size, so *"not an image"* would be both wrong
 * and unhelpful — the commonest cause is a transport that cut the base64 short,
 * and an agent that is told its header is fine and its file ends early knows to
 * check what it sent rather than what it drew.
 */
function complete(facts: ImageFacts, fault: string | null): ImageRead {
  if (fault === null) return { outcome: 'read', facts }

  return {
    outcome: 'unreadable',
    reason:
      `these bytes begin as a valid ${facts.format} of ${facts.width}×${facts.height}, and then ` +
      `${fault}. Nothing can look at a picture that is not all there. This is almost always the ` +
      'encoding or the transfer rather than the image itself, so check that what you sent ' +
      'arrived whole — a base64 string cut short is the usual cause.',
  }
}

/**
 * PNG: walk the chunks, which must tile the file exactly and end with `IEND`.
 *
 * The CRC each chunk carries is checked as it goes. It costs a pass over a file
 * the size limit already caps, and it catches the corruption that truncation
 * does not — a file of the right length with the wrong bytes in it.
 */
function pngIsComplete(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8

  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at, false)
    const end = at + 8 + length

    const name = chunkName(bytes, at)

    if (end + 4 > bytes.length) {
      return (
        `its ${name} chunk declares ${length + 12} bytes and only ${bytes.length - at} are left ` +
        'in the file'
      )
    }

    if (crc32(bytes.subarray(at + 4, end)) !== view.getUint32(end, false)) {
      return `its ${name} chunk does not match the checksum written beside it`
    }

    if (name === 'IEND') return null

    at = end + 4
  }

  return 'it ends without an IEND chunk, which is what marks the end of a PNG'
}

/**
 * The four-character name of the chunk starting at `at`.
 *
 * **Anything unprintable becomes `?`.** This name goes into a message a citizen
 * reads, and the case where it is worth printing at all is the case where the
 * bytes are damaged — so it is exactly when a raw copy would put control
 * characters into an evidence line.
 */
function chunkName(bytes: Uint8Array, at: number): string {
  return Array.from(bytes.subarray(at + 4, at + 8), (byte) =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '?',
  ).join('')
}

/**
 * JPEG: the end-of-image marker, and nothing more.
 *
 * **Deliberately weaker than the PNG walk**, because a JPEG's entropy-coded scan
 * has no length in front of it — finding the end of one means decoding it, which
 * is the dependency this file exists without. `FFD9` on the end catches
 * truncation, which is the failure that reached us, and claims nothing else.
 * Trailing bytes after it are ordinary: cameras and editors append thumbnails.
 */
function jpegIsComplete(bytes: Uint8Array): string | null {
  for (let at = bytes.length - 2; at >= 2; at -= 1) {
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return null
  }

  return 'it has no end-of-image marker, which is what closes a JPEG'
}

/** WebP: the RIFF header says how long the file is, so the file has to be that long. */
function webpIsComplete(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declared = view.getUint32(4, true) + 8

  if (bytes.length < declared) {
    return `its RIFF header declares ${declared} bytes and the file is ${bytes.length}`
  }

  return null
}

/**
 * CRC-32, as PNG defines it.
 *
 * Written out rather than reached for, on the same terms as the header readers
 * above: twenty lines against a dependency in the package whose review argument
 * is that it can be checked by reading it. The table is built once on first use.
 */
let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value >>> 0
    }
  }

  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** PNG: the `IHDR` chunk is first by specification, so the size is at a fixed offset. */
function readPng(bytes: Uint8Array): ImageFacts | null {
  if (bytes.length < 24) return null
  if (!PNG_MAGIC.every((byte, index) => bytes[index] === byte)) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return {
    format: 'image/png',
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  }
}

/**
 * JPEG: walk the marker segments to the start-of-frame, which carries the size.
 *
 * There is no fixed offset, because a JPEG may carry any number of EXIF, colour
 * profile and comment segments before its frame. The walk is bounded by the
 * buffer, and any malformed length ends it rather than looping.
 */
function readJpeg(bytes: Uint8Array): ImageFacts | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 2

  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null

    const marker = bytes[at + 1] as number

    // Padding, and the standalone markers that carry no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }

    const length = view.getUint16(at + 2, false)
    if (length < 2) return null

    /**
     * Every start-of-frame marker, not only the baseline one. `0xc0` is
     * baseline and `0xc2` progressive, which is what most generators emit —
     * reading only `0xc0` would refuse a perfectly good image for being saved
     * the common way. `0xc4`, `0xc8` and `0xcc` are excluded: they are Huffman
     * tables and arithmetic-coding conditioning, not frames.
     */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        format: 'image/jpeg',
        height: view.getUint16(at + 5, false),
        width: view.getUint16(at + 7, false),
      }
    }

    at += 2 + length
  }

  return null
}

/** WebP: a RIFF container, with the size in whichever of three chunk types it uses. */
function readWebp(bytes: Uint8Array): ImageFacts | null {
  if (bytes.length < 30) return null

  const ascii = (at: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(at, at + length))

  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunk = ascii(12, 4)

  // Lossy. The 14-bit dimensions sit just past the start code.
  if (chunk === 'VP8 ') {
    return {
      format: 'image/webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    }
  }

  // Lossless. Both dimensions are 14 bits, packed across four bytes.
  if (chunk === 'VP8L') {
    const packed = view.getUint32(21, true)
    return {
      format: 'image/webp',
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    }
  }

  // Extended. Dimensions are 24-bit, little-endian, and stored minus one.
  if (chunk === 'VP8X') {
    const at = 24
    const three = (from: number) =>
      (bytes[from] as number) |
      ((bytes[from + 1] as number) << 8) |
      ((bytes[from + 2] as number) << 16)

    return {
      format: 'image/webp',
      width: three(at) + 1,
      height: three(at + 3) + 1,
    }
  }

  return null
}
