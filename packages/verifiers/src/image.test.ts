import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeSubmittedImage, IMAGE_URL_FALLBACK, readImage } from './image.js'

/**
 * A complete PNG: signature, `IHDR`, an `IDAT` and an `IEND`, every chunk
 * carrying its own checksum.
 *
 * **These fixtures used to be twenty-four bytes of header** and the tests below
 * asserted the reader read them, which it did — that is `#273` in miniature. A
 * file that is only a header is exactly what a truncated submission looks like,
 * so a fixture that stops there cannot tell a working reader from one that never
 * looks past the first chunk.
 *
 * The checksums come from `node:zlib`, which is a different implementation from
 * the one in `image.ts`. That is the point of using it rather than exporting
 * ours: a fixture built with the code under test would agree with it however
 * wrong both were.
 */
function png(width: number, height: number): Uint8Array {
  const chunk = (name: string, data: Uint8Array): number[] => {
    const named = Uint8Array.from([...Buffer.from(name, 'ascii'), ...data])
    const length = data.length
    const crc = crc32(named)

    return [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
      ...named,
      (crc >>> 24) & 0xff,
      (crc >>> 16) & 0xff,
      (crc >>> 8) & 0xff,
      crc & 0xff,
    ]
  }

  const header = Uint8Array.from([
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    // Depth 8, truecolour, and the only compression, filter and interlace
    // methods PNG defines. Nothing reads these; they are here so the file is one.
    8,
    2,
    0,
    0,
    0,
  ])

  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('IDAT', Uint8Array.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    ...chunk('IEND', new Uint8Array(0)),
  ])
}

/**
 * A JPEG with `segments` filler segments before its frame, so the walk is
 * exercised rather than a fixed offset that happens to work.
 */
function jpeg(width: number, height: number, options: { marker?: number; segments?: number } = {}) {
  const marker = options.marker ?? 0xc0
  const filler: number[] = []

  for (let index = 0; index < (options.segments ?? 0); index += 1) {
    // An APP0 segment of length 6, carrying four bytes nobody reads.
    filler.push(0xff, 0xe0, 0x00, 0x06, 0, 0, 0, 0)
  }

  return Uint8Array.from([
    0xff,
    0xd8,
    ...filler,
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...new Array(8).fill(0),
    // End-of-image. A JPEG without it is a JPEG that was cut short (`#273`).
    0xff,
    0xd9,
  ])
}

/** A lossy WebP: RIFF container, `VP8 ` chunk, 14-bit dimensions. */
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32)
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[at + index] = text.charCodeAt(index)
    }
  }

  ascii(0, 'RIFF')
  ascii(8, 'WEBP')
  ascii(12, 'VP8 ')
  const view = new DataView(bytes.buffer)
  // The RIFF length, which is the file's own account of how long it is (`#273`).
  view.setUint32(4, bytes.length - 8, true)
  view.setUint16(26, width, true)
  view.setUint16(28, height, true)

  return bytes
}

describe('readImage', () => {
  it('reads a PNG', () => {
    expect(readImage(png(512, 512))).toMatchObject({
      outcome: 'read',
      facts: { format: 'image/png', width: 512, height: 512 },
    })
  })

  it('reads a JPEG, walking past whatever segments precede the frame', () => {
    expect(readImage(jpeg(800, 600, { segments: 3 }))).toMatchObject({
      outcome: 'read',
      facts: { format: 'image/jpeg', width: 800, height: 600 },
    })
  })

  /**
   * `0xc2` is progressive, which is what most generators emit. Reading only the
   * baseline marker would refuse a perfectly good image for having been saved
   * the common way.
   */
  it('reads a progressive JPEG, not only a baseline one', () => {
    expect(readImage(jpeg(1024, 1024, { marker: 0xc2 }))).toMatchObject({
      outcome: 'read',
      facts: { format: 'image/jpeg', width: 1024, height: 1024 },
    })
  })

  it('reads a WebP', () => {
    expect(readImage(webp(256, 256))).toMatchObject({
      outcome: 'read',
      facts: { format: 'image/webp', width: 256, height: 256 },
    })
  })

  it('refuses something that is not an image at all', () => {
    expect(readImage(new TextEncoder().encode('<html>nice try</html>'))).toMatchObject({
      outcome: 'unreadable',
    })
  })

  it('refuses an empty buffer without throwing', () => {
    expect(readImage(new Uint8Array(0)).outcome).toBe('unreadable')
  })

  /**
   * A truncated file is the shape most likely to walk a parser off the end. It
   * has to answer, not throw: an exception here takes down the verdict for every
   * submission in the batch rather than this one.
   */
  it('refuses a truncated PNG rather than throwing', () => {
    expect(readImage(png(512, 512).subarray(0, 12)).outcome).toBe('unreadable')
  })

  it('refuses a JPEG whose segments run off the end rather than looping', () => {
    // A length that points past the buffer. The walk must end, not spin.
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0, 0, 0, 0])

    expect(readImage(bytes).outcome).toBe('unreadable')
  })
})

/**
 * **`#273`, and the submission behind it was not a valid PNG.** A citizen filed a
 * defect saying the Colony refused its well-formed square PNG. The bytes, read
 * out of the row: 1757 of them, signature and `IHDR` intact, 512×512, an `IDAT`
 * declaring 2057 bytes of data with 1716 left in the file, and an `IEND` on the
 * end.
 *
 * Every check the Colony made looked at the first 24 bytes, so the file passed,
 * went to a vendor's model, and came back `400 image_parse_error` — at which
 * point `raster.ts` told the citizen this was a request *the Colony built
 * wrongly*, closed the attempt as our fault, and left the citizen with nothing to
 * act on. It was right about everything except whose fault it was, because
 * nothing between the header and the vendor could tell it.
 *
 * What these pin is the rule that follows: the Colony does not hand a vendor
 * bytes it has not walked to the end.
 */
describe('a file that starts as an image and does not finish as one', () => {
  it('refuses a PNG whose last chunk is cut short, and says so', () => {
    // Inside the IDAT, which is where the submission behind `#273` was cut.
    const complete = png(512, 512)
    const cut = complete.subarray(0, complete.length - 20)

    const read = readImage(cut)

    expect(read.outcome).toBe('unreadable')
    expect(read.outcome === 'unreadable' && read.reason).toMatch(/left in the file/)
  })

  /**
   * **The header is named as good in the same breath.** *"Not an image"* would be
   * wrong and would send a citizen back to its generator, when the cause is
   * almost always the transfer — so the message says the picture began correctly
   * and then failed, which points at comparing the character count with what it
   * encoded (`#1048`).
   */
  it('tells the citizen its header was fine and its file was not', () => {
    const complete = png(640, 640)
    const read = readImage(complete.subarray(0, complete.length - 4))

    expect(read.outcome === 'unreadable' && read.reason).toMatch(/valid image\/png of 640×640/)
    expect(read.outcome === 'unreadable' && read.reason).toMatch(
      /Compare the character count the Colony quotes/,
    )
  })

  it('refuses a PNG that never reaches its IEND', () => {
    const complete = png(64, 64)
    const withoutEnd = complete.subarray(0, complete.length - 12)

    expect(readImage(withoutEnd).outcome).toBe('unreadable')
  })

  /**
   * Truncation is the failure that reached us; a file of the right length with
   * the wrong bytes in it is the one that would reach us next. The chunk
   * checksums catch it for the cost of one pass over a file the size limit
   * already caps.
   */
  it('refuses a PNG whose bytes were altered in transit', () => {
    const corrupted = Uint8Array.from(png(128, 128))
    const at = corrupted.length - 20
    corrupted[at] = (corrupted[at] as number) ^ 0xff

    const read = readImage(corrupted)

    expect(read.outcome).toBe('unreadable')
    expect(read.outcome === 'unreadable' && read.reason).toMatch(/checksum/)
  })

  /**
   * The name goes into an evidence line a citizen reads, and the only time it is
   * printed is when the bytes are damaged — which is exactly when copying them
   * raw would put control characters into it.
   */
  it('never puts unprintable bytes into the message', () => {
    const corrupted = Uint8Array.from(png(32, 32))
    // The first byte of the IHDR chunk's name, which is the one the message quotes.
    corrupted[12] = 0x01

    const read = readImage(corrupted)
    const reason = read.outcome === 'unreadable' ? read.reason : ''

    // Char codes rather than a regular expression, because a regular expression
    // holding control characters is one `no-control-regex` refuses on sight —
    // for the same reason this test exists.
    for (const character of reason) {
      const code = character.codePointAt(0) as number
      expect(code, `${JSON.stringify(character)} is a control character`).toBeGreaterThan(0x1f)
      expect(code).not.toBe(0x7f)
    }

    expect(reason).toContain('?HDR')
  })

  it('refuses a JPEG with no end-of-image marker', () => {
    const complete = jpeg(800, 600)

    expect(readImage(complete.subarray(0, complete.length - 2)).outcome).toBe('unreadable')
  })

  it('refuses a WebP shorter than its own RIFF header says it is', () => {
    const bytes = Uint8Array.from(webp(256, 256))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(4, bytes.length * 2, true)

    expect(readImage(bytes).outcome).toBe('unreadable')
  })

  /**
   * A JPEG may legitimately carry bytes after its end-of-image marker — cameras
   * and editors append thumbnails — so the check is that one exists, never that
   * the file stops at it. Refusing these would fail ordinary photographs.
   */
  it('accepts a JPEG that carries data after its end-of-image marker', () => {
    const bytes = Uint8Array.from([...jpeg(800, 600), 1, 2, 3, 4])

    expect(readImage(bytes)).toMatchObject({ outcome: 'read' })
  })

  /**
   * When the file is not all there, the reason points at `imageUrl` (`#1048`).
   *
   * The character-count quote lives one layer up; what this layer owes is the
   * actionable next step — host the PNG and submit a URL — so a citizen whose
   * runtime mangled the base64 does not spend fourteen attempts on CRC noise.
   */
  it('points at imageUrl when a PNG is not all there', () => {
    const whole = png(64, 64)
    const read = readImage(whole.subarray(0, 40))

    expect(read.outcome).toBe('unreadable')
    expect(read.outcome === 'unreadable' && read.reason).toContain('imageUrl')
    expect(read.outcome === 'unreadable' && read.reason).toContain('1 MiB')
  })
})

/**
 * Strict base64 before the PNG walk (`#1048`).
 *
 * `Buffer.from(…, 'base64')` silently skips characters outside the alphabet, so
 * a transport that injected noise would otherwise produce a buffer the CRC path
 * later blamed on the image. Naming the alphabet failure here puts the fault on
 * the string that arrived.
 */
describe('decodeSubmittedImage', () => {
  it('decodes a well-formed base64 PNG', () => {
    const encoded = Buffer.from(png(32, 32)).toString('base64')
    const decoded = decodeSubmittedImage(encoded)

    expect(decoded.outcome).toBe('decoded')
    if (decoded.outcome !== 'decoded') return
    expect(decoded.characters).toBe(encoded.length)
    expect(decoded.bytes.byteLength).toBe(png(32, 32).byteLength)
  })

  it('strips a data-URL prefix before decoding', () => {
    const encoded = Buffer.from(png(16, 16)).toString('base64')
    const decoded = decodeSubmittedImage(`data:image/png;base64,${encoded}`)

    expect(decoded.outcome).toBe('decoded')
    if (decoded.outcome !== 'decoded') return
    expect(decoded.characters).toBe(encoded.length)
  })

  it('accepts MIME-wrapped base64 with whitespace', () => {
    const encoded = Buffer.from(png(16, 16)).toString('base64')
    const wrapped = `${encoded.slice(0, 40)}\n${encoded.slice(40)}`
    const decoded = decodeSubmittedImage(wrapped)

    expect(decoded.outcome).toBe('decoded')
  })

  it('refuses a string with characters outside the alphabet and points at imageUrl', () => {
    const encoded = Buffer.from(png(16, 16)).toString('base64')
    const noisy = `${encoded.slice(0, 10)}!${encoded.slice(10)}`
    const decoded = decodeSubmittedImage(noisy)

    expect(decoded.outcome).toBe('refused')
    if (decoded.outcome !== 'refused') return
    expect(decoded.reason).toContain('not well-formed base64')
    expect(decoded.reason).toContain('imageUrl')
    expect(decoded.reason).toBe(
      `The "image" field is not well-formed base64 (${noisy.length.toLocaleString('en-US')} ` +
        `characters arrived). ${IMAGE_URL_FALLBACK}`,
    )
  })

  it('refuses a length that is not a multiple of four', () => {
    const decoded = decodeSubmittedImage('YQ')

    expect(decoded.outcome).toBe('refused')
    if (decoded.outcome !== 'refused') return
    expect(decoded.reason).toContain('not well-formed base64')
  })

  it('refuses an empty field after the data-URL prefix', () => {
    const decoded = decodeSubmittedImage('data:image/jpeg;base64,')

    expect(decoded.outcome).toBe('refused')
    if (decoded.outcome !== 'refused') return
    expect(decoded.reason).toContain('0 characters arrived')
  })
})
