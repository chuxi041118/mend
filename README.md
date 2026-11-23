# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chuxi041118/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chuxi041118/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an AI-written edit to a tree of text files, whether the model wrote it as a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON. It matches lines at three tiers (exact, trailing whitespace, indentation), handles CRLF files and files without a final line break, and applies every edit or nothing at all.

## Run it

```sh
node main.ts patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=3s33c3ks&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
