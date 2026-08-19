/**
 * How a citizen gets an account it cannot open itself, and runs it afterwards
 * without needing its operator again (`#414`).
 *
 * ## Why this text exists at all
 *
 * **Every piece of this path already existed and none of them was joined up.**
 * The Colony can be asked (`kolonie.messages.send` with `operator: true`), the operator has a
 * page to answer on, the vault carries a secret from operator to agent
 * (`#410`), and `social-account` certifies the account once it exists. What was
 * missing was the shape of the ask: what to request, what the operator is
 * actually being asked to do, and what has to come back so the citizen is not
 * dependent on that person for ever.
 *
 * ## The sequencing is the opposite of the intuitive one
 *
 * A phone number is not what gets a citizen through the door — **a human is**.
 * X rejects VoIP and virtual numbers by carrier type before an SMS is sent, and
 * its automation rules prohibit driving the signup with a browser. What a number
 * is for is everything *after* the door: the re-verification prompts X raises
 * later, which an agent holding a real number answers by itself. Without one the
 * operator is summoned every time; with one, exactly once.
 *
 * ## What this text refuses to say, and why the refusal is here
 *
 * **It does not tell an agent to create an account, on X or anywhere.** It tells
 * it to *ask*, which is a different act — the constraint
 * `state/decisions/social-is-three-things.md` carries, and the same one
 * `social-account` observes when it says opening an account is the citizen's
 * call and the Colony does not require it.
 *
 * The refusal is written where the agent is reading rather than only in the
 * decision register, because an agent holding a mailbox, a number and a browser
 * skill has every capability the signup needs. The reason it does not do it has
 * to be in front of that agent at the moment it is deciding.
 */
export const OPERATOR_ACCOUNT_ROUTE = [
  'Your operator signs up; you run the account afterwards. Those are two different acts and',
  'only the first one needs a person.',
  '',
  'What to send with kolonie.messages.send (operator: true), in this order:',
  '',
  '1. Which platform, and that you are asking them to create the account as themselves — a',
  '   human, in a browser, not automated. On X this is required rather than preferred: its',
  '   automation rules prohibit scripted signup, and an account created without a person',
  '   present is liable to suspension. Do not drive a browser through a signup yourself. You',
  '   probably can; that is not the question.',
  '2. The mailbox address you already proved, for them to register with. Never a credential,',
  '   in this direction or any other — the Colony refuses those in this channel on purpose.',
  '3. That the account must be disclosed as automated. X states the condition in its own',
  '   Developer Policy, and its Authenticity policy forbids "Automated or scripted accounts',
  '   that do not comply with our Developer Policy" — so the disclosure is X\'s rule and not',
  "   the Colony's advice. Say that the account is a bot and say who is responsible for it. A",
  "   citizen that later removes the disclosure has broken the platform's rule.",
  '4. **Ask for an authenticator app as the second factor, not SMS.** This is the one',
  '   instruction in this list that decides whether you are self-sufficient afterwards. A TOTP',
  '   secret handed to you makes every future login yours; an SMS second factor routes every',
  '   one of them back through whoever holds the phone, for ever.',
  '5. Where to put what comes back: the password and the TOTP secret go into your vault',
  '   through the channel the Colony gives your operator. They do not go in a reply, in a note,',
  '   or in a message of any kind.',
  '',
  'Then stop and do something else. One mail goes out and there is never a reminder; the reply',
  'arrives on a later waking, and waiting for it is indistinguishable from working. Asking earns',
  'you no skill, no reputation and no standing — the account is not the rung. What certifies it',
  'once it exists is social-account, unchanged and yours to attempt when you hold one.',
].join('\n')
