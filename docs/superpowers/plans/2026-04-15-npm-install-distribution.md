# NPM Install Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users install and run Super Ask with `npm install -g` or `npx` without cloning the repository, while preserving Web UI serving, rule deployment, and the existing Node CLI flow.

**Architecture:** Publish a root-level npm package that keeps the current repo-like runtime layout (`server/dist`, `server/static`, `rules`, `cli`) so the existing static-file and template-loading paths stay predictable. Remove the rule/template dependency on `install.sh` by rendering a package-safe daemon start command from `DeployManager`, while keeping source installs working.

**Tech Stack:** npm, Node.js 18+, tsup, Vite, Node CLI, TypeScript server/UI build.

---

## Scope And Constraints

- Public install target is a root-level npm package, not a bare `server/` subpackage.
- Public runtime entry is `super-ask start --daemon|status|stop`; `install.sh` stays as a source-install helper, not part of the packaged runtime contract.
- Non-goal for this phase: changing the Super Ask HTTP protocol or agent-facing request format.
- Non-goal for this phase: changing the Super Ask HTTP protocol or agent-facing request format.

## Evidence Driving The Design

- `server/src/server.ts` resolves runtime paths from the compiled entrypoint at `server/dist/index.js`:
  - `../static` resolves to `server/static`
  - `../../` resolves to the package root
- `server/src/deployManager.ts` reads `rules/` and injects absolute paths for:
  - `cli/super-ask.js`
  - `install.sh`
- `ui/vite.config.ts` builds the UI into `server/static`
- Current rules and `rules/super-ask-opencode-tool.ts` still tell agents to start the server with `bash "{{SUPER_ASK_INSTALL_SH}}"`, which is source-layout-specific and not a good packaged-install contract

## Recommended Distribution Layout

Keep the published tarball root aligned with the current repository root:

```text
<package-root>/
  package.json
  README.md
  server/
    dist/
    static/
  rules/
  cli/
    super-ask.js
  install.sh         # optional; source-install helper only
```

This layout preserves all current runtime assumptions:

- `server/dist/index.js` can still resolve `../static` to `server/static`
- `server/dist/index.js` can still resolve `../../` to the package root
- `DeployManager` can still read `rules/`, `cli/`, and other packaged assets from a single root

## Alternative Rejected

Publishing only the `server/` subdirectory is not the recommended first path because it would require additional runtime path changes or asset copying for `rules/`, `cli/`, and `install.sh` before template deployment can work.

---

### Task 1: Define The Public Package Contract

**Files:**
- Create: `package.json`
- Modify: `server/package.json`
- Test: `npm pack --json`

- [ ] **Step 1: Create the root npm manifest**

Add a root `package.json` that owns the published package contract:

```json
{
  "name": "super-ask",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "bin": {
    "super-ask": "server/dist/index.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "ws": "^8.0.0"
  }
}
```

- [ ] **Step 2: Whitelist the packaged runtime assets**

Add a `files` whitelist so the published tarball contains exactly the runtime payload:

```json
{
  "files": [
    "server/dist/**",
    "server/static/**",
    "rules/**",
    "cli/**",
    "README.md"
  ]
}
```

- [ ] **Step 3: Prevent metadata drift between root and `server/package.json`**

Convert `server/package.json` into an internal build manifest so it no longer competes with the root package as the public distribution entry, but keep the current server build dependencies in place for `npm --prefix server ci`:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "tsup": "^8.0.0",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.0.0"
  }
}
```

Remove the public-package-only fields (`name`, `version`, `bin`) from `server/package.json`; do not delete the build/runtime dependency blocks until the release build is moved fully to the root package.

- [ ] **Step 4: Verify the tarball contract before touching deployment logic**

Run:

```bash
npm pack --json
```

Expected:

- the tarball contains `server/dist/index.js`
- the tarball contains `server/static/index.html` and hashed assets
- the tarball contains `rules/` and `cli/super-ask.js`

---

### Task 2: Make Rule Rendering Package-Safe

**Files:**
- Modify: `server/src/deployManager.ts`
- Modify: `rules/super-ask-cursor.mdc`
- Modify: `rules/super-ask-copilot.md`
- Modify: `rules/super-ask-codex.md`
- Modify: `rules/super-ask-qwen.md`
- Modify: `rules/super-ask-opencode.md`
- Modify: `rules/super-ask-opencode-tool.ts`
- Test: `server/deployManager-path-render.test.ts`

- [ ] **Step 1: Add an explicit packaged-start placeholder**

Extend `renderRuleTemplate()` so templates can reference a package-safe daemon start command without assuming `install.sh` exists in packaged installs:

```ts
const serverBin = join(this.projectRoot, "server", "dist", "index.js");
const startCmd = `node "${serverBin}" start --daemon --port 19960`;
const replacements = new Map<string, string>([
  ["{{SUPER_ASK_ROOT}}", this.projectRoot],
  ["{{SUPER_ASK_CLI}}", join(this.projectRoot, "cli", "super-ask.js")],
  ["{{SUPER_ASK_SERVER_BIN}}", serverBin],
  ["{{SUPER_ASK_START_CMD}}", startCmd]
]);
```

- [ ] **Step 2: Update rule templates to prefer the packaged start command**

Replace source-only startup guidance such as:

```md
确保 super-ask server 已启动（运行 `bash "{{SUPER_ASK_INSTALL_SH}}"`）
```

with package-safe guidance such as:

```md
确保 super-ask server 已启动（运行 `{{SUPER_ASK_START_CMD}}`）
```

Remove `install.sh` from packaged-runtime guidance entirely. Source-install instructions can stay in `README.md`.

- [ ] **Step 3: Update the OpenCode tool install hint**

Replace the hard-coded shell hint:

```ts
const INSTALL_HINT = `bash "{{SUPER_ASK_INSTALL_SH}}"`;
```

with:

```ts
const INSTALL_HINT = `{{SUPER_ASK_START_CMD}}`;
```

- [ ] **Step 4: Lock the new placeholders with render tests**

Add path-render assertions to `server/deployManager-path-render.test.ts`:

```ts
assert.match(rendered, /server\/dist\/index\.js/);
assert.match(rendered, /start --daemon --port 19960/);
assert.doesNotMatch(rendered, /\{\{SUPER_ASK_/);
```

Run:

```bash
npm --prefix server test
```

If no server test script exists yet, run the targeted test command already used in the repo for `.test.ts` files and confirm the new render assertions pass.

---

### Task 3: Build And Publish Pipeline

**Files:**
- Create: `scripts/build-release.sh`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add a deterministic release build script**

Create a single release build script that always builds the runtime assets in the correct order:

```bash
#!/bin/bash
set -euo pipefail

npm --prefix ui ci
npm --prefix server ci
npm --prefix ui run build
npm --prefix server run build
```

- [ ] **Step 2: Wire the build script into publish lifecycle**

Add root scripts:

```json
{
  "scripts": {
    "build:release": "bash ./scripts/build-release.sh",
    "prepublishOnly": "npm run build:release",
    "pack:smoke": "npm pack --json"
  }
}
```

- [ ] **Step 3: Document the public install path**

Update `README.md` so npm install becomes a first-class install mode:

````md
## npm 安装

```bash
npm install -g super-ask
super-ask start --daemon
```

如需一次性运行，也可以使用：

```bash
npx super-ask start --daemon
```
````

Also keep a separate “from source” section that continues to describe `git clone` + `bash install.sh`.

---

### Task 4: Smoke-Test The Installed Package

**Files:**
- Create: `scripts/smoke-npm-install.sh`
- Test: packed tarball installed into a clean temp directory

- [ ] **Step 1: Add a tarball install smoke script**

Create a smoke script that:

```bash
#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TMP_HOME="$TMP_DIR/home"
PACK_JSON="$(cd "$REPO_ROOT" && npm pack --json)"
TARBALL="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(data[0].filename);' <<<"$PACK_JSON")"

cleanup() {
  if [ -d "$TMP_DIR" ]; then
    (cd "$TMP_DIR" && HOME="$TMP_HOME" npx super-ask stop >/dev/null 2>&1 || true)
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME"

pushd "$TMP_DIR" >/dev/null
npm init -y >/dev/null
npm install "$REPO_ROOT/$TARBALL"
HOME="$TMP_HOME" npx super-ask start --daemon --port 19961

HEALTH_OK=0
for i in $(seq 1 10); do
  if node -e "fetch('http://127.0.0.1:19961/health').then(async (r) => { if (!r.ok) process.exit(1); console.log(await r.text()); }).catch(() => process.exit(1))"; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "super-ask health check did not become ready on :19961" >&2
  exit 1
fi

popd >/dev/null
```

- [ ] **Step 2: Verify packaged static assets are actually served**

After the health check, fetch `/` and confirm HTML is returned:

```bash
node -e "fetch('http://127.0.0.1:19961/').then(async (r) => { const html = (await r.text()).toLowerCase(); if (!html.includes('<!doctype html')) process.exit(1); }).catch(() => process.exit(1))"
```

- [ ] **Step 3: Verify deploy-time assets are present in the installed package**

Add checks inside the smoke script for:

```bash
test -f node_modules/super-ask/rules/super-ask-codex.md
test -f node_modules/super-ask/cli/super-ask.js
test -f node_modules/super-ask/server/static/index.html
test -f "$TMP_HOME/.super-ask/super-ask.pid"
```

Expected:

- all files exist
- `npx super-ask start --daemon` succeeds
- `/health` returns `{"status":"ok", ...}`
- the packaged smoke run writes PID/config state under the temporary HOME, not the developer's real `~/.super-ask`

- [ ] **Step 4: Verify one real deployed rule renders the packaged start command**

With the smoke-test server still running, deploy a Codex user-scoped rule into the isolated HOME and assert the rendered file references the packaged daemon start command instead of `install.sh`:

```bash
TMP_HOME="$TMP_HOME" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const tmpHome = process.env.TMP_HOME;
  const token = fs.readFileSync(path.join(tmpHome, ".super-ask", "token"), "utf8").trim();
  const response = await fetch("http://127.0.0.1:19961/api/deploy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Super-Ask-Token": token,
    },
    body: JSON.stringify({ platforms: ["codex"], workspacePath: "", scope: "user" }),
  });
  console.log(await response.text());
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

TMP_HOME="$TMP_HOME" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const agents = path.join(process.env.TMP_HOME, ".codex", "AGENTS.md");
const text = fs.readFileSync(agents, "utf8");
if (!text.includes("server/dist/index.js")) process.exit(1);
if (!text.includes("start --daemon --port 19960")) process.exit(1);
if (text.includes("install.sh")) process.exit(1);
NODE
```

---

### Task 5: Rollout And Compatibility

**Files:**
- Modify: `README.md`
- Modify: `rules/*`
- Modify: release notes or migration notes file if the repo uses one

- [ ] **Step 1: Call out the Node-only CLI dependency**

Document this explicitly:

```md
npm 安装解决的是“无需 clone 源码仓库”；如果 Agent 规则通过 `cli/super-ask.js` 调用 Super Ask，用户机器只需要 `node`。
```

- [ ] **Step 2: Document the canonical start path**

State that packaged installs should use:

```bash
super-ask start --daemon
super-ask status
super-ask stop
```

and that `install.sh` is now source-install-only documentation, not the packaged-install bootstrap.

Apply the same guidance to shipped generic docs such as `rules/super-ask.md`: packaged installs should point to `super-ask start --daemon`, while any `install.sh` mention must live only inside a clearly labeled source-install subsection.

- [ ] **Step 3: Add a migration note for already-deployed rules**

Call out that users who previously deployed rules from source should redeploy once so their injected startup instructions switch from `install.sh`-centric guidance to the packaged-safe start command.

---

## Verification Checklist

- `npm pack --json` contains the intended runtime payload and no missing critical assets
- tarball install smoke test can start the service and return `/health`
- packaged install serves `/` from `server/static`
- smoke test uses an isolated HOME so it does not reuse or overwrite the real `~/.super-ask`
- a real deploy run writes a rendered rule that references `server/dist/index.js` / `start --daemon` and not `install.sh`
- rendered rules contain no unresolved `{{SUPER_ASK_*}}` placeholders
- rules no longer depend on `install.sh` for packaged startup
- README has both npm-install and source-install flows
- Python dependency remains documented, not silently assumed

## Recommended Execution Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5

## Open Questions To Resolve During Implementation

- Is the npm package name `super-ask` available, or does it need a scoped name such as `@super-ask/cli`?
- Do we want to keep shipping `install.sh` inside the package for backwards compatibility, or keep it source-only once rule templates stop referencing it?
