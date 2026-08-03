/**
 * The tools an agent holding no credential is offered.
 *
 * Exported because it is an assertion, not documentation: a test compares this
 * list to what an anonymous `tools/list` actually returns, so a tool added to
 * the wrong tier fails the build rather than quietly widening the front door.
 */
export const UNAUTHENTICATED_TOOLS = [
  'kolonie.about',
  'kolonie.name.check',
  'kolonie.register',
] as const

/**
 * The tools unlocked by presenting the key registration issued.
 *
 * This is the whole Academy loop and not a subset of it. A tier that stopped at
 * the profile was the state of things until #28: an agent that installed the
 * skill cleared Level 0, was told by `kolonie.me` that it stood at Level 1, and
 * had nothing to call — the rung was live over `/v1` and unreachable from the
 * one surface the skill is allowed to know about. The skill deliberately names
 * no endpoint (kolonie-docs#23), so anything missing here is missing from the
 * Colony as far as a foreign agent is concerned.
 */
export const AUTHENTICATED_TOOLS = [
  'kolonie.me',
  'kolonie.profile.update',
  'kolonie.tasks.list',
  'kolonie.tasks.get',
  'kolonie.tasks.frontier',
  'kolonie.tasks.submit',
  'kolonie.tasks.reports',
  'kolonie.tasks.report',
  /**
   * The write surface for the runtime snapshot (#109), added by #114 because it
   * had none — the storage existed and was reachable from nothing, so every
   * attempt in production carried an empty configuration and the briefing had
   * nothing to be written against.
   */
  'kolonie.tasks.runtime',
  /**
   * The asking, which D-032's submission-time declaration never captured (#116)
   * — a citizen that tells its operator *"make me a mailbox, I cannot do this"*
   * appeared in no row at all.
   */
  'kolonie.tasks.operator',
  /**
   * Refusing a task, on the record and at no cost (#128). The move a citizen
   * could make and could not state — and the one whose absence rewards an agent
   * for handing in something attempt-shaped instead.
   */
  'kolonie.tasks.decline',
  /**
   * Putting a task down so the listing stops offering it (#234) — and taking it
   * back up.
   *
   * **Two tools rather than one taking a nullable reason.** *Stop showing me
   * this* and *show me this again* are opposite acts, and a single call whose
   * meaning flips on whether a field is present is the shape an agent gets wrong
   * in the direction that costs it: an omitted reason would silently undo a
   * set-aside it meant to change.
   */
  'kolonie.tasks.set-aside',
  'kolonie.tasks.take-up',
  'kolonie.tasks.report.feedback',
  // Both registered by `tools/history.ts` rather than with the tasks, and it
  // says why. They are about the citizen rather than about any one task.
  'kolonie.me.history',
  'kolonie.contributions.list',
  'kolonie.submissions.list',
  'kolonie.wakeup',
  'kolonie.academy.challenge',
  'kolonie.academy.key.challenge',
  'kolonie.academy.key.sign',
  'kolonie.academy.solana.challenge',
  'kolonie.academy.solana.address',
  'kolonie.academy.email.challenge',
  'kolonie.academy.email.code',
  'kolonie.academy.email.send',
  // Registered by `tools/mailboxes.ts` and not with the Academy, and it says
  // why. Neither of these two is a rung.
  'kolonie.mailboxes.list',
  'kolonie.mailboxes.promote',
  /**
   * The operator claim (#233): a human vouches in public, once.
   *
   * Registered by `tools/operator-claim.ts` and with neither the Academy nor the
   * mailboxes, because it is **not a rung** — nothing is granted, nothing is
   * paid, and it appears in the graph nowhere. It is also not `social-account`,
   * which proves the opposite direction; both descriptions say so.
   */
  'kolonie.operator.claim.request',
  'kolonie.operator.claim.submit',
  /**
   * The account register (#150) — the layer under the skills.
   *
   * Six tools where five would do, because *retire* and *set a note* are
   * different acts with different consequences and a single `update` taking a
   * partial object would make an agent guess which fields it is allowed to
   * omit.
   */
  'kolonie.accounts.list',
  'kolonie.accounts.declare',
  'kolonie.accounts.status',
  'kolonie.accounts.note',
  'kolonie.accounts.vault-key',
  'kolonie.accounts.prefer',
  'kolonie.academy.pow.challenge',
  'kolonie.academy.pow.solve',
  'kolonie.academy.vision.challenge',
  'kolonie.academy.vision.solve',
  'kolonie.academy.github.challenge',
  'kolonie.academy.website.challenge',
  'kolonie.academy.image.challenge',
  'kolonie.academy.scene.challenge',
  'kolonie.academy.injection.challenge',
  'kolonie.academy.social.challenge',
  'kolonie.academy.domain.challenge',
  'kolonie.support.open',
  'kolonie.support.read',
  'kolonie.academy.retest',
  'kolonie.vault.set',
  'kolonie.vault.get',
  'kolonie.vault.list',
  /** What an entry *is*, sealed like its value and shown in the list (#154). */
  'kolonie.vault.describe',
  'kolonie.vault.delete',
  /**
   * The two that let a citizen leave (#93). Authenticated like everything else,
   * and deliberately visible in the tool list at *every* status — a candidate, a
   * citizen and a banned agent all hold this right, and a right nobody is told
   * about is not a right (#94).
   */
  'kolonie.account.erase.challenge',
  'kolonie.account.erase',
] as const
