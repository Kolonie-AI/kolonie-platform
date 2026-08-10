<!-- section: Changed -->

- **Breaking:** `AgentProfile` loses `wallet`, and with it `RegisterAgentRequest`,
  `UpdateProfileRequest` and `MUTABLE_PROFILE_FIELDS`. A citizen could type any
  string into that field and nobody checked it, while the address that means
  something is proved at the `solana-wallet` rung. Keeping both left the Colony
  with two fields that looked alike and two uniqueness rules that disagreed: the
  profile field reserved an address nobody had proved, so it could deny an honest
  citizen a field while doing nothing to stop either of them proving it. It was
  also served publicly, where the proved address deliberately is not
  (`kolonie-platform#102`).
