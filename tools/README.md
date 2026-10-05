# Helper tools: scope and limitations

`validate_handoff.py` checks files, exact 1/3/6 roster, Astra authority, hands-on Sol work, task dependencies, acceptance/deliverable coverage and gate staging. It never builds or plays the game.

`check_owner_ready.py` checks an actual completed-game QA manifest against the required IDs, candidate identity, artifact hashes, independent reviews, two clean core runs and serious-defect policy. Populate only from real executed tests. It is not a test runner, cannot prove reports are truthful and does not grant human/portal approval. The empty template is intentionally rejected.

`preview_build.mjs` is a Node-built-in static server, bound to loopback, with MIME/range support and basic path restrictions. It needs a completed build directory with index.html. It does not contain a game or install dependencies. Browser auto-opening has platform-specific branches; macOS/Windows launch and actual rendering must be tested by the implementation team. No claim of those OS tests is made by the Linux HTTP-fixture tests.

Run the local helper tests with:

```sh
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Tests create only temporary synthetic checker/server fixtures. They are explicitly not game QA, game benchmarks, agent-session evidence or portal approvals. A positive synthetic test shows that the checker accepts internally consistent data; it does not turn the synthetic content into a real game.

The final playable delivery must integrate these tools or reviewed equivalents and exercise them against the real game. Do not mistake a passed helper suite for completed game acceptance.
