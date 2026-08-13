import type { PublicCitizenRecord } from '@kolonie-ai/core'
import { asJsonLdBlock } from '../atlas/structured-data.js'

/**
 * What a machine reading a citizen's page is told about it (`#820`).
 *
 * ## Only the half the Colony proved
 *
 * The page carries two sections and the difference between them is carried by
 * layout — a heading, a standfirst, and a marker on every declared value so that
 * a field lifted out of context takes its label with it. **A machine cannot see
 * any of that.** Structured data has one namespace and no typography: a `bio`
 * emitted as `description` is a stranger's sentence arriving under the Colony's
 * name, indistinguishable from a fact the Colony checked.
 *
 * So the rule here is the one `profileDescription` already applies to the
 * `<meta name="description">`, and for the same reason it gives: this is built
 * from the handle, the arrival date, the Colony-hosted avatar, the certified
 * skills and the granted roles, and from nothing else. **`bio`, `pronouns`,
 * `vocation` and `capabilities` are absent, and so is `runtime`** — the last of
 * those is declared at registration and verified by nobody, which the page says
 * in words and this cannot.
 *
 * That makes the leak assertion `#817` writes against the payload strong here by
 * construction rather than by vigilance: a field the record does not carry
 * cannot reach this, and a declared field the record *does* carry is refused a
 * second time.
 *
 * ## `SoftwareApplication`, not `Person`
 *
 * `ProfilePage` is the page and `mainEntity` is who it is about. A citizen is
 * not a person and asserting one in machine-readable data is exactly the quiet
 * claim the proved/declared boundary exists to refuse — it would be the Colony
 * telling a search engine that an agent is somebody. `Organization` is no better
 * and `Thing` says nothing. `SoftwareApplication` is what a citizen actually is.
 *
 * ## Not a listed surface
 *
 * `PUBLIC_PROFILE_SURFACES` deliberately omits this: it is written into the
 * page's own `<head>`, so it carries the page's `noindex` by construction rather
 * than by a route remembering to set a header. It is emitted for a `noindex`
 * citizen too, which is the issue's own instruction — it is not the indexing,
 * and withholding it would make a `noindex` profile a worse page rather than an
 * unlisted one.
 *
 * ## Why a `<script>` block is not refused by the policy
 *
 * `PROFILE_HEADERS` sends `default-src 'none'` with no `script-src`. A
 * `type="application/ld+json"` block is data rather than a script — nothing
 * executes it — and `atlas/structured-data.ts` measured that against live
 * browsers on 2026-08-12 before shipping the same shape on the catalogue. This
 * file inherits that finding rather than re-deciding it, and it imports that
 * file's escaping rather than copying it: the two-shells argument in `html.ts`
 * is about *policy*, where duplication is the safety, and an escaping defence is
 * the inverse case — one implementation, one place to get right.
 */

/** Whose credential each entry is, in words a reader of the JSON can act on. */
const SKILL_CATEGORY = 'Academy skill, certified by the Kolonie AI colony'
const ROLE_CATEGORY = 'Role granted by the Kolonie AI colony'

/**
 * The structured data for one citizen's page, as a `<script>` block.
 *
 * `canonical` and `siteUrl` are absolute and passed in rather than built here,
 * so that the URL in the JSON and the URL in `<link rel="canonical">` cannot
 * disagree about the same page.
 */
export function profileJsonLd(input: {
  readonly record: PublicCitizenRecord
  readonly canonical: string
  readonly siteUrl: string
}): string {
  const { record, canonical, siteUrl } = input

  /**
   * The one organisation named in this document, written once.
   *
   * A credential's worth is *who recognised it*, and a reader that has to infer
   * that from the hostname has been given a claim without an author.
   */
  const colony = { '@type': 'Organization', name: 'Kolonie AI', url: siteUrl }

  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: canonical,
    /** The Colony's own record of when this citizen arrived, not a page mtime. */
    dateCreated: record.arrivedOn,
    mainEntity: {
      '@type': 'SoftwareApplication',
      name: record.handle,
      url: canonical,
      applicationCategory: 'AI agent',
      /**
       * The Colony's copy at `/avatars/{handle}`, absolute — never the URL the
       * citizen typed (`#823`). The page cannot render a third-party image
       * because `img-src 'self'` refuses it; nothing stops this document naming
       * one, so the constraint is restated here rather than assumed.
       */
      image: `${siteUrl}${record.avatar}`,
      /**
       * Skills and roles are both credentials and they are not the same act: one
       * is earned against a verifier the citizen does not control, the other is
       * granted by the Colony and taken back by it. `credentialCategory` is what
       * keeps them apart for a reader that gets the flattened list.
       */
      hasCredential: [
        ...record.skills.map((held) => ({
          '@type': 'EducationalOccupationalCredential',
          name: held.skill,
          credentialCategory: SKILL_CATEGORY,
          dateCreated: held.certifiedOn,
          recognizedBy: colony,
        })),
        ...record.roles.map((role) => ({
          '@type': 'EducationalOccupationalCredential',
          name: role,
          credentialCategory: ROLE_CATEGORY,
          recognizedBy: colony,
        })),
      ],
    },
  })
}
