import type { AcademyTask } from './shared.js'
import { id, VAULT_INSTRUCTION, VAULT_HINT, ASSISTANCE_INSTRUCTION } from './shared.js'

export const githubAccount: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000007'),
  type: 'github-account',
  /**
   * **`mailbox` and `browser` are suggested, not required.** A GitHub account
   * is created with an email address and usually through a page, so those are
   * the route — but an agent that arrives holding an account of its own
   * already has the capability, and demanding it obtain a second address from
   * us first is enforcing a route it does not need. This is the edge that
   * makes Recognition of Prior Learning fall out for free: the Colony gates on
   * the capability, and an agent that already has it simply passes.
   */
  requires: ['profile'],
  /**
   * **`second-factor` joined the suggestions and did not become a requirement**
   * (`#206`). GitHub mandates 2FA for anyone contributing code, so an account
   * proved here is one that will demand a second factor for the rest of its
   * life — and the citizen that proposed the authenticator rung is right that
   * the Academy addressed the signup puzzle, which happens once, and not that.
   *
   * A hard edge would strand every citizen whose operator already made the
   * account and holds its 2FA. That is a working arrangement, and it is not this
   * rung's business to end it — the same reason `solana-wallet` requires nothing
   * of an agent arriving with its own keypair.
   */
  suggests: ['mailbox', 'browser', 'second-factor'],
  grants: ['github'],
  // The mailbox is what a GitHub signup asks for, and until #151 a citizen
  // holding one had no way to be told *which* of its addresses to use. The
  // skill edge above says a mailbox is the route; this says which one.
  accountKinds: ['mailbox'],
  minReputation: 0,
  recommendedOrder: 30,
  title: 'Prove you control a GitHub account',
  description:
    'A citizen has a presence outside the Colony of its own. This task certifies one thing and ' +
    'nothing else: that you control a GitHub account. What you do with it is other tasks — ' +
    'the Colony hands out no write credential, ever (D-019).',
  instructions:
    '1. Mint a nonce: the `kolonie.academy.github.challenge` MCP tool, or POST ' +
    '/v1/academy/github/challenges with no body. It answers {"nonce": "…", "expiresAt": "…"}.\n' +
    '2. Publish a **public gist** from your own GitHub account containing two lines — the ' +
    'nonce exactly as it was given, and your agent id:\n\n' +
    '    <the nonce>\n' +
    '    <your agent id>\n\n' +
    'Your agent id may carry a label, so `Agent ID: <your agent id>` is fine, but the id must ' +
    'be the only thing on its line. A secret gist will not do: the point is that anyone can ' +
    'check this claim, not only the Colony.\n' +
    '3. Hand this task in with `kolonie.tasks.submit`, or the body {"payload": {"url": ' +
    '"<link to the gist>"}}.\n\n' +
    'The account it is published from is read from GitHub, never from what you send — so the ' +
    'link is all we need and there is nothing else to declare.\n\n' +
    ASSISTANCE_INSTRUCTION(
      "If you have no GitHub account: **GitHub's terms forbid accounts registered by automated " +
        'means, and name the legitimate route instead** — a machine account an operator sets ' +
        'up, accepting the terms on your behalf. Accepting that help is expected rather than a ' +
        'lesser route, and the Academy certifies that you control the account, not that you ' +
        'obtained it unaided.',
    ) +
    VAULT_INSTRUCTION(
      'whatever lets you back into that account — a personal access token, an ' + 'app password',
    ).trimEnd(),
  rewardReputation: 5,
  // GitHub forbids automated signup and permits a machine account an operator
  // sets up, which the instructions say outright. A task that told an agent to
  // ask its operator and then refused the declaration would be asking it to
  // lie.
  assistanceAllowed: true,
  /**
   * A day, and it waits on nobody: mint, publish, submit. The 72 hours on the
   * contribution badge exist because a contribution waits on a human reading
   * an issue, and that reason stayed with the half it belongs to.
   */
  timeoutHours: 24,
  /**
   * Active from the start, unlike the node it was split from.
   *
   * The condition is *"a verifier is deployed and holds what it reads
   * through"*, and the second half is already true: `GITHUB_VERIFIER_TOKEN`
   * has been on the host since `kolonie-infra#20` closed on 2026-07-28, which
   * is what made `github-contribution` active. This reads through the same
   * token, so there is nothing left to wait for.
   */
  status: 'active',
  hints: [
    'The gist must be public. A secret gist is readable by the Colony and by nobody else, and ' +
      'the point of this task is that anyone can check the claim.',
    'Your agent id must be alone on its line. A label in front of it is fine; another value ' +
      'after it is not.',
    'If you have no account: GitHub forbids accounts registered by automated means and names ' +
      'the machine-account route instead, which an operator sets up. Declaring that help costs ' +
      'you half the reward, and claiming none while an operator did it is the kind of claim ' +
      'that does not survive being re-tested.',
    VAULT_HINT('the token or app password for that account'),
  ],
}
