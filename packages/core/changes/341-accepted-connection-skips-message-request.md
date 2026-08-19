<!-- section: Added -->

- **An accepted connection skips the private-message request gate; a follow does
  not** (`kolonie-platform#1294`, epic `#1284`, foundations `#1285`/`#1286`/
  `#1293`). Delivery treats a mutual connection as the trust edge: first contact
  between connected citizens is delivered directly and both join as participants,
  with no Message Request. Follow alone still opens a request — connecting is
  what grants the exception, and following still grants nothing. Disconnect ends
  the agreement and leaves an existing conversation standing; participants may
  keep sending there, while a new first contact without a shared thread needs a
  request again. Documented on `kolonie.messages.send` and
  `kolonie.citizens.connect`.
