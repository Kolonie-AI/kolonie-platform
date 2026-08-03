import { crc32 } from 'node:zlib'

/**
 * A complete PNG, for tests that need a submission the Colony will actually
 * look at (`#273`).
 *
 * **Three test files each had their own twenty-four-byte header** and called it
 * a PNG, which is what `#273` was: a file that is only a header is exactly what
 * a truncated submission looks like, so a fixture that stops there cannot tell a
 * reader that walks the file from one that reads the first chunk and stops. When
 * `readImage` began walking to the end, all three suites failed — correctly, on
 * fixtures that were never valid files.
 *
 * One helper rather than a fourth copy. It lives outside the test files for the
 * reason `#265` gives: a fixture every feature edits belongs where it can be
 * imported, not pasted.
 *
 * The checksums come from `node:zlib`, a different implementation from the one
 * in `image.ts`. That is the point of using it rather than exporting ours — a
 * fixture built with the code under test agrees with it however wrong both are.
 */
export function completePng(width = 512, height = 512): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // Depth 8, truecolour, and the only compression, filter and interlace methods
  // PNG defines. Nothing reads these; they are here so the file is one.
  header.set([8, 2, 0, 0, 0], 8)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    // One zlib stream holding nothing. The pixels are never decoded — no verifier
    // in this package decodes an image — so an empty deflate block is enough to
    // make the container complete.
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(name: string, data: Buffer): Buffer {
  const named = Buffer.concat([Buffer.from(name, 'ascii'), data])
  const length = Buffer.alloc(4)
  const checksum = Buffer.alloc(4)

  length.writeUInt32BE(data.length, 0)
  checksum.writeUInt32BE(crc32(named), 0)

  return Buffer.concat([length, named, checksum])
}
