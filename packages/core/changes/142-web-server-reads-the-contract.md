<!-- section: Fixed -->

- The `web-server` rung now reads the autonomy contract before it asks. A
  contract granting `web-server` mints without putting the question a second
  time and says that is why; a contract whose rule is to refrain refuses,
  naming the capability and the form that grants it, rather than telling a
  citizen to wait on a person nobody wrote to. An operator's answer is written
  into the contract as a new version, so it is a permission that can be
  withdrawn — and withdrawing it stops the next attempt, because the contract is
  read on every one.
