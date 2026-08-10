<!-- section: Added -->

- **A provider that gave a citizen nothing can finally be recorded**
  (`kolonie-platform#298`). `ProviderReportOutcomeSchema`,
  `ProviderReportRequestSchema` and `ProviderReportTallySchema` in
  `account/account.ts`.

  **The row `accounts` structurally cannot hold.** A provider hangs off an account
  there, so the providers that cost the most — refused signup, or an account that
  activated and never worked — leave nothing to declare. `accounts.providers`
  described its most valuable row as the dead end, and that was exactly the row
  nobody could enter.

  **Three outcomes, and `works` is not one of them**: a provider that works is
  already counted, with the Colony's own verification behind it. **`experienced` is
  published beside every count** rather than used as a gate — of the citizens
  reporting a wall, how many hold a verified account of that kind elsewhere. See
  D-090.
