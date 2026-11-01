---
name: conductor-setup
description: Set up and use the Conductor plugin's boards. Use when the user asks to start a Conductor board, make a thread an orchestrator, change a board's rules or options, or move data from the Phase Board plugin.
---

# Setting up Conductor

A Conductor board follows one orchestrator thread. Every child thread of that
orchestrator whose title holds a ticket key (or that the Linear plugin binds to
an issue) is a ticket; the child threads of a ticket thread are its
implementers. Other children show under "Other work".

## Start a board

- In bb: open a thread's menu and choose **Use as a Conductor board**, or open
  **Conductor** in the left rail and pick a thread or start a new orchestrator.
- From a shell: `bb conductor board create --thread <thread id> [--name …]`.
- `bb conductor board list` shows boards; `bb conductor board remove <id>`
  removes one (threads are untouched).

## Options and rules

Change them on the board's **Settings** page, or with
`bb conductor board set <id> …`:

- `--ticket-pattern`: regex for ticket keys in thread titles (default
  `[A-Z][A-Z0-9]+-\d+`).
- `--milestone-pattern` and `--milestone-label`: read a milestone from the base
  branch, for example `^m(\d+)-` with label `M$1`. Empty turns milestones off.
- `--plans-dir`: a folder of `<date>-<key>-<slug>.md` plan files on the bb
  server; lets the board see a plan waiting for review.
- `--github-owner`: builds PR links when agents report `repo#123`.
- `--user-name`: how agents refer to you.
- `--on` / `--off` with rule ids: `askDecisions`, `reportStages`, `planRounds`,
  `onePrAtATime`, `splitPrs`, `oneAgentPerTicket`, `codeReviewRounds`.
- `--extra-rules` (or `--extra-rules-stdin`): your own text for every ticket
  agent on the board.

Agents get rule changes when their next session starts.

## Plan review

Agents send plans with `conductor_submit_plan`; with a plans folder set, a
waiting `<date>-<key>-<slug>.md` plan opens a round on its own. Open a plan
from Waiting on you, the ticket card or the ticket page, select text to
comment on it, remove it or replace it, and approve or request changes. The
marks go to the agent as one message; every round keeps its copy of the plan,
with a diff against the round before.

## Optional plugins

- **Linear**: issue titles, state, description and relations.
- **Code Review Workspace** (1.10 or newer; older counts as missing): reviews
  of each ticket's folder and threads waiting on you, and **Review changes**
  on the ticket page.
- **GitHub PR Status** (bundled): the PR of each ticket's branch.

Without them the board still works from thread titles and agent reports.

## Moving from Phase Board

With both plugins installed, run `bb conductor import-phase-board` once. It
creates a board from Phase Board's settings with every rule switch on and
copies tickets, decisions and history. Then remove Phase Board.
