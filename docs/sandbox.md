# The sandbox boundary

This document tells what the sandbox of Mina protects, what it does not protect, which limits apply, and how to stop an instance.
For the options and daily use, read [the sandbox](usage.md#the-sandbox) in the usage guide.

The harness controls authority and continuity. The agent selects its workflow.
A passed project check proves what the check examines. It is not an independent acceptance or a scientific qualification.

- [Goal completion](#goal-completion)
- [One local execution boundary](#one-local-execution-boundary)
- [Trusted resources and modes](#trusted-resources-and-modes)
- [Limits and local stop](#limits-and-local-stop)
- [Broker recovery](#broker-recovery)
- [What the sandbox does not protect](#what-the-sandbox-does-not-protect)
- [Not in scope](#not-in-scope)

## Goal completion

New goals use the completion policy `checks-only`.
Mina does not require doubt logs, number tables, file-time provenance, or extra critic or reviewer calls.
If you require scientific validators, they are part of the checks of the project.

- Working checks stay editable. Your explicit requirements stay binding.
- A failed check or a timeout prevents completion. Work without checks gets the label UNVERIFIED.
- Goals in an older format cannot complete under the `checks-only` policy. Mina does not silently give an existing goal a weaker contract.

### Protected checks

Protected checks run the exact bytes that you accepted, from a private snapshot:

- The check runner pins the source files before the run. A rename in the project during the run cannot change what the checker sees.
- The checker gets a private folder structure. Open file descriptors for the folder walk never go into the worker.
- The tool display never reads project files in the controller.

Existing project files and folders stay bound to their objects in the project.
New files at the top level of the project stay in the retained staging folder of the check. They do not go into the project automatically.
Thus, create output folders before protected checks if later checks read their outputs.
The staging folder contains placeholders for the mount points, not a full copy of the project.

Goal and handoff code reads and writes project files through the worker, also for amendment drafts.
A symlink in the project cannot send this code to the credentials or the configuration of the controller.

### Handoff

A handoff carries the times and recorded results of the checks. It does not run the checks.
If a protected file changed, a recorded PASS becomes NOT RUN.
An active goal continues in the successor session. A handoff outside goal mode does not make a new autonomous objective.

## One local execution boundary

Pi is the trusted controller. Commands that the model writes, and the file tools, run in workers that the kernel isolates.
The main tools, the subagents, the goal checks, and interactive `!` commands all use this boundary.

Each worker has only these items:

- The project and the data folders that you declare.
- Read-only system software, selected system files, Mina's skills, and Pi's documentation.
- A private home and a package cache for the instance, separate from the caches of the controller.
- Private PID, IPC, UTS, network, temporary, and runtime namespaces.
- A minimal device tree, without host GPU devices and without the user service bus.
- A fixed list of environment variables, without credentials or execution hooks.

At startup, the launcher refuses unsafe writable folders, writable files with more than one hard link, sockets, and special files.
The refusal lists the count and a few examples. For hard-linked git objects of a local clone, it gives the repair command `mina sandbox unlink-git-objects DIR`. Mina does not repair at startup: the scan changes no file.
The scan also refuses a repository that uses git data from a folder that the sandbox does not show (the `objects/info/alternates` of a shared clone, the `.git` file of a git worktree). Git would fail in the sandbox with errors that do not give the cause.
This scan runs once at startup, not before each tool call. Changes that trusted host processes make later are outside this scan.
A read-only data mount cannot give an outside inode to a separate writable mount through `link(2)`.

### Network

- `open` (the default) permits public HTTP and HTTPS through the egress proxy. Raw access to the host or the LAN is not available.
- `packages` limits the proxy to package hosts.
- `offline` gives the worker no network.

The research tools and the model provider are trusted. They keep their own network connections, also to local research services that you configure.
An offline worker does not make these tools offline.

## Trusted resources and modes

All sandboxed modes load explicit Mina extensions, not executable project code that Pi finds.
Executable project configuration and project prompt templates stay off.

- `--full` resolves your global, configured, and package skills with Pi's own rules, without their extensions.
  Mina validates their paths and gives workers read-only access to each skill folder. It reads the project's `AGENTS.md` and `CLAUDE.md` through the worker.
- `--fast` and `--lean` load smaller sets of resources.
- The research skill always loads explicitly.

Mina refuses a skill alias that the agent can write, and a helper folder that contains private controller state.
It also refuses symlink chains that go through writable folders.
Sign-ins, model definitions, and your configuration stay outside the paths that the agent can write.
Extra extensions that you load explicitly are trusted host code. The sandbox does not contain them.

These rules apply to the installation:

- The Mina installation and its packages must be outside the writable folders.
- Data, virtual environments, and linked worktree metadata outside the project need their own folder options.
- The terminal UI and RPC mode are the supported interfaces for long sessions. Print and JSON mode are Pi's one-shot interfaces.
- To develop Mina with Mina, run an installed copy and edit a separate checkout.

If bubblewrap or the systemd user session is missing, Mina refuses to start. There is no fallback without the sandbox.
`--nosandbox` leaves this boundary on purpose, and it also turns off the local limits.

## Limits and local stop

One systemd scope with a UUID name contains the controller, its workers, and its local child processes.
These are the default limits:

| Limit | Default |
|---|---|
| Total time | No limit |
| CPU | 8 cores |
| Processes | 1024 |
| Memory | Half of the host memory, maximum 32 GiB |

You can set positive integer limits in `~/.config/mina/sandbox.json`. Set `maxWallS` only if you want a deadline:

```json
{
  "read": ["/data/reference-panel"],
  "write": ["/data/analysis-output"],
  "network": "open",
  "limits": {
    "maxWallS": 86400,
    "memoryBytes": 34359738368,
    "cpuPercent": 800,
    "maxProcesses": 1024
  }
}
```

### Stop an instance

A normal start shows no instance information. `--verbose` shows the instance ID, the limits, and the stop command.

1. List the instances:

   ```sh
   mina status
   ```

2. Show one instance:

   ```sh
   mina status INSTANCE_ID
   ```

3. Stop the instance:

   ```sh
   mina stop INSTANCE_ID
   ```

`mina stop` stops only the scope of that UUID, and it makes sure that the cgroup has no processes left.
Artifacts and records stay. The stop does not restore hardware settings or delete evidence.

CAUTION: `mina stop` does not stop broker jobs, and it does not cancel a broker request that was already sent.
Use `mina_host` `workload_status` and `workload_stop` for these jobs. Their locks, deadlines, and restoration duties stay in force.

### Subagents and outputs

- The `Agent` tool permits four children at the same time and 64 child starts for each launch.
- Each child has a fixed tool set, no host tool, and no resource discovery.
- Each child has a limited number of turns, at most 200. A resume or a handoff does not reset these allowances.
- Saved files, transcripts, partial reports, and errors stay separate.

Large outputs of the model's commands stay readable at `/run/mina-outputs`. They are kept on the host in `~/.local/share/mina/artifacts/INSTANCE_ID`.
A later instance can read retained data if you add that folder with `--sandbox-read`.
These limits are coarse. They are not provider billing, disk quotas, or a count of scientific attempts.

## Broker recovery

The optional host broker keeps its own protections: registered profiles, one-use confirmations, admission budgets, locks, deadlines, and verified stops.
A registered workload can go past the local worker boundary on purpose. Its configuration needs a separate review.
Workload code that is not contained acts with your host permissions. Use only reviewed profiles for unattended work.
A narrow operation name does not make a narrow workload profile.

The client attaches a stable request identity to each workload request:

- A repeated, identical request in one session returns the existing observation. It does not start or charge a second job.
- A changed request with the same identity is refused.
- The broker writes a durable intent before the launch. After a restart, an incomplete intent stays blocked. It does not permit another launch.

A status by request ID is a stored observation. Follow the returned job ID for the current state.
Records do not restore grants, reset counters, or prove execution.
After a broker restart, the budget coverage is unknown, and configured budgets block new admissions.
A timeout does not prove a cancellation. Errors keep the request ID for reconciliation.
An older broker refuses the new request format. The client does not fall back to an older protocol.

## What the sandbox does not protect

- **Changes in the project.** The agent can change or delete each file in the project, also in `.git`. Commit frequently, or keep a backup. See [why git is not sufficient recovery](architecture.md#why-git-is-not-sufficient-recovery).
- **Data that leaves the computer.** Declared project data can leave through the model provider, the research tools, and public web requests.
- **Secrets in your data.** The sandbox does not find secrets inside the folders that you declare.
- **Exploits.** The sandbox does not protect against kernel, decoder, or trusted-extension exploits.
- **A hostile host.** It does not protect against hostile host processes or a host that is already compromised.

The tests of the sandbox use disposable files, processes, scopes, scripted providers, and isolated brokers.
They are not a formal security audit.

## Not in scope

The sandbox does not give these functions:

- General capability grants for an instance.
- Graphs of decisions or evidence, and ledgers of scientific attempts.
- Full accounting of billing or storage.
- Automatic recovery of authority after a restart.
