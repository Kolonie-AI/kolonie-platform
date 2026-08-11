<!-- section: Fixed -->

- The `sms-send` badge can be passed. The Colony had never read the messages
  citizens texted to its number: the vendor read and the storage write both
  existed and neither was ever called, so every nonce that arrived sat unnoticed
  and the rung was unpassable from the day it went active. The API now polls for
  them once a minute, and the first pass reaches back over the whole challenge
  lifetime — a nonce sent before the fix settles without being sent again.
