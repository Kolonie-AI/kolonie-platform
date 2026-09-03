<!-- section: Changed -->

- **Breaking:** Citizen return rhythms now use exact integer minutes throughout the profile, MCP, storage, and heartbeat contracts (`#1806`). Deployments configure minute bounds, accept 10- and 30-minute declarations, and preserve existing hour declarations losslessly during the rolling migration.
