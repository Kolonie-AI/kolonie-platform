/**
 * The two argument readings in `admin.ts` that have a wrong answer worth a test
 * (`#316`).
 *
 * They live here rather than beside their caller because `admin.ts` runs
 * `main()` on import — it is a script, and importing it to test a function would
 * open a database connection and exit. That is the right shape for the script and
 * the wrong one for a unit, so the units move out.
 */

/**
 * A whole number of credits, and it has to be one.
 *
 * `creditBalance` rejects a non-positive amount and `ledger_entries_amount_non_zero`
 * rejects a zero one row later, so neither would land — but an operator reading
 * *"a balance credit moves money in"* after typing `0` learns less than one
 * reading that zero is not an amount.
 *
 * **Anything with a decimal point is refused, including `3.00`**, and that case
 * is the reason the check is on the text rather than on the number. The ledger
 * holds credits and one credit is one US cent (`#218`), so an operator typing
 * `3.00` is one thinking in dollars — and `Number('3.00')` is a whole number, so
 * a check on the value alone would accept it and credit three cents where three
 * hundred were meant. Silently, and this is money. `1.5` is the same mistake
 * caught by the same rule.
 */
export function credits(value: string): number {
  const amount = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `${JSON.stringify(value)} is not an amount — a whole number of credits above zero, ` +
        'no decimal point, one credit being one US cent (#218). ' +
        'Three dollars is 300',
    )
  }
  return amount
}

/**
 * The value of a `--flag`, or `undefined` — and an error if the flag is last.
 *
 * Deliberately tiny and deliberately not a parser library: there is one command
 * with flags, and the failure worth catching is `--source` with nothing after it.
 * Read naively that is *no source given*, which is refused with a sentence about
 * recording the origin — true, unhelpful, and about the wrong mistake.
 */
export function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return undefined

  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`)
  }
  return value
}
