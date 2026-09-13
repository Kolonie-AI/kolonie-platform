<!-- section: Changed -->

- Doctor `narrow-the-request` findings for `kolonie.accounts.list` now carry a typed next action with the same tool, `limit: 1`, and the `nextCursor` to `cursor` continuation mapping (`kolonie-platform#1950`). Routes whose supported bounds are unknown retain `nextAction: null` and generic guidance rather than guessed arguments.
