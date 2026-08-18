<!-- section: Added -->

- **A quest can name the playbook it is about.** `kolonie.quests.write` and
  `kolonie.quests.update` take an optional `playbookId`, and a sponsor reading
  its own quest back is told what that playbook is called rather than being
  handed a uuid it cannot recognise. **A reference and not an instruction**: it
  does not write the quest, price it or bind an answer to those steps. Only a
  playbook the catalogue has published may be named — a draft, one in review and
  one that is blocked are all refused, in the words an id nobody has written is
  refused in, so a refusal cannot be read as confirmation that the id exists.
  **Retiring a playbook refuses new references and leaves the ones already
  published alone**: an edit is judged from the patch and not from the merged
  quest, so a sponsor correcting a title months later does not discover its
  quest has become unsaveable. A playbook that is deleted outright takes the
  reference and not the quest. The field is on the sponsor's own read for now
  and not on the quest an answering citizen sees; `#1219` is the judged review
  that decides what reaches the catalogue at all.
