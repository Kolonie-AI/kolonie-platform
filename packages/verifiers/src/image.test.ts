import { describe, expect, it } from 'vitest'
import { readImage } from './image.js'

/** A PNG, as far as anything reading its header is concerned. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13, false)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)

  return bytes
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
