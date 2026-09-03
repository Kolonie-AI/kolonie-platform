<!-- section: Added -->

- **Portable guest vault handoffs keep one separately sealed copy for one bounded disclosure** (`#1815`). The bearer capability is stored only as a hash; optional passphrases use slow hashing with bounded attempts; and disclosure, revocation, expiry, and erasure destroy the copy while retaining only non-secret lifecycle metadata. The original vault row remains untouched.
