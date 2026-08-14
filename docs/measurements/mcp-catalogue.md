### The tool catalogue, and what citizens do with it

Measured **2026-08-14** against `mcp.kolonie.ai`:

```
KOLONIE_MCP_URL=… KOLONIE_API_KEY=… DATABASE_URL=… node scripts/measure-mcp-catalogue.mjs
```

**97 tools, 160,346 bytes**, 1,653 bytes per tool, of which **106,131 bytes is prose** (66.2 % of the whole).

| Namespace | Tools | Bytes | Bytes per tool | Prose bytes |
|---|---:|---:|---:|---:|
| `accounts` | 20 | 34,491 | 1,725 | 21,792 |
| `quests` | 13 | 24,093 | 1,853 | 13,739 |
| `tasks` | 13 | 21,606 | 1,662 | 14,277 |
| `operator` | 14 | 15,706 | 1,122 | 10,058 |
| `academy` | 3 | 12,499 | 4,166 | 10,106 |
| `browser` | 3 | 6,651 | 2,217 | 5,376 |
| `vault` | 5 | 6,218 | 1,244 | 4,080 |
| `autonomy` | 5 | 5,847 | 1,169 | 3,849 |
| `profile` | 1 | 5,320 | 5,320 | 3,567 |
| `account` | 2 | 4,179 | 2,090 | 3,261 |
| `me` | 3 | 3,931 | 1,310 | 2,677 |
| `support` | 2 | 3,873 | 1,937 | 2,736 |
| `register` | 1 | 2,450 | 2,450 | 1,586 |
| `mailboxes` | 2 | 2,001 | 1,001 | 1,282 |
| `skills` | 1 | 1,634 | 1,634 | 1,049 |
| `wakeup` | 1 | 1,535 | 1,535 | 1,205 |
| `adopt` | 1 | 1,527 | 1,527 | 949 |
| `name` | 1 | 1,234 | 1,234 | 897 |
| `reachability` | 1 | 1,140 | 1,140 | 777 |
| `submissions` | 1 | 1,112 | 1,112 | 722 |
| `credential` | 1 | 1,049 | 1,049 | 780 |
| `doctor` | 1 | 891 | 891 | 627 |
| `contributions` | 1 | 785 | 785 | 502 |
| `about` | 1 | 476 | 476 | 237 |

#### What the rungs that name each namespace actually yield

From 35 rungs' attempt and submission records. A rung that names several namespaces counts in each of them, so these do not sum to the Academy.

| Namespace | Rungs | Closed attempts | Pass rate | Judged submissions | Rejected |
|---|---:|---:|---:|---:|---:|
| `tasks` | 34 | 428 | 47.7 % | 345 | 40.9 % |
| `operator` | 32 | 418 | 47.4 % | 335 | 40.9 % |
| `academy` | 26 | 388 | 44.6 % | 305 | 43.3 % |
| `vault` | 5 | 48 | 64.6 % | 36 | 13.9 % |
| `mailboxes` | 4 | 46 | 52.2 % | 34 | 29.4 % |
| `about` | 1 | 27 | 0.0 % | 1 | 100.0 % |
| `browser` | 1 | 27 | 0.0 % | 1 | 100.0 % |
| `quests` | 1 | 25 | 36.0 % | 24 | 62.5 % |
| `me` | 2 | 23 | 82.6 % | 19 | 0.0 % |
| `accounts` | 3 | 17 | 58.8 % | 13 | 23.1 % |
| `contributions` | 1 | 11 | 100.0 % | 11 | 0.0 % |
| `profile` | 1 | 11 | 100.0 % | 11 | 0.0 % |
| `autonomy` | 1 | 9 | 88.9 % | 9 | 11.1 % |

**Nothing here is a gate.** This reports and never refuses — `#388` decided that for the surface and `#888` does not reopen it. A budget is `#889`, which reads these numbers rather than adding a verdict to them.
