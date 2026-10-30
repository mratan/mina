# The host profile

The sandbox stops the agent from doing harm on the host. It also stops some legitimate engineering work:

- The agent cannot see the lock files that host runners use, because its `/tmp` is private.
- The agent cannot reach your systemd user manager, because its runtime folder is private.
- The agent has no monitor that continues after its session ends.

Without help, the agent must give this work to you. Or it makes a private lock that no host runner can see, which gives no protection.
The host profile adds one narrow, audited route out of the sandbox. The sandbox stays on and does not change for the agent's own commands.

- [The parts](#the-parts)
- [Install and register a project](#install-and-register-a-project)
- [Defaults for unregistered projects](#defaults-for-unregistered-projects)
- [Operations and approval](#operations-and-approval)
- [Admission budgets](#admission-budgets)
- [Capability preflight](#capability-preflight)
- [Retained workload output](#retained-workload-output)
- [Pushing](#pushing)
- [Resource coordination](#resource-coordination)
- [Containment](#containment)
- [Parameterized workloads](#parameterized-workloads)
- [Deployment verification](#deployment-verification)
- [Monitoring and alarms](#monitoring-and-alarms)
- [Who can call the broker](#who-can-call-the-broker)
- [Tests](#tests)
- [Limits](#limits)

## The parts

| Part | Where | What it does |
|---|---|---|
| Host broker | `host/hostd.py`, user service `mina-hostd` | Runs outside every sandbox. It does a fixed list of operations on what you registered, and it logs each one. No model takes part. |
| Registry | `~/.config/mina/host.json` | The resources of the machine, and for each project its services, resources, workloads, monitor paths, and the approval level of each operation class. Optional defaults apply to unregistered projects in folders that you name. The agent cannot write it. |
| Workload holder | `host/lockrun.py` | The main process of each workload unit. It takes the locks (it can wait for them), examines the resources again, runs the command, and records the result. |
| Launcher session | `bin/mina.mjs` | Opens a host session when the broker runs and the project is registered. It binds the broker socket folder and a grant file for this launch into the outer sandbox layer. |
| Mina client | `extensions/host/` | The `mina_host` tool, the capability list in the system prompt and in `.mina/host-capabilities.json`, and alarm delivery. |

## Install and register a project

1. Install and start the broker:

   ```bash
   python3 <mina>/host/hostd.py install
   ```

   This command writes `~/.config/systemd/user/mina-hostd.service` and starts the service.

2. Find the GPUs and the lock files of the machine:

   ```bash
   mina host discover
   ```

   The command shows each GPU with its bus ID and the resource that covers it.
   It also shows the lock files of the policy with their holders, and the lockouts.
   For each GPU that no resource covers, it prints a suggested change list. It does not change a file.

3. Write the resources of the machine at the top level of `~/.config/mina/host.json`.
   A resource is a set of lock files that your host runners use, plus the conditions for its use.
   All projects on this machine use these resources.
   The normal procedure is a change list that you apply with `mina host apply` (see [change the host policy](#change-the-host-policy)):

   ```bash
   mina host apply resources.json --dry-run    # shows the diff and the risk flags only
   mina host apply resources.json              # writes the change after you confirm
   ```

   A change list for one resource:

   ```json
   [{"kind": "resource_set", "scope": "machine", "name": "GPU_A",
     "resource": {"locks": [{"path": "/tmp/gpu-locks/GPU_A.lock", "turnstile": "/tmp/gpu-locks/GPU_A.turn"}],
                  "device": {"nvidia": ["00000000:01:00.0"]}}}]
   ```

   As an alternative, `mina host edit` opens a copy of the file in `$VISUAL` or `$EDITOR`. You can also edit the file directly and then run `mina host validate`.
   The example that follows shows the resources in the file: two GPU groups, a host-quiet lock for timed measurements, and a `BUILD` resource:

   ```json
   {
    "version": 1,
    "resources": {
     "GPU_A": {"locks": [{"path": "/tmp/gpu-locks/GPU_A.lock", "turnstile": "/tmp/gpu-locks/GPU_A.turn"}],
               "device": {"nvidia": ["00000000:01:00.0"]}},
     "GPU_B": {"locks": [{"path": "/tmp/gpu-locks/GPU_B.lock", "turnstile": "/tmp/gpu-locks/GPU_B.turn"}],
               "device": {"nvidia": ["00000000:02:00.0"]}},
     "QUIET": {"locks": [{"path": "/tmp/gpu-locks/HOST_QUIET.lock", "turnstile": "/tmp/gpu-locks/HOST_QUIET.turn"}]},
     "BUILD": {"locks": [{"path": "/tmp/gpu-locks/HOST_QUIET.lock", "turnstile": "/tmp/gpu-locks/HOST_QUIET.turn",
                          "mode": "shared"}]}
    },
    "projects": {},
    "defaults": {}
   }
   ```

   `QUIET` holds the host-quiet lock exclusively, for a timed measurement. `BUILD` holds the same lock shared.
   Thus, builds can run at the same time as other builds, but not during a timed measurement. See [resource coordination](#resource-coordination).

4. Register the project under `projects`. Use a change list with `project_register`, or `mina host edit`.
   The example that follows shows the entry in the file. It registers one service, two workloads, and its own version of `GPU_A`:

   ```json
   "projects": {
    "/home/you/work/myproject": {
     "classes": {"observe": "allow", "reserve": "ask", "workload": "ask", "monitor": "allow", "restart": "ask"},
     "services": {
      "my-safety-watchdog": {
       "unit": "my-safety-watchdog.service", "restart": "ask",
       "sources": ["scripts/watchdog.py"], "process_match": "scripts/watchdog.py",
       "restart_requires_idle": ["GPU_A"],
       "logs": ["/home/you/work/myproject/logs/watchdog.log"],
       "health": {"log": "/home/you/work/myproject/logs/watchdog.log", "pattern": "START watchdog pid={pid} ",
                  "fail_pattern": "ENFORCEMENT_FAILED", "timeout_s": 30, "stable_s": 30}}
     },
     "resources": {
      "GPU_A": {"locks": [{"path": "/tmp/gpu-locks/GPU_A.lock", "turnstile": "/tmp/gpu-locks/GPU_A.turn"}],
                "lockouts": ["/home/you/work/myproject/state/lockout-GPU_A"],
                "requires_active": ["my-safety-watchdog.service"],
                "device": {"nvidia": ["00000000:01:00.0"]}}
     },
     "workloads": {
      "gpu-smoke": {"argv": ["/usr/bin/nvidia-smi"], "resources": ["GPU_A"], "max_s": 60},
      "gpu-cell": {"argv": ["{command}"], "resources": ["QUIET", "GPU_A"], "max_s": 3600, "queue_s": 900,
                   "sandbox": {"write": ["{project}"], "network": "offline"},
                   "requires_fresh": ["my-safety-watchdog"]}
     },
     "monitor_paths": ["/home/you/work/myproject/logs", "/sys/class/hwmon/hwmonN"]
    }
   }
   ```

   The effective resources of a project are the machine resources, plus the project's own `resources`.
   When the project has a resource with the same name as a machine resource, the project's entry replaces the machine entry completely.
   The two entries are not merged. Thus, the project's `GPU_A` repeats the lock and the device, and adds a lockout and a supervisor.
   `capabilities` shows the source of each resource: `machine` or `project`.

5. Show what the agent can do in the project:

   ```bash
   cd /home/you/work/myproject
   mina host show                        # the effective policy of the project
   python3 <mina>/host/hostd.py status   # the capabilities, from the running broker
   ```

The broker reads `host.json` for each request. After a change, you do not restart it.

A project that is not registered gets a full host session if `defaults` applies to it (see the next section).
Otherwise, it gets a limited session: the agent can see the machine with `inventory` and propose a registration with `policy_propose` (see [proposals from the agent](#proposals-from-the-agent)).
An older broker that does not support proposals gives such a project no host session.
`MINA_HOST=0` turns off the profile for one launch.

The broker keeps its state in `~/.local/state/mina/hostd/`. This folder and its audit log are private to your user (modes 0700 and 0600).

## Defaults for unregistered projects

The optional top-level `defaults` object is a project entry for projects that you did not register.
It has the same keys as a project entry, for example `classes`, `workloads`, `resources`, `max_reserve_s`, `max_monitors`, and `max_monitor_ttl_s`.
It also has the required `roots` list:

```json
"defaults": {
 "roots": ["~/work"],
 "classes": {"observe": "allow", "reserve": "ask", "workload": "ask"},
 "workloads": {
  "build": {"argv": ["{command}"], "resources": ["BUILD"], "max_s": 1800, "queue_s": 600,
            "sandbox": {"write": ["{project}"], "network": "offline"}},
  "gpu-cell": {"argv": ["{command}"], "resources": ["QUIET", "GPU_A"], "max_s": 3600, "queue_s": 900,
               "sandbox": {"write": ["{project}"], "network": "offline"}}
 }
}
```

These rules apply:

- A project gets the defaults only if its real path is strictly inside a folder in `roots`. The broker expands `~` and resolves symbolic links in `roots`.
- A root must be an absolute path or start with `~`. The broker ignores a root of `/`.
- The defaults never apply to a root itself, to `/`, or to your home folder.
  They also never apply in folders for credentials or in the folders of Mina's configuration and state, for example `~/.ssh` or `~/.config/mina`.
- A project under `projects` never gets the defaults. Its entry is complete: the broker does not merge it with the defaults.
- `{project}` in a workload of the defaults is the path of the project that uses it. This also applies to `argv`, `env`, `sandbox`, and the keys of `pin`.
- The broker ignores `services` in the defaults, because a service belongs to one project. `capabilities` then shows a BLOCKED `services` line.
  Thus, `requires_fresh` and `unit_active` monitors cannot work in the defaults. To give a project services, register it.

`session_open` gives `registered: true` and `policy_source: "defaults"` for such a project. `capabilities` also shows `policy_source`.
Audit records for operations on such a project contain `"policy_source": "defaults"`.
A remediation for such a project names a change to `defaults`, which changes all projects under `roots`.

Review the defaults as carefully as a project entry. With `ask`, you confirm each operation, but the workloads apply to every project under the roots.

## Change the host policy

There are two procedures to change `host.json`. Both use the same code (`host/policy.py`) for validation, changes, the diff, the risk flags, and the write.

- **You, in a terminal:** the `mina host` commands.
- **The agent, with your approval:** `mina_host policy_propose`. The broker shows you the diff in a dialog. It writes the change only if you approve it.

The broker reads the policy for each request. After a change, you do not restart it.

### The `mina host` commands

| Command | What it does |
|---|---|
| `mina host discover [--json]` | Shows the GPUs (bus IDs), the resources that cover them, the lock files with their holders, the lockouts, and suggested resources. It changes nothing. |
| `mina host show [PROJECT] [--json]` | Shows the effective policy of a project: its source (`project` or `defaults`), the classes, the resources, and the workloads. The default is the project of the current folder. |
| `mina host validate` | Shows the errors and the warnings of `host.json`. |
| `mina host apply FILE\|- [--project DIR] [--dry-run] [--yes]` | Applies a change list from a file or from standard input. |
| `mina host edit [--yes]` | Opens a copy of `host.json` in `$VISUAL`, `$EDITOR`, or `vi`. Then it examines the copy and applies it. |

The exit status is 0 for success, 1 for a refusal or a failure, and 2 for a usage error.
`MINA_HOST_CONFIG` selects another policy file, for example for a test.

`apply` and `edit` show the diff and the risk flags before they write. Then they ask you to confirm.
Without a terminal, they refuse, unless you add `--yes`. `--dry-run` shows the diff and writes nothing.
`edit` records the SHA-256 of the file when it starts. If another change writes the file before you finish, `edit` refuses and writes nothing.
After a write, the commands show the backup file and tell you that no restart is necessary.

The agent cannot use these commands. Its sandbox cannot write `~/.config/mina`.

### Change lists

A change list is a JSON list. Each change has a `kind`:

| Kind | Fields | The agent can propose it |
|---|---|---|
| `resource_set` | `scope` (`machine` or `project`), `name`, `resource` | `machine`: only a new name. `project`: only its own project. |
| `resource_remove` | `scope`, `name` | `project` only, for its own project |
| `project_register` | `project`, `entry` (optional) | Only its own project |
| `project_remove` | `project` | No |
| `workload_set`, `workload_remove` | `project`, `name`, `workload` | Only its own project |
| `classes_set` | `project`, `classes` (merged into the current classes) | Only its own project, and not the `policy` class |
| `monitor_paths_set` | `project`, `paths` | Only its own project |
| `defaults_set`, `defaults_remove` | `defaults` | No |
| `raw_set`, `raw_remove` | `path` (a list of keys), `value` | No |

`project` is an absolute path. Without `project`, a change applies to the project of the current folder (`mina host apply`) or of the session (`policy_propose`).
`raw_set` and `raw_remove` change any key, for example `alarm_command`, `version`, or a limit. Only you can use them.

`project_register` without `entry` registers the project with a copy of the defaults (without `roots`).
A project-scoped change to a project that gets the defaults first registers the project with a copy of the defaults. The defaults do not change.
The diff tells you about this registration. After it, the project's own entry replaces the defaults for that project.

An example change list for the project of the current folder:

```json
[{"kind": "workload_set", "name": "gpu-smoke",
  "workload": {"argv": ["/usr/bin/nvidia-smi"], "resources": ["GPU_A"], "max_s": 60}},
 {"kind": "classes_set", "classes": {"workload": "ask"}}]
```

### What each change does

1. The tool applies the changes to a copy of the policy.
2. It validates the complete result. An error refuses the change. An unknown key is only a warning.
   A key that starts with `_`, for example `"_comment"`, is a note for people: no warning, and the broker ignores it.
   Use it in an object of settings, not in a map of names such as `projects`, `resources`, or `workloads`.
   The broker uses the same rules when it reads the policy, so the two cannot disagree.
3. It shows a line-based diff. Keys are sorted, so the same change always gives the same diff.
4. It shows the risk flags:
   - a workload that runs any command (`{command}`);
   - a workload with network `open`, or with write access outside `{project}`;
   - a workload without the broker's sandbox;
   - a class that becomes `allow`;
   - a new or changed `alarm_command`;
   - changed or removed defaults, with their `roots`;
   - a changed or removed machine resource, with the projects that use it;
   - a project resource that replaces a machine resource of the same name.
     The flag names the locks, lockouts, `requires_active` units, and device checks that the project then does not use;
   - a resource that loses a lockout or a `requires_active` unit;
   - a workload that loses a pin, or that pins a new version of a file.
5. It writes the file only if the file did not change after step 1 (the SHA-256 is the same). Otherwise, it refuses and writes nothing.
6. It copies the old file to `host.json.bak-<UTC time>`, for example `host.json.bak-20261029T170000Z`. It keeps the 10 newest backups.
7. It writes a temporary file, syncs it, and renames it to `host.json`. The policy file and the backups have mode 0600.
   If `host.json` does not exist, the tool makes it, with its folder (mode 0700). A new file starts with `{"version": 1}`.
8. It adds a `policy_change` record to the audit log (`~/.local/state/mina/hostd/audit.jsonl`), if that folder exists.

### Proposals from the agent

The agent can propose a change with `mina_host policy_propose`, with `changes` (a change list) and `reason` (at most 500 characters).
It is a mutation in the `policy` class. Thus, it uses the same request-bound confirmation as the other mutations.

- The default level of the `policy` class is `ask`. This also applies to a project that gets the defaults, and to a project that is not registered.
- The broker handles `allow` as `ask`: you approve each proposal in the dialog. With `deny`, the broker refuses all proposals.
- The agent can propose changes only to its own project, and a machine resource only with a new name.
  It cannot set the `policy` class. The broker refuses other changes and gives the `mina host apply` procedure for you.

The broker applies the changes, validates the result, and computes the diff and the risk flags itself.
The dialog shows a header, the reason labeled as the agent's words, the risk flags, and the diff.
Pi shows the complete text. If the text is taller than the terminal, Mina also puts it into the chat, so you can scroll up to read it.
If the diff has more than 60 lines, or the text has more than 4000 characters, the broker refuses with `INVALID`.
Then the agent can split the change, or write a change file in the project for you to apply with `mina host apply`.

The confirmation is bound to the request, the session, and the revision of the policy.
If the policy changes after the dialog opens, the approval does not apply. The broker then refuses, and it writes nothing.
After a write, the broker returns the new revision, the SHA-256 of the diff, and the risk flags.
The audit record contains the project, the session, the change kinds, and the SHA-256 values before and after.
It also contains the flags, the backup, and the SHA-256 of the diff.
The next `capabilities` call reads the new policy.

`mina_host inventory` (class `observe`) shows the agent the GPUs of the machine and the resources that cover them.
It also shows the lock files and the lockouts of the machine resources and of the project's resources.
For each lock file, it shows the holder processes (PID and the first two arguments).
It does not show the resources of other projects.

### Projects that are not registered

When the broker supports proposals (`policy_protocol: "mina-policy-v1"`), the launcher opens a host session also for a project that is not registered.
In such a session, `capabilities` shows only `inventory` and `policy_propose` (REQUIRES AUTHORIZATION). The broker refuses all other operations.
The manifest in the system prompt is one line. It tells the agent that it can see the machine and propose a registration.
As before, only the launcher can open a session (`session_open`) for a project that is not registered. `MINA_HOST=0` turns off the profile.

## Operations and approval

| Class | Operations | Default |
|---|---|---|
| observe | `capabilities`, `inventory`, `service_status`, `service_logs`, `workload_status`, `workload_budget`, `workload_output`, `monitor_list`, `alarms` | `allow` |
| reserve | `reserve`, `release` | `deny` |
| workload | `workload_run`, `workload_stop` | `deny` |
| restart | `service_restart` | `deny` |
| monitor | `monitor_add`, `monitor_remove` | `deny` |
| policy | `policy_propose` | `ask` (`allow` is handled as `ask`) |

Each class is `allow`, `ask`, or `deny`. A service also has its own `restart` level. The lower of the two levels applies.

- With `ask`, `mina_host` asks you to confirm each mutation. Without an interactive terminal, the mutation stays refused.
- The client removes approval fields that the model supplies. It adds an approval only after you confirm.
- The broker also enforces these rules when a handler is called directly.

The broker refuses a class at `deny`, or a target that is not registered, with `REQUIRES_AUTHORIZATION`.
The refusal includes the exact `host.json` change that approves it. A new class of host operation is always your decision.

The operation list has no general host shell, no command to send a signal to a PID, no user bus proxy, and no command to clear a lockout.
A registered workload can accept command arguments, and it can open file, device, and network access.
Registration is an authority boundary, not a safety review. Review the permissions and the cleanup effects of each workload that accepts a command.

### Request-bound confirmation

The client sends mutations through the `mutate_v2` envelope. This envelope also requires that the broker enforces admission budgets.

- An old broker refuses `mutate_v2` before any effect. The client never falls back to an older envelope.
- The capability list marks mutation capabilities BLOCKED when the broker is not compatible.
- A compatible broker advertises `mina-confirmation-v1` and `mutation_protocol: mutate_v2`.
- Read operations keep their wire format.

For an `ask` mutation, the broker returns `approval_request` with a private challenge, a request digest, the protocol, and an expiry.
The challenge binds the session, the project, the full request, the prompt, and the policy revision.

1. The client copies the arguments before the dialog.
2. Only a boolean `true` from the dialog permits the retry with the confirmation.
3. Before the retry, the client makes sure that the session did not shut down and the request was not aborted.

The transport does not cancel a request that it already sent. An abort does not prove that a host job stopped.

The broker uses each challenge once, before any effect. A changed request, another session, an expiry, or a replay cannot use it again.

- Challenges expire after 15 minutes. A broker restart makes all open challenges invalid.
- The broker keeps at most 64 open challenges for each session and project, and 1,024 in total.
- Identical open requests share one challenge. When the queue is full, the broker refuses new requests and keeps the existing ones.
- A declined dialog leaves its challenge open until it is used or expires.
- Tokens never go into model output or audit records. Audit records keep a hash of the challenge for correlation.

The broker reads the policy bytes and the file identity for each request. An atomic replacement of the policy file is found even if the modification time is the same.
A policy change before admission causes a refusal. After admission, the request uses one policy snapshot. Later requests use the later policy.
The snapshot does not freeze executable files or cleanup policy.

The Mina UI is a trusted client. Request binding does not prove that a person clicked the dialog.
It does not create an instance grant, reset a budget, or permit another attempt.

The `observe` class keeps an older behavior: `ask` permits observation without a dialog. For a clear read policy, use `allow` or `deny`.

### Updates of the broker and the client

A new client refuses mutations against an old broker. A source update does not reload a running broker or a running Mina.
Restart them only at a safe point. A broker restart releases reservation locks.
Before a restart, make sure that no workload, monitor, or restoration duty depends on the broker.

## Admission budgets

An optional `instance_budget` limits admissions across all registered workloads for one launcher instance.
A workload can also have its own `instance_budget`. Both limits apply.

```json
"instance_budget": {"max_admissions": 4, "max_reserved_s": 7200}
```

- Each field can occur alone. Limits must be integers of zero or more. Zero prohibits new admissions.
- Without limits, admissions are not limited. A malformed limit causes a refusal, not an unlimited fallback.
- `max_s` must be a positive integer within the registered maximum. `queue_s` must be an integer of zero or more.

The unit is a broker admission, not an experiment or a successful result.
Each admission reserves one slot and the full `max_s + queue_s` time.
This sum is not measured CPU time, GPU time, energy, or provider cost. It does not count work inside a command.

The broker counts all admissions from the start of the session, also before you set a limit.
A goal change, a model change, a new client, or a later policy edit does not reset the counters. A higher limit keeps the earlier spending.

- The broker examines the remaining budget before a dialog. Then it charges the budget atomically, before job files or the systemd launch.
- It examines the policy revision again inside the charge lock.
- Errors before the charge cost nothing. Errors after the charge do not refund it.
- Errors after the charge include the admission identity. Long diagnostics do not hide this identity.
- A missing reply does not prove a refund or a stop.
- When the budget is spent, only a new limit from you permits more admissions. A confirmation dialog cannot raise a limit.

`workload_budget` shows the counters, the limits, the remaining allowances, and the coverage of the accounting.
Workload records keep their admission identity and charge.

### After a broker restart

The live broker keeps the counters in memory. Audit records and workload records are evidence, not a source of authority.
The broker does not rebuild an allowance from files or transcripts.
After a restart, the coverage of a surviving session is unknown. Configured budgets then block new launches.
A new launcher is a new instance, not a refund of the old budget.

## Capability preflight

`capabilities` gives each capability one of three states: AVAILABLE, BLOCKED, or REQUIRES_AUTHORIZATION.
Each entry has its evidence, what is missing, and the smallest change that fixes it. The broker examines these items:

- **Host observation:** the registered monitor paths are readable.
- **Services:** each unit is loaded. The entry also shows the restart approval and the deployment state.
- **Resources:** the lock files, the lockouts, and the units in `requires_active`.
  If `protocol_source` names the script of your host runner, the broker makes sure that the script uses the same lock paths.
  The broker also makes sure that it shares one mount namespace with the running supervisor, so both see the same `/tmp`.
- **Process containment:** systemd runs a delegated cgroup v2 user manager with `cgroup.kill`.
- **Monitoring:** the broker loop is alive. External alarm delivery has its own line.

The broker caches the result until a fingerprint changes. The fingerprint covers the registry, the boot, the state and main PID of the services, the source files, the lock files, and the lockouts.
The system prompt shows the result as stable text without timestamps, so the prompt cache of a local model stays valid.
The agent does AVAILABLE operations itself, does not try BLOCKED ones, and gives you the remediation once.

## Retained workload output

`workload_status` includes only the last 20 log lines. For the full output, use `workload_output`:

```json
{"action": "workload_output", "id": "JOB_ID", "offset": 0, "limit": 4096}
```

- `JOB_ID` is the broker job ID, not a path. The project of the session must own the job.
- The default page is 4096 bytes. The maximum is 8192 bytes.
- The response has `next_offset`, `source_id`, `size_bytes`, `eof`, readable `text`, and exact `data_base64`.
- Offsets count bytes. `text` can replace split or invalid UTF-8. `data_base64` keeps the exact bytes.
- The broker refuses other paths, symlinks, hard-linked logs, and files that are not regular files.

To read more, use `next_offset`. Compare `source_id` before you join pages, so that you find a replaced log.
`eof` tells only that the reader is at the current end of the file. It does not tell that the job is complete. `workload_status` gives the completion and the cleanup.
Reads need no admission or confirmation, and they work after a broker restart. If the log is missing, do not run the job again only to get its output.

## Pushing

Workers cannot push. They have no SSH keys, no port 22, and no credential helper.
Commits use your git name and email from `git config --global`. A push goes through one registered workload, which runs `host/git-push-gate.py` on the host with your SSH setup:

```json
"git-push": {
  "argv": ["/usr/bin/python3", "<mina>/host/git-push-gate.py",
           "--remote-url", "git@github.com:OWNER/REPO.git", "--branches", "^(main|feature/.*)$", "{project}", "{branch}"],
  "params": {"branch": "^[A-Za-z0-9._/-]{1,100}$"}, "max_s": 300,
  "pin": {"<mina>/host/git-push-gate.py": "SHA256", "<mina>/host/gitleaks.toml": "SHA256"}
}
```

Replace `<mina>` with the absolute path of your Mina folder, and `SHA256` with the hash of each file.

The gate refuses these pushes:

- A push to an `origin` URL other than `--remote-url`.
- A branch that `--branches` does not match.
- A push that is not a fast-forward. Thus, the gate never force-pushes, rewrites history, or deletes a branch.
- Outgoing files larger than `--max-mb` (20 MiB by default).
- A gitleaks finding in an outgoing commit.

gitleaks runs offline with `host/gitleaks.toml`, which has only the default rules.
The repository's `.gitleaks.toml`, `.gitleaksignore`, and `gitleaks:allow` comments do not apply, because the agent can edit them. The gate fails closed.
It prints one JSON line: `pushed`, `up_to_date`, or `refused`, with the reason. A finding names the file, the line, and the rule, never the secret.
The workload class sets the approval. The gate reduces accidental disclosure. It does not prove that nothing sensitive goes out.

## Resource coordination

The broker uses the lock files of your host runners. It makes no lock files of its own.
All projects on the machine use the same lock files, so GPU jobs and host jobs from different projects do not overlap.

The coordination is only for one machine. The locks are `flock` locks on files of this machine.
Another machine, for example one on the same tailnet, runs its own broker with its own locks. The brokers do not coordinate.

### Lock entries

A resource has a `locks` list. Each entry has these fields:

- `path`: the lock file.
- `turnstile` (optional): the lock file that runners hold while they wait in the queue for `path`.
- `mode` (optional): `exclusive` (the default) or `shared`. Shared holders can hold the lock at the same time. An exclusive holder excludes all others.

The broker takes the locks in the order of the list, and in the order of the resources in the request.
When two requested resources contain the same path, the broker takes it once, at its first position.
If one of them asks for `exclusive`, the lock is exclusive.

Use `shared` for work that can overlap other work of the same type, but not a timed measurement.
In the example, `BUILD` holds the host-quiet lock shared, and `QUIET` holds it exclusively. Builds overlap each other, and a measurement waits until all builds end.

### Without a wait

`reserve`, the idle check of a restart, and a workload with `queue_s` 0 take the locks without a wait:

- A held lock is a CONFLICT. The refusal names the holder, from `/proc/locks`.
- A held turnstile lock is also a conflict, because a runner is in the queue. The broker never jumps a queue.
- The idle check of a restart takes all its locks exclusively, also shared entries, because idle means that nobody holds the lock.

### With a wait (`queue_s`)

A workload with `queue_s` greater than 0 waits for its locks, for a maximum of `queue_s` seconds in total.
`lockrun.py` waits in the unit of the workload. The broker does not wait. It uses the queue protocol of the host runners:

- **Exclusive entry with a turnstile:** it takes the turnstile (it waits if necessary). It waits for the lock while it holds the turnstile. Then it releases the turnstile.
  Thus, it keeps its place in the queue, and nobody who comes later gets ahead of it.
- **Shared entry with a turnstile:** it takes the turnstile (it waits if necessary) and releases it immediately. Then it takes the lock shared.
  Thus, a shared taker cannot get ahead of an exclusive waiter that holds the turnstile.
- **Entry without a turnstile:** it waits for the lock.

While the workload waits, `workload_status` shows the state `queued`, the lock that it waits for, and the holders of that lock.
`queued` is a live state: `workload_stop` stops the job, and the job has not ended.
When `queue_s` ends, the workload releases every lock that it took, and its state is `conflict`, with the lock and its holders as evidence.

The workload can wait while it holds the locks that come earlier in its list.
Thus, list the locks in the same order as the host runners that share them.
In a different order, a workload and a runner can each hold a lock that the other waits for. They then block each other until `queue_s` ends.

### Exclusive use

The broker gets exclusive use in two steps:

1. It takes the locks.
2. With the locks held, it makes sure that no process outside the protocol uses the device.
   `{"kfd": true}` reads `/sys/class/kfd/kfd/proc` for AMD GPUs. `{"nvidia": [bus IDs]}` reads the `nvidia-smi` compute apps.
   Both list the processes of all users.

Step 2 also occurs after a wait, before the command starts.
If the device users cannot be read, the result is BLOCKED: the broker fails closed.
A file in `lockouts` that exists, or a unit in `requires_active` that is not active, also gives BLOCKED. The broker reads lockouts and never clears them.

There are two kinds of hold:

- **`reserve`:** the broker holds the locks, for at most `max_reserve_s` (3600 s by default). If the broker stops, the kernel releases the locks.
  The broker does not contain processes that the agent starts itself.
- **`workload_run`:** the unit of the workload holds the locks. `lockrun.py` gives the lock descriptors to the command, so the locks stay held while a process of the workload is alive.

## Containment

Each workload is a transient user service: `systemd-run --user` in `mina.slice`, with `Type=exec`, `RuntimeMaxSec=max_s`, `KillMode=control-group`, and `TimeoutStopSec=5`.

- The broker writes the record before the launch. After a restart, it finds an interrupted launch.
- After the unit ends, the broker makes sure that the cgroup is gone and that each process it saw has exited. It identifies a process by PID and start time, so a reused PID does not confuse it.
- `workload_stop` stops only the cgroup of that unit.
- When the main process exits, systemd stops the unit and kills the processes that are left.
- systemd enforces the deadline, also when the broker is down.

## Parameterized workloads

A project's work often does not fit fixed commands. Its own launcher can also need host access that the sandbox removes, for example the host lock files or the user bus.
Some tools cannot start inside bubblewrap at all. For example, rootless podman needs `newuidmap`, and `no_new_privs` blocks it.
Thus, a workload can take arguments, with these controls:

- **`params`:** named values. Each value must match its registered pattern. The broker puts them into `argv` and `env` (`{name}`).
  `{max_s}` is the requested time limit, at most the registered one.
- **`queue_s`:** the maximum time in seconds that the workload waits for its locks (see [resource coordination](#resource-coordination)). The default is 0: no wait.
- **`{command}`:** the agent's own argv. By default, it runs in a bubblewrap sandbox that the broker makes:
  - A read-only root, with the devices available.
  - A private `/tmp` and runtime folder: no user bus and no host lock files.
  - Hidden credential paths.
  - Write access only to `sandbox.write`. Folders in `sandbox.readonly` come back read-only.
  - No network, unless the workload sets `"network": "open"` in `sandbox`.

  With `command_sandbox: false`, the broker gives the command to a launcher that runs it in its own sandbox, for example a podman container.
- **`pin`:** the SHA-256 of each file that runs on the host side. The agent can edit project files, so the broker refuses a pinned file that changed.
  The result is BLOCKED, with the new hash for you to approve after a review.
- **`delegate`:** cgroup delegation for the unit. Then `podman --cgroups=split` keeps the container inside the unit, and a stop of the unit stops the container.
- **`cleanup`:** a registered host command that runs after each workload ends.
- **`requires_fresh`:** services that must be FRESH (see the next section) before the workload can start.

In the example registry, `gpu-cell` runs the agent's command with the host-quiet lock and `GPU_A` locked, write access to the project only, and no network.

## Deployment verification

`service_status` compares the start time of the main process with the change time and SHA-256 of each source file. It also gives the git HEAD and the uncommitted sources.
The result is FRESH, STALE (a source changed after the process started), NOT_RUNNING, or UNKNOWN.

`service_restart` does these steps:

1. It takes the resources in `restart_requires_idle`, so nothing measures while the supervisor is down.
2. It makes sure that no process uses the devices.
3. It restarts the unit.
4. It examines the result. All of these must be true:
   - The unit is active.
   - The main process is new: a new PID and start time.
   - The deployment is FRESH.
   - Exactly one process matches `process_match`.
   - The health line has appeared since the restart. `{pid}` in the pattern is the new PID.
5. It waits for a settling window (`health.stable_s`, 5 s by default). The same main process must still be active, and no line that matches `health.fail_pattern` must appear.

Step 5 exists because a service can pass every check of step 4 and fail a few seconds later.
The broker records a verified restart in `deployments/<service>.json` in its state folder. A failed restart is reported with its failures and is never recorded as a success.

A workload with `requires_fresh` is BLOCKED while the service is not FRESH. Thus, an experiment cannot run on stale deployed code without notice.

## Monitoring and alarms

`monitor_add` registers a monitor in the broker, with a time to live (TTL). These are the kinds:

- `unit_active`: an alarm when the unit is not active, and when its main PID changes.
- `file_fresh`: an alarm when the file did not change for `max_age_s`.
- `log_match`: an alarm on new lines that match the pattern, at most once for each `min_interval_s` (300 s by default).
  The broker counts the matching lines between alarms and reports them with the next alarm.
- `sensor_max`: an alarm when the value is more than the maximum. A sensor that cannot be read two times in a row also gives an alarm.
- `workload`: an alarm when the workload ends. Each `workload_run` adds one automatically.
  For a run of less than 2 minutes, the broker holds this alarm for a short time. It drops the alarm if the agent already read the result of the workload.

Paths must be in the project or in the registered `monitor_paths`.
The broker examines each monitor every 2 seconds and keeps the state in `monitors.json`.
It records each alarm in `alarms.json`, in the audit log, and in its journal. A monitor that gets to its TTL is removed, and the removal is audited.

The client polls for alarms every 10 seconds and at session start.
It puts each alarm into the conversation and starts a turn if the agent is idle. Only then does it acknowledge the alarm.

- An alarm belongs to the session that created its monitor. While that session's launcher lives, only that session gets the alarm.
- After the launcher exits, any session of the project can take the alarm, for example a session after a handoff or a restart.
- An alarm that occurs while no session is live waits for the next session of the project.

### External alarm delivery

`alarm_command` is optional. Without it, alarms stay on this machine.
With no live Mina session, an alarm reaches a person only through the audit log and `journalctl --user -u mina-hostd`.
`capabilities` reports this as `alarm_delivery_external: BLOCKED`.

To add a channel, set `"alarm_command": ["<notifier>", ...]` at the top level of `host.json`.
The command gets each alarm as JSON on standard input, after `alarm_external_after_s` (120 s by default) without an acknowledgement from a session.
Exit code 0 counts as delivered. The alarm text then goes wherever your notifier sends it.

## Who can call the broker

The broker accepts a grant only from the Pi process of the session that opened it:

- Only a process outside every sandbox can open a session. It must share the mount namespace of the broker. The Mina launcher is such a process. Sandboxed processes are not.
- A request with a grant is accepted only from the launcher's child, or its grandchild through `bwrap`. In practice, that is the Pi process. The session binds to this one process identity.
- A command of the agent is refused, because it is deeper in the process tree. The socket folder and the grant file are also hidden from the agent's commands and from the read tool.
- Subagents run inside the Pi process, but only the top-level instance of the host extension holds the session. Subagents have no host operations.
- A handoff shuts down the old instance before the new one loads, so the successor keeps the session.

The broker appends each request, decision, verification, and alarm delivery to `~/.local/state/mina/hostd/audit.jsonl`. It never logs grants.

## Tests

- `python3 host/test_hostd.py` runs an isolated broker against real systemd units, cgroups, file locks, and process trees. It uses no installed state. The tests cover:
  - Authentication: the Pi process is accepted, directly and through bwrap. A shell child, a forged grant, and a sandboxed session opener are refused.
  - Preflight and caching, status, and logs.
  - Restarts: verified, failed, approval levels, and refusal while resources are busy.
  - Stale deployments that block workloads.
  - Reservation conflicts: a holder, a turnstile in use, a second session, a lockout, a stopped supervisor, and a device user.
  - Machine resources: two projects share one lock, and a project resource with the same name replaces the machine resource.
  - Defaults: the folders that get them, `{project}` expansion, ignored services, and `policy_source` in sessions, capabilities, and audit records.
  - Waits: a queued workload runs after the release, keeps the turnstile, raises no false end alarm, and can be stopped. The end of `queue_s` releases every lock.
  - Shared locks: two builds overlap, a measurement waits for both, a new build cannot pass the measurement, and mixed modes become exclusive.
  - Workloads: completion, a conflict that runs nothing, a leader exit with a surviving child, a stop, the systemd deadline, an interrupted launch, and a broker restart during a run.
  - Monitors: alarms across sessions, log matching, TTL expiry, and the path allowlist.
  - The audit log never contains grants.
- `python3 host/test_policy.py` covers the host policy and proposals. It uses temporary policy files and fixture GPUs:
  - Validation: each field error at its path, unknown keys as warnings, and the same rules in the broker.
  - Each change kind, the registration with a copy of the defaults, and the agent's limits.
  - Each risk flag, the stable diff, and escaped control characters.
  - The write: a new private file with `version` 1, backups and their pruning, and a refusal after a concurrent change.
  - The inventory, and `policy_propose` with a real broker: the dialog, a write after approval, the audit record, and unregistered projects.
- `node --test test/host.test.mjs` covers the capability text, the exclusion of subagents, the handoff successor, delivery before acknowledgement, approval that the model cannot forge, and the sandbox binds.
  It also covers `policy_propose`, `inventory`, the one-line manifest of a project that is not registered, and the complete dialog text.
  A test with a real sandbox shows that the agent cannot write `~/.config/mina`.
- `node --test test/host-policy-cli.test.mjs` covers the `mina host` commands: exit codes, `apply`, `--dry-run`, the refusal without a terminal, `discover` with fixtures, and `edit`.

## Limits

- **Your decisions.** Only you approve a class, register a service, resource, workload, or monitor path, set `defaults`, or set `alarm_command`.
  These are changes to `host.json`, through `mina host` or an approved proposal, or by hand.
- **Proposals.** The broker computes the diff and the risk flags, but the reason is the agent's text. An approved proposal has the same effect as your own edit.
  A new machine resource from a proposal applies to all projects. The risk flags do not find every risk: read the diff.
- **One machine.** Locks coordinate only the jobs of this machine. Brokers on other machines, also on the same tailnet, do not coordinate with this one.
- **Lock order.** A workload that waits holds the locks that come earlier in its list. If its order is different from the order of a host runner, both wait until `queue_s` ends.
- **Defaults.** The defaults apply to every project under `roots`, also to a project that you did not expect. They cannot give services.
- **Lockouts.** An operator clears a safety lockout. Mina never clears one.
- **No root.** The broker cannot list the open files of other users' processes. Device ownership uses the KFD process list and `nvidia-smi`, which cover all users. NVIDIA graphics clients that do not compute are not listed.
- **Files that a workload runs.** The argv of a workload is fixed, but the files that it runs are not. A workload that runs a script from the project runs what the agent last wrote there, unless you pin it.
- **Processes under a `reserve`.** Processes that the agent starts itself stay in the agent's sandbox, not in a broker cgroup. Run measurements as registered workloads where possible.
- **`--nosandbox`.** Any process of your user can then reach the grant file and the socket. The protection of the profile depends on the sandbox.
- **Model sessions.** The tests replace the model with a scripted caller. They do not prove how a model uses `mina_host` over a long goal.
