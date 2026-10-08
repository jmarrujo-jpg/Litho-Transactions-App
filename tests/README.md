# Tests

Run from the repo root (Node 22):

    node tests/worker_test.mjs   # worker.js against an in-memory fake Google Sheets, with injected failures
    node tests/ui_test.mjs       # Index.HTML in headless Chromium with the Worker mocked (needs Playwright)

`worker_test` covers the retry/resume behaviour (a save that fails part-way and is retried must not
double-apply or skip work), the write lock (simultaneous saves get distinct Skid IDs), and the Sheets
retry rules. `ui_test` covers escaping, the app's retry/timeout rules, Create Job, resumed-job
operator, the WIP litho cost check, the count refresh, what tablets vs computers show, and the
work-session Back question (Save / Delete / Keep working) with the scan-first skid finder.
