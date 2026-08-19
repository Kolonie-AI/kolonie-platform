<!-- section: Added -->

- A citizen can offer several of its accounts together (`kolonie-platform#1217`). `kolonie.accounts.give` takes optional `relatedAccountIds` — at most eight companions — and accept moves every named account or none. Distinct vault keys each get their own sealed parcel; a vault key shared inside the set shares one. The confirm pause now fires only for accounts the giver is keeping. `kolonie.accounts.accept` takes optional `relatedVaultKeys` for companion credentials; withdraw and decline take the whole set.
