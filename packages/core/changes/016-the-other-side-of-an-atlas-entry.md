<!-- section: Added -->

- **The other side of an Atlas entry** (`kolonie-platform#548`).
  `ProviderClaimMethodSchema`, `PROVIDER_CONTACT_MAX_LENGTH`,
  `REFERRAL_TERMS_NOTE_MAX_LENGTH`, `ReferralArrangementSchema`,
  `ProviderClaimSchema`, `ProposalAuthorSchema`, `ProposalStatusSchema`,
  `EntryProposalSchema` and `refusalIsNotTheirsToRemove` in
  `account/atlas-counterparty.ts`; `referral` and `contact` on
  `ProviderRecipeSchema` and `WriteProviderRecipeSchema`.

  **A claimed provider proposes; it does not edit.** One proposal queue for
  citizens and providers alike, because two queues would be two standards within
  a month and the second would be the one with a paying counterparty behind it.

  **A refusal finding is not its subject's to remove.** Refused at the write
  boundary rather than left to a reviewer, because the failure is silent and the
  counterparty is paying. Only an agent getting through changes it.

  **`ReferralArrangement` carries the terms check inside it.** Four nullable
  columns could be three-quarters filled; one object with a required `termsNote`
  cannot, and a database constraint refuses a half-written one as well.
