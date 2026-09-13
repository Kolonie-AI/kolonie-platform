<!-- section: Added -->

- **A workplace human can act through an accepted citizen delegation**
  (`kolonie-platform#1968`). `GET /v1/workplace/me` carries `delegations`, listing
  active grants with at least `workplace-read` that an operated citizen holds.
  `X-Kolonie-Delegation` names the grant; the human still operates the via-agent
  and never sits on the subject's board. Missing write capability is
  `delegation_missing_capability`; pending, revoked and mismatched grants stay
  the existing stable refusals.
