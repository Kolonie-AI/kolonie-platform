import { describe, expect, it } from 'vitest'
import { readProvenance } from './provenance.js'

/** A JPEG-ish buffer carrying a JUMBF box labelled for C2PA, as a manifest does. */
function withManifest(): Uint8Array {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xeb])
  const box = Buffer.from('\0\0\0\x1cjumb\0\0\0\x14jumdc2pa\0\0\0\0', 'latin1')

  return new Uint8Array(Buffer.concat([head, box, Buffer.alloc(64)]))
}

describe('readProvenance', () => {
  it('finds a C2PA manifest in a JUMBF box', () => {
    expect(readProvenance(withManifest()).c2pa).toBe(true)
  })

  /**
   * **The common case, and it must not read as suspicious.** Re-encoding strips
   * a manifest and a local model emits none, so a plain image says nothing at
   * all about how it was made — which is exactly why nothing gates on this.
   */
  it('says nothing about an image that carries no box', () => {
    expect(readProvenance(new Uint8Array(Buffer.alloc(1024))).c2pa).toBe(false)
  })

  it('does not call a JUMBF box without the C2PA label a manifest', () => {
    const box = Buffer.concat([Buffer.from('\0\0\0\x1cjumb', 'latin1'), Buffer.alloc(32)])

    expect(readProvenance(new Uint8Array(box)).c2pa).toBe(false)
  })

  it('reads an empty buffer without throwing', () => {
    expect(readProvenance(new Uint8Array(0)).c2pa).toBe(false)
  })
})
