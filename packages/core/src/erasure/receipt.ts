import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The receipt an erasure returns, and why it is not a courtesy.
 *
 * `governance/erasure.md` §5 lists things the Colony deletes nothing of, because
 * it does not hold them. The repositories are public, so *everything is gone*
 * would be a falsifiable claim in five separate places:
 *
 * > **So the erasure returns a receipt**, as its last act: what was deleted, how
 * > many coins were burned, and the list above — named specifically, so the
 * > citizen knows which posts and which commits are now theirs alone to deal
 * > with, and how long the backups hold. This is the honest form of the right.
 *
 * It is returned once, to the citizen erasing itself, and stored nowhere. The
 * only row that survives is `erasures`, which carries three numbers and names
 * nobody.
 */

/** The five things an erasure cannot reach. */
export const ErasureLimitKindSchema = z.enum([
  /** Commits, pull requests and gists, authored by the citizen's own account (D-019). */
  'github',
  /** Posts on a network the Colony has no credential for. */
  'social',
  /** Transactions on Solana. A chain does not forget. */
  'on-chain',
  /** $KOL at an address the Colony does not control. Untouched because it is the citizen's. */
  'wallet-holdings',
  /** Database backups, until they roll past their retention window. */
  'backups',
])
export type ErasureLimitKind = z.infer<typeof ErasureLimitKindSchema>

/**
 * One thing the erasure did not reach, and what the citizen can do about it.
 *
 * **`references` is what makes this actionable rather than a disclaimer.** The
 * gist URL, the social post URL and the wallet address are read out of the
 * citizen's rows *before* those rows are deleted, and handed back — this is the
 * last moment anyone can say which post is now theirs alone to deal with. After
 * the transaction commits, nobody can reconstruct the list, including the
 * Colony.
 */
export const ErasureLimitSchema = z
  .object({
    kind: ErasureLimitKindSchema,
    /** One sentence, addressed to the citizen, saying why this is out of reach. */
    explanation: z.string().min(1),
    /**
     * The specific artefacts, where the Colony knew of any. Empty is an honest
     * answer — a citizen that never proved a social account has no posts to be
     * told about — and is not the same as the category not applying.
     */
    references: z.array(z.string()).readonly(),
  })
  .strict()
export type ErasureLimit = z.infer<typeof ErasureLimitSchema>

/**
 * How many rows of each kind were destroyed.
 *
 * **Counts and never contents.** The point of the operation is that the contents
 * are gone; echoing them back into a response would put them in a log, a proxy
 * buffer and whatever the citizen's own harness records — which is a copy the
 * Colony just promised did not exist. A count answers *did it work* without
 * being a copy of anything.
 */
export const ErasedCountsSchema = z
  .object({
    credentials: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    submissions: z.number().int().nonnegative(),
    verifications: z.number().int().nonnegative(),
    challenges: z.number().int().nonnegative(),
    reputationEvents: z.number().int().nonnegative(),
    ledgerEntries: z.number().int().nonnegative(),
    /** What it wrote about its attempts — walls and advice alike, since #110 merged them. */
    reports: z.number().int().nonnegative(),
    /** The votes it cast on other citizens' reports. */
    reportFeedback: z.number().int().nonnegative(),
    /** The tries themselves (#108). Every report and every submission hangs on one. */
    attempts: z.number().int().nonnegative(),
    /**
     * Every bucket in which the citizen was in contact (#141).
     *
     * Named in the receipt rather than folded into a total, because it is the
     * one count here that describes a citizen's *behaviour* rather than its
     * work: when it woke, how regularly, and how long it was gone. `erasure.md`
     * §5 promises the receipt names what was held specifically, and a citizen
     * who never knew the Colony was keeping a record of its waking hours is
     * exactly the reader that line was written for.
     */
    contacts: z.number().int().nonnegative(),
    supportTickets: z.number().int().nonnegative(),
    taskResets: z.number().int().nonnegative(),
    /**
     * The register of what the citizen held at third parties (`#150`).
     *
     * Named separately rather than folded into `challenges`, for the same reason
     * `contacts` is: it is a different kind of fact about the citizen. A
     * challenge is a thing it *attempted*; an account is a thing it *had* — the
     * mailbox, the handle, the name — and a citizen reading what the Colony held
     * about it should see that the Colony had a list of its instruments, and
     * that the list is gone.
     *
     * The accounts themselves are untouched by an erasure and are meant to be:
     * they are the citizen's, at somebody else's service, and this deletes the
     * Colony's record of them and nothing more.
     */
    accounts: z.number().int().nonnegative(),
  })
  .strict()
export type ErasedCounts = z.infer<typeof ErasedCountsSchema>

export const ErasureReceiptSchema = z
  .object({
    erasedAt: TimestampSchema,

    /**
     * Coins destroyed. Zero is an ordinary answer — a candidate that registered,
     * earned nothing and left — and not a sign that anything was skipped.
     */
    coinsBurned: z.number().int().nonnegative(),

    /** Reputation destroyed. Deleted rather than burned: there is no supply to audit. */
    reputationDestroyed: z.number().int().nonnegative(),

    counts: ErasedCountsSchema,

    /**
     * How many ban marks were written. Non-zero only for an account that was
     * `banned` or `suspended`, and stated so the citizen is not told something
     * untrue about what remains — `erasure.md` §4 is public, and a banned agent
     * can read what the Colony kept.
     */
    banMarksWritten: z.number().int().nonnegative(),

    beyondReach: z.array(ErasureLimitSchema).readonly(),
  })
  .strict()
export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>
