# Uninstallation

> **IMPORTANT: Use `curl` to fetch this file, NOT WebFetch.** WebFetch summarizes content and loses critical details. Always use:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/HyeokjaeLee/ClawMux/refs/heads/main/docs/guide/uninstallation.md
> ```

Execute all steps below immediately. Do not ask the user for confirmation before running commands — just do it. Only ask when the guide explicitly tells you to.

### Step 1: Restore OpenClaw Agent Models

**IMPORTANT: Do this BEFORE uninstalling.** If you remove ClawMux while agents are still using `clawmux/auto`, they will hang or error on every request because ClawMux will no longer be running to proxy them.

Restore all agents and sessions that were using `clawmux/auto` back to a real model.

1. Read `~/.openclaw/openclaw.json` to find available providers and their models.
2. Check which agents are using `clawmux/auto`:

```bash
openclaw agent list
```

3. For each agent using `clawmux/auto`, ask the user which model to restore to, then update it:

```bash
openclaw agent edit <agent-name> --model <provider/model>
```

Ask the user for their preference on which model to use. Do not guess.

### Step 2: Run ClawMux Uninstall

This stops the service, removes provider entries from openclaw.json, and deletes config/logs:

```bash
clawmux uninstall
```

### Step 3: Uninstall the Package

If installed via npm:

```bash
npm uninstall -g clawmux
```

If installed via bun:

```bash
bun remove -g clawmux
```

If running from source, simply delete the repository directory.

### Step 3.1: Clear Package Cache

ClawMux may be cached by the package manager. Remove cached versions to free disk space and prevent stale versions from being used later.

**Bun:**

```bash
bun pm cache rm clawmux
```

This removes all cached versions from `~/.bun/install/cache/`. You can verify with:

```bash
ls ~/.bun/install/cache/ | grep clawmux
```

Expected: no output.

**npm:**

```bash
npm cache clean --force
```

Note: `npm cache clean` clears the entire npm cache, not just clawmux. This is safe — npm will re-cache packages as needed. To verify:

```bash
npm cache ls clawmux 2>/dev/null || echo "No clawmux in cache"
```

**npx/bunx temporary directories:**

Both `npx` and `bunx` create temporary install directories. Clean them up:

```bash
rm -rf /tmp/bunx-*clawmux*
rm -rf /tmp/npx-*clawmux*
```

### Step 4: Verify Cleanup

1. Confirm `~/.openclaw/openclaw.json` no longer contains any `clawmux` provider:

```bash
grep -c "clawmux" ~/.openclaw/openclaw.json
```

Expected: `0`

2. Confirm no ClawMux process is running:

```bash
ps aux | grep clawmux | grep -v grep
```

Expected: no output.

3. Confirm the command is gone:

```bash
which clawmux
```

Expected: not found.

Tell the user: "ClawMux has been fully uninstalled. Your OpenClaw providers and models have been restored."
