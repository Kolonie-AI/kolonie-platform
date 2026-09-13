<!-- section: Added -->

- **A default Workplace board can retire its starter pack**
  (`kolonie-platform#1946`, parent `#1938`). `WorkplaceBoardSchema` carries a
  nullable `starterRetiredAt`, `WorkplaceRetireStarterRequestSchema` is
  deliberately empty, and `WorkplaceRetireStarterResponseSchema` reports which
  cards were archived and how many recurrence rules stopped — so onboarding copy
  stops competing with a citizen's own work without deleting the history of it.
