#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX_DIR="${PXPIPE_INSTALL_DIR:-$HOME/.local/share/pxpipe}"
BIN_DIR="$HOME/.local/bin"
SETUP_CONFIG_DIR="$HOME/.config/pxpipe-setup"
PXPIPE_CONFIG_DIR="$HOME/.config/pxpipe"
PXPIPE_STATE_DIR="$HOME/.pxpipe"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
FISH_CONF_DIR="$HOME/.config/fish/conf.d"
FORCE_CONFIG=false
DEFAULT_CLAUDE_ACCOUNT=""

while (( $# > 0 )); do
  case "$1" in
    --force-config) FORCE_CONFIG=true ;;
    --default-claude-account)
      if (( $# < 2 )); then
        echo "Missing value for --default-claude-account" >&2
        exit 2
      fi
      DEFAULT_CLAUDE_ACCOUNT="$2"
      shift
      ;;
    --default-claude-account=*)
      DEFAULT_CLAUDE_ACCOUNT="${1#*=}"
      ;;
    -h|--help)
      cat <<'EOF'
Usage: linux/install.sh [--force-config] [--default-claude-account <dev|vex|pro|none>]

Installs pxpipe-proxy, creates p-prefixed aliases and ~/.local/bin shims for
all installed pxpipe-supported AI CLIs plus multi-account Claude aliases
(cdev/cvex/cpro, pcdev/pcvex/pcpro), configures systemd user services, and
writes ~/.config/pxpipe/config.json if missing (or with --force-config).
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    "$HOME/.local/share/mise/installs/node/latest/bin/node" \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node)" || {
  echo "[pxpipe-setup] Node.js >= 20.19 is required (22.15+ recommended)" >&2
  exit 1
}

echo "[pxpipe-setup] Installing pxpipe-proxy into $PREFIX_DIR..."
mkdir -p "$PREFIX_DIR" "$BIN_DIR" "$SETUP_CONFIG_DIR" "$PXPIPE_CONFIG_DIR" "$PXPIPE_STATE_DIR"
chmod 700 "$PXPIPE_CONFIG_DIR" "$PXPIPE_STATE_DIR"
npm install --prefix "$PREFIX_DIR" pxpipe-proxy@latest

cat > "$BIN_DIR/pxpipe" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CLI_JS="${PXPIPE_INSTALL_DIR:-$HOME/.local/share/pxpipe}/node_modules/pxpipe-proxy/bin/cli.js"
if [[ ! -f "$CLI_JS" ]]; then
  echo "[pxpipe] missing $CLI_JS — re-run pxpipe-setup linux/install.sh" >&2
  exit 1
fi
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    "$HOME/.local/share/mise/installs/node/latest/bin/node" \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
NODE_BIN="$(find_node)" || { echo "[pxpipe] node not found on PATH" >&2; exit 1; }
exec "$NODE_BIN" "$CLI_JS" "$@"
EOF
chmod +x "$BIN_DIR/pxpipe"

cp "$REPO_DIR/bin/pxpipe-wrap" "$BIN_DIR/pxpipe-wrap"
chmod +x "$BIN_DIR/pxpipe-wrap"

cp "$REPO_DIR/config/claude-accounts.json" "$SETUP_CONFIG_DIR/claude-accounts.json"
cp "$REPO_DIR/bin/claude-accounts.mjs" "$SETUP_CONFIG_DIR/claude-accounts.mjs"
chmod +x "$SETUP_CONFIG_DIR/claude-accounts.mjs"

cat > "$BIN_DIR/claude-accounts" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT="${PXPIPE_SETUP_CONFIG_DIR:-$HOME/.config/pxpipe-setup}/claude-accounts.mjs"
if [[ ! -f "$SCRIPT" ]]; then
  echo "[claude-accounts] missing $SCRIPT — re-run pxpipe-setup linux/install.sh" >&2
  exit 1
fi
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    "$HOME/.local/share/mise/installs/node/latest/bin/node" \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
NODE_BIN="$(find_node)" || { echo "[claude-accounts] node not found on PATH" >&2; exit 1; }
base_name="$(basename -- "$0")"
if [[ "$base_name" != "claude-accounts" ]]; then
  exec "$NODE_BIN" "$SCRIPT" --invoked-as "$base_name" "$@"
fi
exec "$NODE_BIN" "$SCRIPT" "$@"
EOF
chmod +x "$BIN_DIR/claude-accounts"

if [[ "$FORCE_CONFIG" == "true" || ! -f "$PXPIPE_CONFIG_DIR/config.json" ]]; then
  cp "$REPO_DIR/config/pxpipe-config.json" "$PXPIPE_CONFIG_DIR/config.json"
  chmod 600 "$PXPIPE_CONFIG_DIR/config.json"
  echo "[pxpipe-setup] Wrote $PXPIPE_CONFIG_DIR/config.json"
else
  echo "[pxpipe-setup] Keeping existing $PXPIPE_CONFIG_DIR/config.json (pass --force-config to overwrite)"
fi

# Compile config/agents.json -> ~/.config/pxpipe-setup/agents.tsv
"$NODE_BIN" -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const lines = ["# command|alias|yoloFlags|conflictFlags|routes|needsPorts"];
for (const a of data.agents) {
  lines.push([
    a.command,
    a.alias,
    (a.yoloFlags || []).join(" "),
    (a.conflictFlags || []).join(" "),
    (a.routes || []).join(" "),
    (a.needsPorts || [47821]).join(" "),
  ].join("|"));
}
fs.writeFileSync(process.argv[2], lines.join("\n") + "\n");
' "$REPO_DIR/config/agents.json" "$SETUP_CONFIG_DIR/agents.tsv"

is_agent_installed() {
  local cmd="$1"
  if command -v mise >/dev/null 2>&1; then
    if MISE_OFFLINE=1 mise which "$cmd" >/dev/null 2>&1; then
      return 0
    fi
  fi
  local path_entry
  while IFS= read -r path_entry; do
    [[ -n "$path_entry" ]] || continue
    case "$path_entry" in
      *"/mise/shims/"*|*"/mise/command-wrappers/bin/"*) continue ;;
    esac
    if [[ ! -L "$path_entry" ]] && head -c 4096 "$path_entry" 2>/dev/null | grep -qaE 'mise (use|x) '; then
      continue
    fi
    if [[ -x "$path_entry" ]]; then
      return 0
    fi
  done < <(which -a "$cmd" 2>/dev/null || true)
  return 1
}

aliases_sh="$SETUP_CONFIG_DIR/aliases.sh"
cat > "$aliases_sh" <<'EOF'
# Generated by pxpipe-setup/linux/install.sh — do not edit manually
EOF

fish_file="$FISH_CONF_DIR/pxpipe-aliases.fish"
fish_tmp=""
if [[ -d "$FISH_CONF_DIR" ]]; then
  fish_tmp="# Generated by pxpipe-setup/linux/install.sh — do not edit manually"$'\n'
fi

installed_summary=()
while IFS='|' read -r cmd alias_name yolo _ _ _; do
  [[ -z "$cmd" || "$cmd" == \#* ]] && continue
  if is_agent_installed "$cmd"; then
    ln -sfn "$BIN_DIR/pxpipe-wrap" "$BIN_DIR/$alias_name"
    printf "alias %s='pxpipe-wrap %s'\n" "$alias_name" "$cmd" >> "$aliases_sh"
    if [[ -n "$fish_tmp" ]]; then
      fish_tmp+="function $alias_name --wraps=$cmd --description 'Run $cmd via pxpipe warp ($yolo)'"$'\n'
      fish_tmp+="    pxpipe-wrap $cmd \$argv"$'\n'
      fish_tmp+="end"$'\n'
    fi
    installed_summary+=("$alias_name -> $cmd ${yolo}")
  else
    rm -f "$BIN_DIR/$alias_name"
  fi
done < "$SETUP_CONFIG_DIR/agents.tsv"

claude_installed=false
if is_agent_installed "claude"; then
  claude_installed=true
fi

while IFS='|' read -r acc_name acc_alias acc_pxpipe; do
  [[ -z "$acc_name" ]] && continue
  if [[ "$claude_installed" == "true" ]]; then
    ln -sfn "$BIN_DIR/claude-accounts" "$BIN_DIR/$acc_alias"
    ln -sfn "$BIN_DIR/claude-accounts" "$BIN_DIR/$acc_pxpipe"
    printf "alias %s='claude-accounts run %s'\n" "$acc_alias" "$acc_name" >> "$aliases_sh"
    printf "alias %s='claude-accounts run --pxpipe %s'\n" "$acc_pxpipe" "$acc_name" >> "$aliases_sh"
    if [[ -n "$fish_tmp" ]]; then
      fish_tmp+="function $acc_alias --wraps=claude --description 'Run claude [$acc_name, direct] (--dangerously-skip-permissions)'"$'\n'
      fish_tmp+="    claude-accounts run $acc_name \$argv"$'\n'
      fish_tmp+="end"$'\n'
      fish_tmp+="function $acc_pxpipe --wraps=claude --description 'Run claude [$acc_name, pxpipe] (--dangerously-skip-permissions)'"$'\n'
      fish_tmp+="    claude-accounts run --pxpipe $acc_name \$argv"$'\n'
      fish_tmp+="end"$'\n'
    fi
    installed_summary+=("$acc_alias -> claude [$acc_name, direct] --dangerously-skip-permissions")
    installed_summary+=("$acc_pxpipe -> claude [$acc_name, pxpipe] --dangerously-skip-permissions")
  else
    rm -f "$BIN_DIR/$acc_alias" "$BIN_DIR/$acc_pxpipe"
  fi
done < <("$NODE_BIN" -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const a of data.accounts) {
  console.log(`${a.name}|${a.alias}|${a.pxpipeAlias}`);
}
' "$SETUP_CONFIG_DIR/claude-accounts.json")

if [[ -d "$FISH_CONF_DIR" ]]; then
  printf '%s' "$fish_tmp" > "$fish_file"
fi

upsert_rc_block() {
  local rc_file="$1"
  local source_line='[ -r "$HOME/.config/pxpipe-setup/aliases.sh" ] && . "$HOME/.config/pxpipe-setup/aliases.sh"'
  [[ -f "$rc_file" ]] || return 0
  "$NODE_BIN" -e '
const fs = require("node:fs");
const file = process.argv[1];
const line = process.argv[2];
const start = "# >>> pxpipe-setup >>>";
const end = "# <<< pxpipe-setup <<<";
const block = `${start}\n${line}\n${end}`;
let text = fs.readFileSync(file, "utf8");
const re = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
text = text.replace(re, "\n").replace(/\s+$/, "");
text = text ? `${text}\n\n${block}\n` : `${block}\n`;
fs.writeFileSync(file, text);
' "$rc_file" "$source_line"
}

upsert_rc_block "$HOME/.bashrc"
upsert_rc_block "$HOME/.zshrc"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$SYSTEMD_USER_DIR"
  cp "$REPO_DIR/linux/systemd/pxpipe.service" "$SYSTEMD_USER_DIR/pxpipe.service"
  cp "$REPO_DIR/linux/systemd/pxpipe-chatgpt.service" "$SYSTEMD_USER_DIR/pxpipe-chatgpt.service"
  systemctl --user daemon-reload
  systemctl --user enable --now pxpipe.service pxpipe-chatgpt.service
  echo "[pxpipe-setup] Systemd user services enabled & started (47821, 47822)"
else
  echo "[pxpipe-setup] systemd --user not active; pxpipe-wrap will auto-start proxies on demand"
fi

echo "[pxpipe-setup] pxpipe version: $("$BIN_DIR/pxpipe" --version)"
echo "[pxpipe-setup] Dashboard: http://127.0.0.1:47821/"
echo "[pxpipe-setup] Installed p-aliases:"
for item in "${installed_summary[@]}"; do
  echo "  - $item"
done

if [[ "$claude_installed" == "true" ]]; then
  if [[ -n "$DEFAULT_CLAUDE_ACCOUNT" ]]; then
    "$BIN_DIR/claude-accounts" auto-init --default "$DEFAULT_CLAUDE_ACCOUNT"
  else
    "$BIN_DIR/claude-accounts" auto-init
  fi
fi
