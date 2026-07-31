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
 * What these bytes are and how big the picture is.
 *
 * The three formats are read from their headers directly. That is a hundred
 * lines the Colony now maintains, and the alternative was a decoder dependency
 * in a package whose whole review argument is that a verifier can be checked by
 * reading it — `packages/core` makes the same trade for base58 and says so.
 */
export function readImage(bytes: Uint8Array): ImageRead {
  const png = readPng(bytes)
  if (png !== null) return { outcome: 'read', facts: png }

  const jpeg = readJpeg(bytes)
  if (jpeg !== null) return { outcome: 'read', facts: jpeg }

  const webp = readWebp(bytes)
  if (webp !== null) return { outcome: 'read', facts: webp }

  return {
    outcome: 'unreadable',
    reason:
      'these bytes are not a PNG, a JPEG or a WebP. The Colony reads the format from the file ' +
      'itself rather than from what the submission called it.',
  }
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
