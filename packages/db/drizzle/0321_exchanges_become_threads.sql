CREATE TABLE "operator_request_conversations" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_request_conversations" ADD CONSTRAINT "operator_request_conversations_request_id_operator_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_request_conversations" ADD CONSTRAINT "operator_request_conversations_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every exchange becomes a thread (`#1324`, epic `#1318`).
--
-- `#1325` drops `operator_requests` and `operator_request_messages`. Dropping
-- them with in-flight asks still in them would lose human context that the
-- citizen and the operator are both mid-conversation about, so the words move
-- first and the drop is a pure drop.
--
-- ## All of them, not the open ones
--
-- Rule 4 of the issue offers open-only and prefers **(a) migrate all**, and (a)
-- is what this does. Migrating the open ones would leave slice G choosing
-- between deleting the closed history and keeping a table alive to hold it, and
-- both of those are worse than the cost of moving rows nobody is waiting on: the
-- measured corpus is small, and a closed exchange is exactly the thing a citizen
-- re-reads when the same provider comes round again.
--
-- ## What cannot move, and why it is a skip rather than a failure
--
-- A messaging thread needs an `operator-human` participant, which needs a
-- `human_id` — and an exchange needs only an operator **page**, which is an
-- address. So an exchange belonging to a citizen with no `human_agents` row has
-- no person to put in the conversation. There is no honest row to invent: a
-- participant with a made-up human is a thread somebody would later be shown as
-- theirs.
--
-- Those are left where they are and counted in the pull request. `#1325` is what
-- decides their fate, with the number in front of whoever decides it — which is
-- the point of doing this first.
--
-- ## Idempotent
--
-- Every insert is guarded by `operator_request_conversations`, which is written
-- in the same statement that creates the conversation. A second run finds every
-- request already mapped and inserts nothing. The map is transient and `#1325`
-- drops it.

-- 1. One conversation per exchange, carrying the exchange's provenance.
--
-- **The id is chosen here rather than returned.** `insert ... returning` cannot
-- hand back a column the target table does not have, so pairing the new rows to
-- the requests they came from afterwards would mean matching on
-- `(created_at, task_id, wish_id)` — which two exchanges opened in the same
-- transaction about the same wish would share. Generating the uuid in the CTE
-- makes the pairing an identity rather than a guess.
with migratable as (
    select r.id as request_id,
           gen_random_uuid() as conversation_id,
           r.task_id,
           r.wish_id,
           r.opened_at
      from operator_requests r
      join human_agents ha on ha.agent_id = r.agent_id
     where not exists (
             select 1 from operator_request_conversations m where m.request_id = r.id
           )
), created as (
    insert into message_conversations (id, task_id, wish_id, created_at)
    select conversation_id, task_id, wish_id, opened_at from migratable
    returning id
)
insert into operator_request_conversations (request_id, conversation_id)
select request_id, conversation_id from migratable;
--> statement-breakpoint

-- 2. The citizen's side, labelled with the handle a reader would recognise.
insert into message_participants (conversation_id, party, agent_id, label, joined_at)
select m.conversation_id, 'citizen', r.agent_id, a.name, r.opened_at
  from operator_request_conversations m
  join operator_requests r on r.id = m.request_id
  join agents a on a.id = r.agent_id
 where not exists (
         select 1 from message_participants p
          where p.conversation_id = m.conversation_id and p.party = 'citizen'
       );
--> statement-breakpoint

-- 3. The operator's side. `human_agents` is the Colony's own record of who
--    answers for this citizen, and the label is the one every other operator
--    thread carries.
insert into message_participants (conversation_id, party, human_id, label, joined_at)
select m.conversation_id, 'operator-human', ha.human_id, 'your operator', r.opened_at
  from operator_request_conversations m
  join operator_requests r on r.id = m.request_id
  join human_agents ha on ha.agent_id = r.agent_id
 where not exists (
         select 1 from message_participants p
          where p.conversation_id = m.conversation_id and p.party = 'operator-human'
       );
--> statement-breakpoint

-- 4. The words, in the order they were written, attributed to the side that
--    wrote them. `answer_kind` rides along: it is what a person declared, and
--    `messages_answer_kind_party` already refuses one on any other party — which
--    is why the join to the operator participant is what carries it.
insert into messages (
    conversation_id, sender_participant_id, sender_party, sender_label, body,
    answer_kind, created_at
)
select m.conversation_id,
       p.id,
       p.party,
       p.label,
       om.body,
       om.answer_kind,
       om.written_at
  from operator_request_messages om
  join operator_request_conversations m on m.request_id = om.request_id
  join message_participants p
    on p.conversation_id = m.conversation_id
   and p.party = (case om.author when 'operator' then 'operator-human' else 'citizen' end)::message_party
 where not exists (
         select 1 from messages existing
          where existing.conversation_id = m.conversation_id
            and existing.sender_participant_id = p.id
            and existing.body = om.body
            and existing.created_at = om.written_at
       );
--> statement-breakpoint

-- 5. The Telegram binding follows the words (`#1321`). An operator who was
--    pinged about an exchange and replies in the chat must land in the thread
--    that exchange became; without this the reply resolves to a table `#1325` is
--    about to drop.
insert into message_telegram_asks (conversation_id, chat_id, message_id, sent_at)
select m.conversation_id, a.chat_id, a.message_id, a.sent_at
  from operator_telegram_asks a
  join operator_request_conversations m on m.request_id = a.request_id
 where not exists (
         select 1 from message_telegram_asks existing
          where existing.conversation_id = m.conversation_id
       )
   and not exists (
         select 1 from message_telegram_asks clash
          where clash.chat_id = a.chat_id and clash.message_id = a.message_id
       );
