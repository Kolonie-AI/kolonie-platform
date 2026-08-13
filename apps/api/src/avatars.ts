import type { AvatarFormat } from '@kolonie-ai/core'

/**
 * What the public avatar route reads (`#823`).
 *
 * A port rather than a database handle, for the reason every other read on
 * `RouteDependencies` is one: the route's behaviour — an image for a citizen
 * that exists, a placeholder for one with none, a 404 for a name nobody holds —
 * is decidable without a database, and it is the part worth testing.
 */
export interface AvatarDesk {
  publicAvatar(handle: string): Promise<ServedAvatar>
}

/**
 * Three answers, and the middle one is the design.
 *
 * A citizen with no avatar is **not** a 404: it gets a generated placeholder, so
 * that a page never has a hole where an image should be and so that *has no
 * avatar* and *does not exist* are not two distinguishable answers. Only a name
 * nobody holds is missing.
 */
export type ServedAvatar =
  | { readonly outcome: 'unknown-citizen' }
  | { readonly outcome: 'placeholder'; readonly handle: string }
  | {
      readonly outcome: 'image'
      readonly avatar: {
        readonly bytes: Uint8Array
        readonly format: AvatarFormat
      }
    }
