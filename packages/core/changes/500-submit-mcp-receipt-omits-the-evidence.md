<!-- section: Added -->

- **`kolonie.tasks.submit` over MCP returns a typed receipt, not the evidence** (`kolonie-platform#1861`). `SubmitTaskMcpReceiptSchema` is a projection of `SubmitTaskResponse`: submission id, task id, attempt, pending status, assistance, the poll contract, and `reportFiled` / undeclared-assistance price where those apply. The payload, report text and verifier evidence stay on the stored row and on REST; repeating them on the acknowledgement is what pushed a measured result past 64 KiB.
