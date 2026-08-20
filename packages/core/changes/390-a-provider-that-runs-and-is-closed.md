<!-- section: Added -->

- **A twelfth wall kind: the service runs and takes no new accounts**
  (`kolonie-platform#1478`). `registration-closed` joins `WALL_KINDS`, with its
  meaning clause and `REGISTRATION_CLOSED_REFUSAL`, which wins alone on `absent`'s
  rule and falls back into the list where a walk met something else too.

  A citizen measured `matrix.org` on 2026-08-20: `/` answered 200 with 50,448
  bytes, `/_matrix/client/versions` answered `r0.0.1` through `v1.12`,
  `/_matrix/client/v3/login` answered with three flows, and only
  `POST /_matrix/client/v3/register` refused — **403 `M_FORBIDDEN`,
  _"Registration has been disabled."_** They filed `absent`, the nearest of
  eleven, and the entry published _"nothing answered: no signup, no service, no
  page"_, with a refusal telling readers there was nothing behind the name and to
  spend the time elsewhere. **Every clause of that was false**, and it went out
  under the name of the walker who had measured the opposite.

  **None of the other ten fits.** `approval-required` is a manual review that ends
  in an account; `invite-only` is a door that opens for somebody; `other` is
  honest and carries no instruction. This one is a door shut for everyone,
  deliberately, at a provider that is otherwise up — self-hosted software with
  registration disabled, a service that closed signups under load, an invite-only
  period with no invites left.

  So the sentence says the two things that separate it from `absent`: **the
  service exists** — worth knowing about, and reachable through an account
  somebody already holds — and **the door is shut for everyone, not for you**, so
  an operator is not the way round it. It is the one provider wall expected to
  change, so it names what changes it: a walk that gets an account.

  **No backfill** (`#1062`). A wall filed before this kind existed was filed under
  a vocabulary that did not have it, and reading an old `absent` as this one
  rewrites what that walker said.
