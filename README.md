# pxpipe-setup

Automated setup for [teamchong/pxpipe](https://github.com/teamchong/pxpipe) with **`p`-prefixed aliases and full-permission wrappers** for every supported AI CLI installed on the machine.

## What This Sets Up

Every supported AI CLI gets a `p<cli>` command (both as a shell alias/function and an executable shim in `~/.local/bin`) that:

1. Ensures the local `pxpipe` background proxies are running (`127.0.0.1:47821` main proxy + dashboard, and `127.0.0.1:47822` ChatGPT Codex upstream proxy).
2. Launches the CLI through `pxpipe warp` with its provider routes configured (zero base-URL overrides, so OAuth, `/remote-control`, and connectors keep working).
3. Prepends the CLI's full auto-approve / bypass permission flag unless you pass an explicit override flag on that invocation.

### Supported AI CLIs

| Command | `p`-Alias | Default Flags Added | `pxpipe warp` Routing |
| --- | --- | --- | --- |
| `agy` | `pagy` | `--dangerously-skip-permissions` | Default (`daily-cloudcode-pa.googleapis.com`) + `cloudcode-pa.googleapis.com` → `:47821` |
| `claude` | `pclaude` | `--dangerously-skip-permissions` | Default (`api.anthropic.com/v1/messages*`) → `:47821` |
| `codex` | `pcodex` | `--yolo` | `chatgpt.com/backend-api/codex/responses*` → `:47822`, `api.openai.com/v1/responses*` → `:47821` |
| `omp` | `pomp` | `--auto-approve` | Anthropic + Google + OpenAI + ChatGPT Codex routes → `:47821` / `:47822` |
| `opencode` | `popencode` | `--auto` | Default + `api.openai.com/v1/*` → `:47821` |
| `gemini` | `pgemini` | `--yolo` | Default (`generativelanguage.googleapis.com`) → `:47821` |
| `cursor-agent` | `pcursor-agent` | `--yolo --trust` | Default → `:47821` |
| `kilo` | `pkilo` | `--auto` | Default + `api.openai.com/v1/*` → `:47821` |
| `pi` | `ppi` | *(none)* | Default + `api.openai.com/v1/*` → `:47821` |

Only CLIs that are **actually installed** on the machine get `p*` aliases/shims (lazy `mise` shims that have not been installed are skipped automatically).

> **Note on other CLIs (e.g. `devin`, `mcode`):** Tools whose backends use proprietary non-Anthropic/OpenAI/Google wire protocols or unsupported models (`devin` → `api.devin.ai`, `mcode` → MiniMax M3) are intentionally left untouched because `pxpipe` cannot transform their traffic.

### Default Model Scope (`~/.config/pxpipe/config.json`)

[`config/pxpipe-config.json`](config/pxpipe-config.json) enables:

- `claude-fable-5` (covers `claude-fable-5`, `5-1`, `5-2`)
- `claude-opus-5-5`
- `gemini` (covers Gemini 3.6–3.8 Flash, Gemini 4 Argon/Hydrogen/Carbon/Neon, etc.)
- `gpt-6.1-sol`, `gpt-5.6-sol` (Codex native 14px Sol profiles)

You can toggle any model live in the dashboard at <http://127.0.0.1:47821/>.

## Linux Install (Omarchy / Arch / Ubuntu / etc.)

```bash
git clone https://github.com/IAFahim/pxpipe-setup.git ~/GitHub/pxpipe-setup
bash ~/GitHub/pxpipe-setup/linux/install.sh
```

Then open a new shell (or `source ~/.bashrc`) and run `pagy`, `pclaude`, `pcodex`, or `pomp`.

### What Linux Install Configures

- Installs `pxpipe-proxy@latest` into `~/.local/share/pxpipe` and wraps it at `~/.local/bin/pxpipe` (survives Node upgrades via `mise`).
- Installs `~/.local/bin/pxpipe-wrap` and symlinks `~/.local/bin/p<cli>` for every installed supported CLI.
- Writes `~/.config/pxpipe-setup/aliases.sh` (sourced by `~/.bashrc` and `~/.zshrc`) and `~/.config/fish/conf.d/pxpipe-aliases.fish` (if Fish is present).
- Installs & starts `systemd --user` services:
  - `pxpipe.service` (`127.0.0.1:47821` — Anthropic, OpenAI API, Google, & Dashboard)
  - `pxpipe-chatgpt.service` (`127.0.0.1:47822` — `OPENAI_UPSTREAM=https://chatgpt.com` for Codex ChatGPT OAuth)

### Uninstall (Linux)

```bash
bash ~/GitHub/pxpipe-setup/linux/uninstall.sh
```

## Windows Setup & Agent Handoff

See **[`WINDOWS_HANDOFF.md`](WINDOWS_HANDOFF.md)** for:
1. A copy-pasteable prompt for your Windows AI agents (`agy`, `claude`, `codex`, `omp`, etc.) to perform and verify the setup on Windows.
2. All Windows-specific details (`Node >= 22.15` system CA export, `.cmd`/`.bat` vs `.exe` handling in `pxpipe warp`, PowerShell `$PROFILE` + `.cmd` shims, and background autostart).
