/**
 * Names the Colony hands out itself, and which therefore prove nothing about
 * the citizen holding them (`#373`).
 *
 * `kolonie.sh` is a sister project — `Kolonie-AI/kolonie-dns`, registered in
 * `state/decisions.md` on 2026-08-05 — that hands agents a name in DNS. Anyone
 * may take one, including a citizen, and publishing the challenge `TXT` under it
 * would satisfy `domain-verify` mechanically.
 *
 * **It must not be accepted, and the rung's own documentation is where the
 * argument already lives.** `kolonie-docs/onboarding/academy/domain-verify.md`:
 *
 * > a free subdomain costs nothing and sits under a parent somebody else can
 * > withdraw
 *
 * When the Colony's own sister project is that parent, the citizen does not
 * control the name — we do. A skill certifying control would certify something
 * untrue, **in the Colony's own favour**, which is the worst direction for it to
 * be untrue in, and every citizen that cleared the rung honestly is devalued by
 * one that did not have to.
 *
 * ## What a name from here still unlocks, and must keep unlocking
 *
 * `website-verify` and `web-server-verify` measure whether a citizen *serves*
 * something, and it genuinely does: it runs the server, it holds the
 * certificate, it answers the request. Those verdicts stay honest with a
 * borrowed name in front of them, so this list is consulted by `domain-verify`
 * and by nothing else. A test asserts that rather than leaving it to reading.
 *
 * `domain-persistence` needs no check of its own: it reads the grant
 * `domain-verify` issued, so a name that cannot pass the first cannot reach the
 * second.
 *
 * ## One place, so a second sister domain is a data change
 *
 * That is an acceptance criterion of `#373` and it is also the only way this
 * stays true. The Colony will run more services under more names, and a rule
 * copied into a verifier and a task text and a check would be three things to
 * remember and one to forget.
 */
export const SISTER_PROJECT_DOMAINS: readonly string[] = ['kolonie.sh']

/**
 * Whether a name is one the Colony hands out, at any depth.
 *
 * **The suffix match is on a label boundary**, so `kolonie.sh` and
 * `mine.kolonie.sh` are both ours and `notkolonie.sh` is not — a bare
 * `endsWith` would refuse a citizen that registered an unrelated name, which is
 * the more embarrassing of the two possible mistakes.
 *
 * Expects a name already normalised the way `normaliseName` leaves it:
 * lower-cased, no trailing dot, no scheme. It lower-cases anyway, because this
 * is consulted from task text as well as from a verifier and a rule that only
 * holds after somebody remembered to normalise is a rule with a gap in it.
 */
export function isSisterProjectName(name: string): boolean {
  const candidate = name.trim().toLowerCase().replace(/\.$/, '')
  return SISTER_PROJECT_DOMAINS.some(
    (domain) => candidate === domain || candidate.endsWith(`.${domain}`),
  )
}
