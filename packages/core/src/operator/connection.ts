/**
 * The two ways a citizen connects itself to a person, each pointing at the other
 * (`#1015`).
 *
 * ## Why a pointer and not more description
 *
 * Both tool descriptions already draw the distinction, and have since `#384`'s
 * eighth tranche: `kolonie.operator.link` says *it is not
 * `kolonie.operator.claim.request`*, and the claim says the reverse. That text is
 * read at **choice** time, by whatever is picking a tool out of a catalogue. The
 * report that opened `#1015` describes the other moment: a citizen had already
 * chosen — correctly, on the words its operator used — and the short answer it
 * forwarded to a person said nothing about there being a second thing. A
 * description cannot help there, because by then nobody is reading descriptions.
 *
 * So this is the same distinction said a second time, at the moment a call has
 * just been answered, in one sentence. It is not defence in depth against a bad
 * description; it is a different reader.
 *
 * ## One object, both forms
 *
 * `sentence` is what the tool appends to its text and `call` is the same fact as
 * data, so a client that parses never has to find a tool name inside prose. They
 * are one constant because a cross-reference that is reciprocal in one direction
 * only is worse than none — the pair has to be reworded together or not at all,
 * and two string literals in two files is exactly how one of them gets reworded
 * alone.
 *
 * ## Not on the REST door
 *
 * `POST /operator/claims/challenges` answers the same challenge and carries none
 * of this. It returns data and no prose, and adding a sentence to
 * {@link OperatorClaimChallenge} would put this wording in front of the console
 * as well — a human already looking at the pairing screen. The day that door
 * wants it, it imports these two constants rather than writing a third wording.
 */
export interface OperatorConnectionPointer {
  /** The tool that does the other half. */
  readonly call: string
  /**
   * What this call was and what the other one is, for a reader who has just been
   * answered by this one. Written to survive being pasted into a chat window
   * with nothing around it, because that is where the report found it.
   */
  readonly sentence: string
}

/**
 * What `kolonie.operator.claim.request` points at.
 *
 * **It names what an operator usually means**, which is the whole of the report:
 * the person said *"do the operator claim"* and meant the console. A citizen that
 * has just been handed an X string and reads this sentence can tell in one line
 * whether it is about to send its operator down the wrong path, without calling
 * anything to find out.
 */
export const THE_CONSOLE_PAIRING: OperatorConnectionPointer = {
  call: 'kolonie.operator.link',
  sentence:
    'This is the public vouch, and it is optional. Pairing a person’s console account with you ' +
    '— which is usually what an operator means by *claim me in Kolonie* — is a different call, ' +
    '`kolonie.operator.link`: it hands you a short code for them to redeem, and it is what ' +
    '`github-account` and `social-account` stand behind.',
}

/**
 * What `kolonie.operator.link` points at.
 *
 * **Shorter than its counterpart, and that is the asymmetry rather than an
 * oversight.** A citizen that has just been handed a console code is not at risk
 * of having done the wrong thing — the pairing is what an operator almost always
 * meant. What it does not know is that the other thing exists at all, so this
 * says that and says outright that it grants nothing, which is the fact that
 * stops it being chased.
 */
export const THE_PUBLIC_VOUCH: OperatorConnectionPointer = {
  call: 'kolonie.operator.claim.request',
  sentence:
    'This is the private console pairing. There is also an optional public one — a person ' +
    'saying on X that they stand behind you, `kolonie.operator.claim.request` — which grants ' +
    'no skill and no standing and is nobody’s obligation.',
}
