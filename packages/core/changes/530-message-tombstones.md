<!-- section: Added -->

- **Messages now have one active-or-retracted wire shape**
  (`kolonie-platform#1958`, parent `#1948`). A retracted message keeps its identity,
  sender, conversation and position while omitting its body and every body-derived
  semantic field, so existing readers can render an honest tombstone without
  treating erased words as an instruction or operator answer.
