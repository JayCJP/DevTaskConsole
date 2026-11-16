# DevTask Console

Local development-task dashboard built with Vue 3, Vite, Tailwind CSS, Fastify, and Node.js 22.

## Development

```powershell
pnpm install
pnpm dev
```

The web app runs on Vite and proxies `/api` requests to the Fastify service on `127.0.0.1:7788`. The first server start creates a local access token under `%LOCALAPPDATA%\DevTaskConsole\control-panel-token`; enter that token in the browser login screen.

Set `DEVTASK_WORKSPACES_ROOT` before starting the server to change the workspace root. Set `DEVTASK_SOURCE_ROOT` to change the read-only Git repository candidate root; the Windows default is `D:\workfile`. The workspace root defaults to `D:\test-blanch`.

## Workspace initialization

The workspace page only offers repositories returned from `DEVTASK_SOURCE_ROOT`; select them explicitly. DryRun invokes the local `~\.codebuddy\skills\create-workspace\scripts\create-workspace.ps1` with `-DryRun` before enabling initialization. The server requires PowerShell 7 (`pwsh`) and passes repository names as process arguments rather than through a shell.

Confirmed initialization creates git worktrees and a `.code-workspace` file, then runs the script's selected `npm install` and graphify stages. It does not pull, commit, push, or delete worktrees. Job state and bounded logs persist in `workspace-initialization-jobs.json`. After restart, a job previously marked running is reported as interrupted because the child process cannot yet be safely reattached.

## Data connections

The server reads MCP connection settings from `%USERPROFILE%\.codebuddy\mcp.json` by default. Set `DEVTASK_MCP_CONFIG` to use another file. Keep this file local and do not commit it; connector credentials are read only by the server.

The current read-only GitLab adapter uses `GITLAB_API_URL` and `GITLAB_PERSONAL_ACCESS_TOKEN` from the `GitLab` server entry. The DevOps adapter uses `HOST`, `login_id`, `user`, `csrftoken`, and `sessionid` from `Devops_MCP`. DevOps HTTP 403 responses are reported as an expired session; refresh the local session values before retrying. Release write actions remain disabled.

The Workspaces page stores manually confirmed repository-to-GitLab-project and repository-to-DevOps-app/group mappings in `application-mappings.json` under `%LOCALAPPDATA%\DevTaskConsole` (or `DEVTASK_DATA_DIR` when configured). The mapping is used when creating merge requests from a workspace. The snapshot only probes GitLab/DevOps connectivity for the connection-status page; it does not fetch merge requests, build records, or branch lists. Unmapped repositories are not guessed. Release writes remain disabled.

The Crons page reads each requirement workspace's `.codebuddy/scheduled_tasks.json` and stores explicit task owner/mode mappings in `cron-mappings.json`. Task intent is never inferred from prompt text. Editing, pausing, deleting, and execution-history views remain unavailable until the installed CodeBuddy scheduled-task API and execution record shapes are verified; saving a local mapping does not restore or enable a scheduled task.

Workspace initialization jobs and their bounded logs are persisted in `workspace-initialization-jobs.json`. After a server restart, jobs that were still marked running are surfaced as interrupted with an explicit unknown-process-state message; the console does not claim that their child process resumed.

The Instances page can explicitly start or take over a Story's local CodeBuddy HTTP service. The server persists Story/port/workspace reservations in `story-services.json`, starts `codebuddy --serve` on loopback with `--auth none`, and checks the service health before reporting success. At server startup, previously registered services are checked and unhealthy services retry on the same port with 5/15/30-second backoff. Job listing/creation, transcript, SSE output, reply, stop, respawn, and delete are proxied through authenticated console routes; browsers never choose or access an upstream port. Service-level stop/delete and port release are not yet available. The upstream `--auth none` service is reachable by other local processes; the console token does not protect it.

## Validation

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Run the production server after building with `pnpm start`.
