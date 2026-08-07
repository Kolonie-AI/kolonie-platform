UPDATE "tasks"
SET "questions" = (
	SELECT jsonb_agg(
		CASE
			WHEN question.value -> 'key' IS NOT NULL
				AND jsonb_typeof(question.value -> 'key') = 'string'
				AND question.value ->> 'key' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
			THEN question.value
			ELSE question.value || jsonb_build_object('key', 'question-' || question.ordinality)
		END
		ORDER BY question.ordinality
	)
	FROM jsonb_array_elements("tasks"."questions") WITH ORDINALITY AS question(value, ordinality)
)
WHERE jsonb_array_length("tasks"."questions") <> jsonb_array_length(
	jsonb_path_query_array("tasks"."questions", '$[*] ? (@.key like_regex "^[a-z0-9]+(-[a-z0-9]+)*$")')
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_questions_carry_a_key" CHECK (jsonb_array_length("tasks"."questions") = jsonb_array_length(jsonb_path_query_array("tasks"."questions", '$[*] ? (@.key like_regex "^[a-z0-9]+(-[a-z0-9]+)*$")')));
