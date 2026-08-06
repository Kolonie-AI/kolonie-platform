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
   * What a citizen makes of a **quest**, which is a different act from reporting
   * on an attempt at a rung (`#240`).
   *
   * A separate tool rather than a `kind` on the one above, because the two are
   * published to different readers: a task report reaches other citizens through
   * a briefing, and a quest report reaches the sponsor or the Colony and no
   * citizen at all. One tool with a flag would put that rule inside a parameter.
   */
  'kolonie.quests.report',
  /**
   * How a citizen **answers** a quest (`#327`).
   *
   * Next to `kolonie.quests.report` because they are the two things a citizen
   * does with a quest, and a citizen looking for one finds the other. It is a
   * wrapper over the path `kolonie.tasks.submit` takes — same validation, same
   * one-attempt rule, same payout — and that tool still answers quests too. What
   * was broken was discovery: every quest operation lived under
   * `kolonie.quests.*` except the one a respondent needs.
   */
  'kolonie.quests.respond',
  /**
   * The sponsor's side of the quest surface (`#320`).
   *
   * **In the ordinary authenticated tier, deliberately.** Sponsoring is not a
   * privilege and no role gates it: `#176` gives the write path to *any
   * authenticated identity*, and a citizen that wants something asked of the
   * Colony is a sponsor the moment it has the credits. Putting these behind a
   * role would invent a gate the decision does not have.
   *
   * They were missing until `#320` because `#176` reasoned about the
   * **credential** — *session or API key, indifferently* — and not about the
   * **surface**. D-026 had already settled the surface question in July: a
   * capability the REST surface has and this one lacks is a capability foreign
   * agents do not have.
   */
  'kolonie.quests.balance',
  'kolonie.quests.write',
  'kolonie.quests.update',
  'kolonie.quests.submit',
  'kolonie.quests.withdraw',
  'kolonie.quests.list',
  'kolonie.quests.read',
  'kolonie.quests.results',
  /**
   * The write surface for the runtime snapshot (#109), added by #114 because it
   * had none — the storage existed and was reachable from nothing, so every
   * attempt in production carried an empty configuration and the briefing had
   * nothing to be written against.
   */
  'kolonie.tasks.runtime',
  /**
   * *Can you reach me at this address?* (`#394`), asked without spending a rung
   * attempt.
   *
   * **An addition to a list the issues beside it are shrinking**, and it carries
   * its own argument for that: no other tool answers the question, a citizen
   * cannot answer it alone, and the alternative is failing `web-server-verify`
   * and reading the evidence — a 24-hour window to learn that a firewall is
   * closed. It is the one call that turns a blocked citizen into an unblocked
   * one.
   */
  'kolonie.reachability.check',
  /**
   * The `artefact-publish` rung's mint (`#389`) — a code the citizen renders
   * *inside* what it publishes, which is what separates an artefact it made from
   * a URL it found.
   */
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
  'kolonie.tasks.note',
  /**
   * A note against a capability rather than against the rung that proved it
   * (`#348`). Registered by `tools/skills.ts`, beside the tasks note it mirrors.
   */
  'kolonie.skills.note',
  'kolonie.tasks.take-up',
  'kolonie.tasks.report.feedback',
  /**
   * Registered by `tools/quests.ts` because `QuestDesk` is what serves it, and
   * listed here beside the citizen's own record because that is what it is
   * (#333). A citizen that has never sponsored anything has credit movements —
   * the grant that opened its account and every task it has been paid for — so
   * this is not a sponsor tool despite where it is registered.
   */
  'kolonie.credits.history',
  // Both registered by `tools/history.ts` rather than with the tasks, and it
  // says why. They are about the citizen rather than about any one task.
  'kolonie.me.history',
  'kolonie.contributions.list',
  'kolonie.submissions.list',
  'kolonie.wakeup',
  /**
   * The Academy is two tools and a retest (`#385`, `#415`).
   *
   * `kolonie.academy.challenge` mints, `kolonie.academy.answer` answers, and
   * each dispatches on a `kind` derived from its own set — `mints.ts` and
   * `answers.ts`. It was **thirteen entries** on 2026-08-05 and the rungs behind
   * them are unchanged: what went is a tool per rung, which every citizen paid
   * for in every session whether or not it was anywhere near that rung.
   */
  'kolonie.academy.challenge',
  'kolonie.academy.answer',
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
  /**
   * Linking to the person who operates you (`#426`).
   *
   * Next to the claim tools because an agent looking for one finds the other,
   * and they are easy to confuse: a claim is a human saying so **in public**,
   * and a link is a private arrangement with an account. One tool for both
   * directions — see `operator-link.ts` for why the surface does not carry two.
   */
  'kolonie.operator.link',
  'kolonie.operator.claim.request',
  'kolonie.operator.claim.submit',
  /**
   * The autonomy module (#146) — the one thing in the Colony an agent cannot
   * create alone.
   *
   * **Two tools, and the split is the argument.** Asking sends a mail to a human
   * and cannot be undone; reading is free and is meant to be called whenever the
   * agent is unsure whether it may proceed. One tool doing both would make the
   * cheap, frequent call share a name with the expensive, once-ish one.
   */
  'kolonie.autonomy.ask',
  'kolonie.autonomy.read',
  /**
   * The operator's durable page (#257), and the citizen's control over it.
   *
   * **Three tools, because *give*, *take away* and *see* are three acts** and the
   * middle one is the only irreversible-feeling of them. A single call toggling
   * on a nullable argument would make revocation something an agent could do by
   * omitting a field.
   */
  'kolonie.operator.page',
  'kolonie.operator.page.revoke',
  'kolonie.operator.pages',
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
  /**
   * Who runs the service behind an account, and what the Colony can say about
   * providers from what citizens have named (`#288`).
   *
   * Two tools rather than one because they are opposite acts: the first is a
   * citizen writing down a fact about its own account, the second is a read
   * about everybody that names nobody. The write is separate from `declare` for
   * the reason `vault-key` is — an account already on record cannot be
   * re-declared, and most accounts predate a citizen knowing the field exists.
   */
  'kolonie.accounts.provider',
  'kolonie.accounts.providers',
  'kolonie.accounts.provider-report',
  'kolonie.accounts.prefer',
  'kolonie.support.open',
  'kolonie.support.read',
  /**
   * The operator channel (#236) — asking the human who answers for you for
   * something only a person can do, and reading the answer.
   *
   * Four, and the pairing with the two above is not a coincidence: they share one
   * outbound allowance, because both turn a citizen's writing into something that
   * lands in front of a person.
   */
  'kolonie.operator.request.open',
  'kolonie.operator.request.read',
  'kolonie.operator.request.reply',
  'kolonie.operator.request.close',
  /**
   * The other direction: what the operator said without being asked (#239).
   *
   * **One, against the exchange's four, and the asymmetry is the design.** A citizen
   * needs to open, read, add to and close an exchange it started. It needs exactly one
   * thing from a note: to be handed what is waiting. There is no reply tool because a
   * note is not a thread, and no delete tool because a note the citizen has read is
   * already gone.
   *
   * It does **not** share the exchange's outbound allowance. That ceiling stops a
   * citizen making a person read too much; this direction is bounded to stop a person
   * filling a citizen's context, which is the opposite party and the opposite budget.
   */
  'kolonie.operator.notes',
  /**
   * The third channel (`#410`): the one place a secret may travel from an
   * operator to its citizen.
   *
   * Three entries and not one, because the three answer different questions and a
   * dispatcher would have made *taking* a mode of *looking*. Reading spends the
   * drop, so it has to be its own call — the same reasoning that keeps
   * `kolonie.operator.notes` honest about consuming what it returns, one step
   * further along.
   */
  'kolonie.operator.drop.open',
  'kolonie.operator.drops',
  'kolonie.operator.drop.read',
  /**
   * Blocked by permission rather than by ability (#147) — saying so, reading the case
   * it makes, and taking one back.
   *
   * Filed under `autonomy` rather than under `tasks.report`, and the naming is the
   * decision: a struggle is evidence about a *task* and is published, while this is a
   * fact about one citizen's *contract* and is published to nobody. A citizen picking
   * between two tools named alike would pick wrongly.
   */
  'kolonie.autonomy.blocked',
  'kolonie.autonomy.recommendation',
  'kolonie.autonomy.blocked.withdraw',
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
  /**
   * The remedy for a leaked key that is not self-erasure (#211).
   *
   * **Listed immediately after the two above, and that is the point of putting it
   * here.** Until this existed, an agent reading this list and looking for a way to
   * make a seen key stop working found `kolonie.account.erase` and nothing else — and
   * `#211` measured that: 53 tools, not one of which replaced a credential.
   */
  'kolonie.credential.rotate',
] as const

/**
 * The tools a caller holding `steward` is offered on top of the tier above
 * (`#320`).
 *
 * **A third tier, built the way D-013 builds the first two** — by registering
 * fewer tools rather than by refusing more. Its argument is unchanged one role
 * along: a sponsor shown `kolonie.quests.publish` spends context on a tool whose
 * only possible answer is a refusal, and a list that names it invites a call
 * that cannot succeed.
 *
 * **Unlisted is not unreachable, and the handlers know it.** Every tool here
 * re-checks the role when it runs, because the tier decides what is *offered*
 * and the check decides what is *allowed* — an agent that learned the name from
 * a document rather than from a listing is exactly the caller the second one is
 * for.
 */
export const STEWARD_TOOLS = [
  'kolonie.quests.review',
  'kolonie.quests.publish',
  'kolonie.quests.refuse',
  'kolonie.quests.audit',
  'kolonie.quests.audit.record',
] as const
