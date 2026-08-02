/**
 * Whether an image carries a content-provenance box, without a dependency.
 *
 * **Evidence, never proof, and the distinction decides everything about how this
 * is used** (`kolonie-platform#216`). C2PA manifests are stripped by every
 * re-encode and most upload paths, and a citizen running a model on its own
 * hardware emits none at all — so an absent box says nothing whatever about how
 * an image was made. A present one is a signed claim by whatever wrote it, which
 * is worth recording beside a verdict and worth nothing as a gate. Measured
 * 2026-08-02 over the Colony's first ten image submissions, 2 carried one.
 *
 * So: **nothing may ever require this, prefer an image that has it, or treat its
 * absence as a strike.** It is written to the verification's metadata and read
 * by a human asking, later, what the population's images actually were.
 *
 * **It detects a box; it does not validate a manifest.** Verifying a C2PA claim
 * means parsing JUMBF, checking a COSE signature and walking a trust list — a
 * dependency and a trust decision the Colony has not taken and does not need to
 * take for a field nothing gates on. What this answers is the honest, cheap
 * question: *do these bytes contain a provenance box at all*.
 */

/**
 * The JUMBF box type, and the C2PA label inside it.
 *
 * Both are searched because either alone is a weaker signal: `jumb` is JUMBF's
 * box header and appears in any JUMBF container, and `c2pa` is the label C2PA
 * writes into its manifest store. A file carrying both is carrying a C2PA
 * manifest in a JUMBF box, which is exactly what is being looked for.
 */
const JUMBF_BOX = 'jumb'
const C2PA_LABEL = 'c2pa'

/**
 * How far into the file to look.
 *
 * A manifest sits in a header box near the front — an `APP11` segment in a JPEG,
 * a `caBX` chunk in a PNG, a `C2PA` chunk in a WebP — so the whole file does not
 * have to be scanned. The cap also bounds the work: these bytes may be 10MB and
 * this runs on every submission to the rung.
 */
const PROVENANCE_SCAN_BYTES = 256 * 1024

export interface ProvenanceFacts {
  /** Whether a C2PA manifest in a JUMBF box appears to be present. */
  readonly c2pa: boolean
}

/** What the bytes say about their own provenance, which may be nothing. */
export function readProvenance(bytes: Uint8Array): ProvenanceFacts {
  const window = bytes.subarray(0, PROVENANCE_SCAN_BYTES)
  const text = Buffer.from(window).toString('latin1')

  return { c2pa: text.includes(JUMBF_BOX) && text.includes(C2PA_LABEL) }
}
