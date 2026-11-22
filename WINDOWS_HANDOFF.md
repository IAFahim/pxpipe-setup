# Windows Agent Handoff — `pxpipe-setup`

This document is written for **AI agents running on Windows** to mirror the Linux `pxpipe` setup cleanly and verify every piece works.

---

## Copy-Paste Prompt for Windows Agents

```text
Clone https://github.com/IAFahim/pxpipe-setup.git (for example into $HOME\GitHub\pxpipe-setup), read WINDOWS_HANDOFF.md and windows\install.ps1, and set up pxpipe on this Windows PC:
1. Ensure Node.js >= 22.15 is installed (required on Windows so pxpipe warp can export Windows root certificates via tls.getCACertificates('system')).
2. Run windows\install.ps1 to install pxpipe-proxy, start the local pxpipe background proxies on 127.0.0.1:47821 and 127.0.0.1:47822, and wire p-prefixed commands/functions (pagy, pclaude, pcodex, pomp, plus multi-account Claude aliases cdev/pcdev, cvex/pcvex, cpro/pcpro and any other installed pxpipe-supported AI CLIs like gemini, opencode, cursor-agent, kilo, pi) with their full auto-approve/yolo flags.
3. Verify any Windows-installed AI CLIs not on the default PATH (e.g. winget, scoop, AppData, ~/.local/bin, npm global) are detected and wrapped properly (handling .exe vs .cmd/.ps1 shims).
4. Verify ports 47821 and 47822 are listening, http://127.0.0.1:47821/ responds 200, and run non-destructive smoke tests (--version / --help) on every installed p<cli> alias in both PowerShell and cmd.exe.
```

---

## Architecture & Why Every Piece Exists

### 1. Dual-Port Proxy Layout (`47821` + `47822`)

`pxpipe warp` intercepts HTTPS requests per-process via an ephemeral CONNECT proxy and forwards matched inference endpoints to a persistent local `pxpipe` daemon:

- **Port `47821` (main proxy + dashboard):**
  - Handles Anthropic (`api.anthropic.com/v1/messages*`), Google (`daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com`, `generativelanguage.googleapis.com`), and OpenAI API key (`api.openai.com/v1/responses*`, `/v1/chat/completions*`).
  - Serves the live web dashboard at `http://127.0.0.1:47821/`.
- **Port `47822` (ChatGPT Codex subscription upstream):**
  - Runs `pxpipe` with `OPENAI_UPSTREAM=https://chatgpt.com` and separate session state (`%USERPROFILE%\.pxpipe\session-state-chatgpt.json`), sharing `%USERPROFILE%\.pxpipe\events.jsonl`.
  - **Why this is required:** When `codex` authenticates with ChatGPT OAuth (`auth_mode = "chatgpt"` in `~/.codex/auth.json`), it calls `https://chatgpt.com/backend-api/codex/responses`. A single `pxpipe` process only has one `OPENAI_UPSTREAM` (defaulting to `https://api.openai.com`), so `/backend-api/codex/responses` would 404 on port `47821`. Routing `chatgpt.com/backend-api/codex/responses*` to `127.0.0.1:47822` makes both ChatGPT OAuth Codex and OpenAI API-key clients work seamlessly.

### 2. Model Allowlist (`%USERPROFILE%\.config\pxpipe\config.json`)

[`config/pxpipe-config.json`](config/pxpipe-config.json) enables:

- `claude-fable-5` (matches `claude-fable-5`, `5-1`, `5-2`)
- `claude-opus-5-5`
- `gemini` (matches Gemini 3.6–3.8 Flash and Gemini 4 Argon/Hydrogen/Carbon/Neon)
- `gpt-6.1-sol` and `gpt-5.6-sol` (Codex uses `gpt-6.1-sol` in `config.toml`; without adding it here, `pxpipe` logs `skip(unsupported=gpt-6.1-sol)` and does not compress Codex requests)

### 3. Windows-Specific Pitfalls Already Handled by `windows/` Scripts

1. **Node.js >= 22.15 required for TLS trust (`src/warp/ca.ts`):**
   - On Linux, `pxpipe warp` appends `/etc/ssl/certs/ca-certificates.crt` to its leaf CA bundle.
   - On Windows, there is no PEM file on disk; `pxpipe` calls `tls.getCACertificates('system')` (introduced in Node `22.15+` / `23.10+`) to export Windows Root Store certs into `%USERPROFILE%\.pxpipe\warp-ca-bundle.pem`.
   - If Node is older than `22.15`, upgrade Node first (`winget install OpenJS.NodeJS.LTS` or `fnm` / `mise` / `nvm-windows`) so non-pxpipe HTTPS calls inside wrapped agents do not fail TLS verification.
2. **`.cmd` / `.bat` / `.ps1` shims vs `.exe` (`src/warp/resolve.ts`):**
   - `pxpipe warp` uses Node `child_process.spawn()` directly, which on Windows can run `.exe` / `.com` directly, **not** `.cmd` / `.bat` npm shims.
   - `windows\pxpipe-wrap.ps1` resolves the real target via `Get-Command` and automatically wraps `.cmd` / `.bat` targets as `cmd.exe /c <path>` while running `.exe` targets directly.
3. **PowerShell aliases vs functions + `cmd.exe` support:**
   - PowerShell `Set-Alias` cannot bind flags like `--dangerously-skip-permissions` or `--yolo`, so `windows\install.ps1` generates PowerShell functions in `%USERPROFILE%\.config\pxpipe-setup\aliases.ps1` and sources them from both:
     - `Documents\PowerShell\Microsoft.PowerShell_profile.ps1` (PowerShell 7+)
     - `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` (Windows PowerShell 5.1)
   - It also creates `.cmd` wrappers in `%USERPROFILE%\.local\bin\p<cli>.cmd` and adds `%USERPROFILE%\.local\bin` to User `PATH`, so `pagy`, `pclaude`, `pcodex`, `pomp` work from `cmd.exe`, Rider/VS Code integrated terminals, and other AI agents' shell calls.
4. **Silent background proxy startup (`windows\start-pxpipe.ps1`):**
   - Uses `node` with `{ detached: true, windowsHide: true }` so proxies run silently without popping up terminal windows or hitting `cmd.exe set VAR=val ` trailing-space bugs.
   - Registers a logon Scheduled Task (`pxpipe-setup-autostart`) with a Startup-folder `.vbs` fallback.

---

## Agent Checklist on Windows

1. **Check Node & npm:**
   ```powershell
   node -v   # must be >= v22.15.0 (ideally v24+ / v26+)
   npm -v
   ```
2. **Check which supported AI CLIs are installed on this Windows machine:**
   Check `Get-Command` for: `agy`, `claude`, `codex`, `omp`, `gemini`, `opencode`, `cursor-agent`, `kilo`, `pi`.
   - Note: If any CLI (like `agy` or `claude` or `codex`) is installed in `%LOCALAPPDATA%` or `scoop` or `mise` shims but NOT on `PATH`, add its bin directory to User `PATH` before running `windows\install.ps1` (or re-run `windows\install.ps1` afterward).
   - Check Codex's model in `%USERPROFILE%\.codex\config.toml`. If it uses a model other than `gpt-6.1-sol` / `gpt-5.6-sol` that `pxpipe` supports, add it to `%USERPROFILE%\.config\pxpipe\config.json` (note: check `pxpipe` model support before enabling unvalidated models).
   - Check if `agy` on Windows launches from a desktop/GUI install or CLI install; confirm `agy --dangerously-skip-permissions --version` exits `0`.
3. **Run the installer:**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install.ps1
   ```
4. **Verify proxies and dashboard:**
   ```powershell
   Test-NetConnection 127.0.0.1 -Port 47821
   Test-NetConnection 127.0.0.1 -Port 47822
   Invoke-WebRequest -Uri http://127.0.0.1:47821/ -UseBasicParsing | Select-Object StatusCode
   ```
5. **Verify installed `p*` wrappers in a fresh shell:**
   - Open a new PowerShell window and run `--version` on each installed alias:
     ```powershell
     pagy --version
     pclaude --version
     pcodex --version
     pomp --version
     ```
   - Verify `pxpipe warp` CA bundle was generated cleanly with Windows system roots:
     ```powershell
     Get-Item "$env:USERPROFILE\.pxpipe\warp-ca*.pem"
     ```
   - If you also use WSL2 on that Windows PC, run `bash linux/install.sh` inside WSL2 separately (`localhost` ports are not automatically shared identically across all WSL networking modes, and Linux needs Linux ELF binaries + `/etc/ssl/certs/ca-certificates.crt`).
6. **Check `pxpipe` flag mapping per CLI (already encoded in `config/agents.json`):**
   - `pagy` → `agy --dangerously-skip-permissions`
   - `pclaude` → `claude --dangerously-skip-permissions`
   - `pcodex` → `codex --yolo`
   - `pomp` → `omp --auto-approve`
   - `pgemini` → `gemini --yolo`
   - `popencode` → `opencode --auto`
   - `pcursor-agent` → `cursor-agent --yolo --trust`
   - `pkilo` → `kilo --auto`
   - `ppi` → `pi`
   - `cdev` / `pcdev`, `cvex` / `pcvex`, `cpro` / `pcpro` → isolated Claude Code account wrappers (all add `--dangerously-skip-permissions`; `pc*` routes through `pxpipe warp`, `c*` connects directly). Run `claude-accounts status` or `claude-accounts setup` to check/bind which account owns `%USERPROFILE%\.claude` on that PC.

---

## Troubleshooting on Windows

- **PowerShell execution policy blocks `$PROFILE`:**
  Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once in PowerShell.
- **`pxpipe` logs `skip(unsupported=...)` for Codex:**
  Check `%USERPROFILE%\.config\pxpipe\config.json` includes the active Codex model (e.g., `"gpt-6.1-sol"`).
- **Antivirus / Corporate TLS errors inside wrapped CLIs:**
  Confirm `node -v` is `>= 22.15` and verify `%USERPROFILE%\.pxpipe\warp-ca-bundle.pem` is larger than a couple KB (meaning Windows root certificates were appended). Delete `%USERPROFILE%\.pxpipe\warp-ca-bundle.pem` and re-run a wrapped command to regenerate it.
- **Check proxy logs:**
  Inspect `%USERPROFILE%\.pxpipe\pxpipe-47821.log` and `%USERPROFILE%\.pxpipe\pxpipe-47822.log`, or run `pxpipe stats`.
