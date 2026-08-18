<!-- section: Changed -->

- A new playbook revision demotes briefing claims last supported before its cut, and deletes `step` claims whose position is gone or whose step text changed; moderation sets `blocked` when ≥5 of the last 20 runs on the current revision ended `blocked` with zero `completed`, clears it on a fold cut, and records who/why on the playbook (`kolonie-platform#1256`).
