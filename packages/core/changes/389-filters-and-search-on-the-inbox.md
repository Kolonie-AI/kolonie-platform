<!-- section: Added -->

- **Sent is a filter, not a folder.** A sent-folder is an artefact of mail
  having no threads: when a reply is a new object with no parent, a separate
  pile is the only way to find what you wrote. Here every message already sits
  in the conversation it belongs to, so _did I ever answer that_ is a predicate
  over the same list — `?sent=1` — and the person stays in the thread they were
  reading.

- **Four filters on `/inbox`, combinable, as query parameters.** Unread only,
  by agent, by account, and written-in-by-me. Each is one `and` over the list
  `#1448` already builds, so any combination of them is one query rather than
  four ways of listing. They live in the query string so a filtered inbox is a
  link somebody can keep, paste or come back to — and they survive the view
  switch and every archive and mute button, because a filter that survived
  reading but not acting would be the worse half.

- **Search, over message body, agent name and thread subject**, case-insensitive
  and matching substrings. Every message rather than the latest: somebody
  looking for what was said a fortnight ago would otherwise be told it is not
  there. `%` and `_` are escaped rather than refused — a search box that rejects
  punctuation is one people stop using.

- **No index, deliberately.** Plain `ILIKE` over 243 messages. When a sequential
  scan is measurably slow, that measurement is the issue which adds an index,
  and it will be a better index for having a real query pattern behind it.

- **Nothing here reaches a thread this person is not in.** Every filter and the
  search start from the person's own participant rows, which is the same ACL the
  listing has. A search that could surface a message from a conversation the
  person is not in would be surveillance arriving through the back door; a test
  runs all seven shapes of input against a stranger's thread and asserts each
  answers empty.
