import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  readVisionImage,
  readVisionMetadata,
  VISION_ASSETS_DIR,
  type VisionAssetMetadata,
} from './vision-assets.js'

/**
 * These read the assets that actually ship. That is the whole point of them.
 *
 * The rung answered `500` to every citizen twice — `#103`, then its fix in
 * `#104` — and CI was green through both, because every test in the repository
 * substituted a fake whose `getMetadata` returned a literal. A wrong path was
 * therefore not something a test could notice. Any test here that stops touching
 * the filesystem has removed the only thing standing between a miscounted `..`
 * and production.
 */
describe('vision assets', () => {
  it('resolves to the assets directory at the package root', () => {
    // `assets` is a sibling of `src` and of `dist`, so a module one level below
    // the package root finds it with a single `..` from either. Asserting the
    // parent is the package root is what makes that true for `dist` as well,
    // which no test can load directly from here.
    expect(path.basename(VISION_ASSETS_DIR)).toBe('vision')
    expect(path.basename(path.dirname(VISION_ASSETS_DIR))).toBe('assets')
    expect(path.basename(path.resolve(VISION_ASSETS_DIR, '../..'))).toBe('verifiers')
  })

  it('reads metadata.json from disk', async () => {
    const metadata = await readVisionMetadata()

    expect(Object.keys(metadata).length).toBeGreaterThan(0)

    for (const [name, entry] of Object.entries(metadata)) {
      expect(name, `${name} is a plain filename`).toBe(path.basename(name))
      expect(entry.question.length, `${name} has a question`).toBeGreaterThan(0)
      expect(entry.answer.length, `${name} has an answer`).toBeGreaterThan(0)
    }
  })

  it('reads every image metadata.json names, and each one is a JPEG', async () => {
    const metadata = await readVisionMetadata()

    for (const name of Object.keys(metadata)) {
      const bytes = await readVisionImage(name)

      expect(bytes.length, `${name} is not empty`).toBeGreaterThan(0)
      // SOI marker. `openVisionChallenge` appends random bytes to defeat hash
      // matching, so the tail is deliberately not a JPEG EOI and is not checked.
      expect([bytes[0], bytes[1]], `${name} starts with a JPEG SOI`).toEqual([0xff, 0xd8])
    }
  })

  it('ships no image metadata.json does not describe', async () => {
    const metadata: VisionAssetMetadata = await readVisionMetadata()
    const onDisk = (await fs.readdir(VISION_ASSETS_DIR)).filter((name) => name !== 'metadata.json')

    expect([...onDisk].sort()).toEqual(Object.keys(metadata).sort())
  })

  it('rejects a name that is not in metadata.json', async () => {
    await expect(readVisionImage('vision_99_nonexistent.jpg')).rejects.toThrow()
  })

  it('rejects a name that tries to leave the assets directory', async () => {
    await expect(readVisionImage('../../package.json')).rejects.toThrow(/not a vision asset name/i)
    await expect(readVisionImage('')).rejects.toThrow(/not a vision asset name/i)
  })
})
