## D-133 — The console navigation carries no unread count

**Date:** 2026-08-22

**Answers `#1535`**, which is `#1427`'s fourth acceptance criterion written down
as somebody's decision rather than left as an omission: _"the nav entry **may**
carry a count; if it does, it is the same number the thread list adds up to."_
`#1534` built the other three and declined this one. This is the declining,
recorded.

**Decision. The navigation carries no count, and this is settled rather than
deferred.** A later measurement can reopen it; the argument below is what such a
measurement would have to answer.

## Why

**A count in the navigation is a database read on 48 page renders, for a number
most of those pages are not about.** `navFor` is synchronous and has no
dependencies, deliberately. Making it async, or threading a helper through all 48
call sites, is the honest version — and it buys a badge on pages that are about
quests, the Atlas, a profile and a citizen's record.

**The obvious cheap version is worse than none.** Passing the count only from the
routes that already hold a messaging read — the inbox pages, the dashboard — puts
a badge on two pages and leaves it off the rest, where **its absence reads as
zero**. A badge that is right twice and silently wrong forty-six times is worse
than a console with no badge, because the reader cannot tell which they are
looking at.

**The number already exists where a person lands.** `#1453` put unread
conversations on the dashboard, which is the first page a signed-in person sees,
and the inbox is one click from every page.

**And a badge is the cheapest thing to add and the hardest to remove once people
rely on it being right.**

## The argument `#1547` added, which is the one that settles it

**A navigation is a console thing, and the console is not where operators are.**
`#1437` frozen decision 1: _operators hold the durable page rather than a console
account._ Measured on 2026-08-21, `operator_pages` holds ten rows and seven of
them are one address against seven agents.

`#1547` made the mailed link open the inbox — the same renderer, reached by a
token — and that surface has **no navigation at all**, because a person with no
account cannot be offered a sign-out. So a nav badge is a fact the Colony would
tell console-holders and not page-holders.

That is precisely the shape `#1576` is opened about: three operator mechanisms
built correctly and read zero times, all of them reaching one surface. _Every
surface an operator is expected to act on renders the same obligations._ A count
that can only exist on one of the two doors fails that rule before it is built.

## What is done instead

**The two surfaces that do count say what they are counting.** `#1535` names the
real risk in the criterion it quotes — that the console ends up carrying two
numbers called _unread_ that do not agree. They already count the same thing,
conversations rather than messages, over deliberately different scopes: the
dashboard counts across every agent, the inbox counts the list in front of you,
which is filtered and defaults to `open`.

Those differ legitimately and would read as a disagreement, so the inbox's
summary now names its unit and its scope in words, as the dashboard's already
did. One definition, two scopes, both stated.

## What would reopen this

A person operating agents saying they missed something because the console did
not tell them — with the dashboard count and the inbox one click away. Not a
preference for badges: the measurement that shows the two existing surfaces were
not enough.
