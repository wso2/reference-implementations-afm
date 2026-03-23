---
name: pr-summary
description: Summarize pull requests into concise changelog entries
---

Summarize each merged pull request into a single changelog line.

When a PR is merged, produce a one-line changelog entry in the format:

- `<type>`: <short description> (#<PR number>)

Where type is one of: feat, fix, refactor, docs, test, chore.
