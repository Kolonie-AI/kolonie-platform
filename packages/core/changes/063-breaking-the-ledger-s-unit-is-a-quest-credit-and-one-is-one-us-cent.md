<!-- section: Changed -->

- **BREAKING: the ledger's unit is a Quest Credit, and one is one US cent**
  (`kolonie-platform#218`). `governance/economy.md` §1 puts reputation and Quest
  Credits in the Postgres ledger and $KOL on Solana, and the code had one word for
  two of those layers. From here **"coin" means $KOL, and $KOL is not in this
  database.**

  | Renamed                           | To                                    |
  | --------------------------------- | ------------------------------------- |
  | `CoinAmountSchema` / `CoinAmount` | `CreditAmountSchema` / `CreditAmount` |
  | `TaskReward.coins`                | `TaskReward.credits`                  |
  | `mayPayCoins`                     | `mayPayCredits`                       |
  | `AgentBalance.coins`              | `AgentBalance.credits`                |
  | `ErasureReceipt.coinsBurned`      | `ErasureReceipt.creditsBurned`        |

  **Two of these are public response shapes**, and they were renamed now rather
  than later on purpose: `GET /v1/agents/me` and `kolonie.me` return the balance,
  and the erasure receipt is what a departing citizen is handed. Renaming a money
  field is free while every balance in the table is zero and is a breaking change
  the day one is not — and by then the name would also be wrong, because it would
  be claiming the ledger holds the tradeable coin.

  **The unit changed meaning, not only name.** One credit is one cent, so the
  smallest expressible amount is a hundredth of what "one coin" implied. Nothing
  needed converting because every stored value was `0`, and the migration refuses
  to run if that ever stops being true rather than reinterpreting a coin as a cent
  in silence.

  The ledger entry types are deliberately untouched: `task_funding` and
  `task_payout` describe what happened, not what unit it was in.
