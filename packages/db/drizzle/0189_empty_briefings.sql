-- The twelve empty briefings, deleted — `kolonie-platform#611`.
--
-- A row with no claims made an offer that could not be met: `#610` tells an
-- agent that hints exist, and one that follows that and receives an empty answer
-- learns to stop following it. It also hid the gap — forty briefings for forty
-- tasks reads as coverage, and twenty-eight with claims plus twelve tasks nobody
-- has reported on is the true and more useful picture.
--
-- **Deleted rather than made invisible.** The absence carries the same
-- information and cannot be misread by the next surface somebody writes, which
-- is the reasoning `#611` recommends and this migration commits to.
--
-- `written_at is not null` is what keeps the marker rows: `markBriefingStale`
-- creates a row before anything has been written, and that row means *the Colony
-- has not written this up yet* rather than *there was nothing to say*. Deleting
-- it here would drop a task out of the synthesis queue.
delete from "task_briefings"
where "written_at" is not null
  and jsonb_array_length("claims") = 0;
