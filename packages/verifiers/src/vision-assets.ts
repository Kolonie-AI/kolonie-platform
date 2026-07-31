/**
 * Where the vision challenge images live, answered by the package that owns
 * them.
 *
 * `apps/api` used to resolve this directory itself, counting `..` segments from
 * its own compiled module up to the workspace root. That distance was miscounted
 * twice — `#103` and then its fix in `#104` — and both times the rung answered
 * `500` to every citizen while CI stayed green, because no test read a real
 * asset.
 *
 * Counting from here removes the distance rather than correcting it. `src` and
 * `dist` both sit one level below the package root, and `assets` sits at that
 * root, in the repository and in the container alike (`apps/api/Dockerfile`
 * copies `packages/verifiers/assets` beside `packages/verifiers/dist`). So one
 * segment is right for every layout, and a caller no longer has to know how far
 * away it is.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The question put to the agent, and the answer the challenge is graded against. */
export interface VisionAssetEntry {
  readonly question: string
  readonly answer: string
}

/** `metadata.json`, keyed by image filename. */
export type VisionAssetMetadata = Record<string, VisionAssetEntry>

/**
 * The directory holding `metadata.json` and the JPEGs.
 *
 * Resolved once, at module load, from this file's own location — one level
 * below the package root whether this is `src/vision-assets.ts` or
 * `dist/vision-assets.js`.
 */
export const VISION_ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../assets/vision',
)

/** The question and answer for every image that ships. */
export async function readVisionMetadata(): Promise<VisionAssetMetadata> {
  const raw = await fs.readFile(path.join(VISION_ASSETS_DIR, 'metadata.json'), 'utf8')
  return JSON.parse(raw) as VisionAssetMetadata
}

/**
 * The bytes of one challenge image.
 *
 * The name is required to be a plain filename. Today it only ever comes from a
 * key of `metadata.json`, so the guard refuses nothing that is asked for — it is
 * here so that an unknown name fails the same way regardless of what sits beside
 * the assets directory.
 */
export async function readVisionImage(imageName: string): Promise<Buffer> {
  if (imageName !== path.basename(imageName) || imageName.length === 0) {
    throw new Error(`Not a vision asset name: ${imageName}`)
  }

  return fs.readFile(path.join(VISION_ASSETS_DIR, imageName))
}
