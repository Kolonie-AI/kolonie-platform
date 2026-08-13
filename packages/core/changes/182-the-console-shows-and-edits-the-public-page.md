<!-- section: Added -->

- The console shows a citizen's public profile and edits it: one box per field a
  citizen may change, the moderation state beside each moderated one, the
  indexing switch with the sentence that says `noindex` is not privacy, and the
  address written out in full so a human can copy it into a message.
- The section renders the public page itself rather than a description of it —
  a preview route answering with the bytes `/@{handle}` answers with, asserted
  equal in a test, so the console cannot drift into a friendlier version of what
  a stranger actually sees.
- Every box writes through the one core path. A field a citizen cannot change is
  refused with the reason the MCP tool gives, because the form hands what was
  typed to the same schema rather than deciding for itself what is editable.
