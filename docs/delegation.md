# Delegation bookkeeping

`extensions/delegates/index.js` runs bounded children through the `Agent` tool. This note describes what a parent can rely on
in the records of a child, and what those records do not establish.

These rules prevent three problems that occur in practice:

- A delegate without research tools gets a literature task, and it cannot do the task.
- The final narrative of a child understates or overstates what the child did, for example "work completed: none" after two successful searches.
- A parent reads the full result of a child again and again only to know its status.

## Required tools

`Agent` accepts `required_tools`, a list of tool names. Mina compares the list with the child's selected tools: the role's
declared tools, filtered by what the sandbox and the parent session provide. The child's selected tools never grow to meet it.
A missing tool refuses the launch before the transcript, the `Agent`, or any provider request exists. The refusal does not count
against the 64-start allowance. The error names the missing tools and the child's actual tools. It distinguishes a tool the role does not declare
from a declared tool this session lacks. For research tools, it points to `subagent_type: "researcher"`.

Mina does not infer requirements from the prompt. A literature task needs a `researcher` child or an explicit `required_tools`.
Launch and finished receipts carry `tools` (actual) and `requiredTools`.

`supplement_get` joins the research tools a child may inherit. Only the parent's registered tool of that name is passed on, and
only when the role declares it.

## Receipts and outcome

Each child record carries `receipts`, which are counted from the structured result of every finished tool call:

- `calls` and `errors` in total, and per tool `calls` plus a count per outcome.
- Outcomes come from `details.status` (`ok`, `partial` for `ok_partial_text`, `unavailable` for `FULLTEXT_UNAVAILABLE`,
  `unsupported`, `not_found`, `empty`, `invalid`, `ambiguous`, `expired`, otherwise `other`). They also come from a numeric HTTP status
  with `truncated` (`web_fetch`), and from `research_search`'s per-backend calls. A result without a status falls back to
  `details.outcome`, as `literature_db` reports it (`ok`, `empty`, `not_found`). `empty` and `not_found` are counted as such; neither
  says anything about the task. A thrown or flagged tool failure is `error`. Only own fields count: a status such as
  `"constructor"` or `"__proto__"` is `other`.
- Tool names are whatever the child's model called, including tools it was never given (those calls are errors). Each name
  gets its own entry, `__proto__` and `constructor` included. A name in the receipts is not a grant: `tools` lists only the
  granted tools. The published `receipts.tools` table has no prototype, so no name in it reaches an inherited property.
- Per tool: `items` (returned results, passages or sections), and `zero_items` for a successful call that returned nothing. This is not a failure.
  `backend_failures` counts backends that failed inside an otherwise successful search, and `temporary` counts temporary unavailability.
  For paper tools, `missing_paper` and `missing_section` separate the two kinds of `not_found`.
- `error_samples`: the last five error messages, at most 200 characters each, with terminal controls removed.
- `unfinished`: tool calls that started but did not report an end, for example after an abort.

Receipts never read result text, output files or controller paths. Tools without a structured status (`read`, `bash`, …) count
only calls and errors.

`outcome` is `{ lifecycle, task: "unknown", evidence: "unknown" }`. `lifecycle` repeats `status`. `completed` means
that the child process stopped without an error, not that the assignment was done. Mina has no structured completion report
from children. It does not derive task or evidence completion from the final narrative or from successful calls. The
parent judges completion from the receipts, the report and its own checks. The narrative stays verbatim in `result`.

## Tasks and supersession

`task_id` names a task (1–64 of `A-Z a-z 0-9 . _ : -`, default: the child id). A new child with the same `task_id` is a further
attempt of that task. It is refused while an earlier attempt still runs, and while another launch of the task is still starting.
The task id is reserved synchronously, before the role definition loads, so two simultaneous launches cannot both start. A resume
is refused on the same terms. `supersedes` lists task or child ids on the current branch that this child replaces. Refused before
any reservation or request: unknown ids, a task superseding itself, and a direct or indirect cycle (B supersedes A, then A
supersedes B; or A→C→B→A). A plain retry of A without `supersedes` stays valid. A resumed child keeps its task and cannot
supersede.

A launch refused before its child record exists returns its admission, so it does not count against the 64-start allowance.
This covers an unknown role, an unreadable definition, an unknown model, an invalid `max_turns` and a missing required tool,
and in each case no provider request is made. It also frees its task id.

`get_subagent_result({ task_id })` returns the task's `attempts`, which are the last 20, with status and error. It also returns `supersedes`, `supersededBy`
and a summary of the latest attempt without result text. Superseding does not change an earlier record: a failed attempt stays failed, and
a completed one is not marked done.

The task state is rebuilt from the current branch on every read, from `Agent` tool-result details (launch receipts) and
`subagents:record` entries. An abandoned branch contributes nothing. A child launched in the current turn, whose result is
not on the branch yet, counts when the entry it was launched from is on the branch. A child of an earlier runtime is
readable from its branch record (`historical: true`). It cannot be resumed, steered or waited on. This includes a reload in the
same process with the same instance id: the earlier runtime's children stay in memory but are historical.

Branch authority: `supersedes`, `resume` and the `steer_subagent` tool accept only children launched on the current branch.
A child of this runtime launched on another branch (before a `/tree` switch) can still be read by `agent_id` for diagnostics,
marked `historical: true, off_branch: true`. It cannot be waited on, resumed, steered by the model or superseded from here.
Another runtime's in-memory child is shown only when the current branch launched it. The child viewer is a person acting, not
the model: it may still steer or stop any running child of this runtime.

Compatibility: an embedding whose `ctx.sessionManager` lacks `getBranch` or `getLeafId` has no branch to consult. There,
every child of this runtime counts as on the branch, and children of earlier runtimes never do.

## Reading results

`get_subagent_result({ agent_id })` still returns the full record with `result`, now with `resultChars` and `revision`.
`revision` increases when a run starts, when each tool call starts and ends (`toolUses`, `receipts` and `unfinished` change), and when the run
finishes. `resultRevision` is the revision at which the result text last changed.

- `summary_only: true`: everything except the result text: status, error, receipts, outcome, revision and `resultChars`.
  Use it for status checks. Completion still arrives as a notification; do not poll.
- `since_revision: N`: if the record is still at revision N, a short reply `{ id, status, revision, resultChars, unchanged: true }`.
- `offset` / `max_chars`: one page of the result with `resultOffset`, `resultChars` and `nextOffset` (`null` at the end).
  Offsets count UTF-16 code units. A page never starts or ends inside a surrogate pair, so a one-character page at an astral
  character returns two code units. An offset between the two halves of a pair fails, and the error names the offset before it.
  Pass `revision` from the first page. The read fails instead of mixing pages if the result text changed since that revision,
  for example when a resumed run finishes. Tool progress alone does not invalidate pages. An offset past the end fails.
  Nothing is cut silently.
- `wait: true` waits for a live child in every mode. It has no effect on a historical record.

## Limits

- The task view sees only this branch's launch results and records. A launch whose result lands on another branch after `/tree`
  is not merged.
- Old records, written before these fields existed, have no `revision`, `receipts` or `taskId`. They read as before, and
  `since_revision` never reports them unchanged.
- Receipts depend on each tool's structured `details`. A wrapper that drops `details` leaves only call and error counts.
  An unfamiliar status counts as `other`.
- Mina does not detect when a parent's own artifact has stale tasks or duplicate numbering.
  Supersession records the parent's explicit decision only.
