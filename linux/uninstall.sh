#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
SETUP_CONFIG_DIR="$HOME/.config/pxpipe-setup"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
FISH_FILE="$HOME/.config/fish/conf.d/pxpipe-aliases.fish"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now pxpipe.service pxpipe-chatgpt.service 2>/dev/null || true
  rm -f "$SYSTEMD_USER_DIR/pxpipe.service" "$SYSTEMD_USER_DIR/pxpipe-chatgpt.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [[ -r "$SETUP_CONFIG_DIR/agents.tsv" ]]; then
  while IFS='|' read -r cmd alias_name _ _ _ _; do
    [[ -z "$cmd" || "$cmd" == \#* ]] && continue
    rm -f "$BIN_DIR/$alias_name"
  done < "$SETUP_CONFIG_DIR/agents.tsv"
fi

if [[ -r "$SETUP_CONFIG_DIR/claude-accounts.json" ]] && command -v node >/dev/null 2>&1; then
  while IFS= read -r acc_cmd; do
    [[ -n "$acc_cmd" ]] && rm -f "$BIN_DIR/$acc_cmd"
  done < <(node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const a of data.accounts || []) {
  if (a.alias) console.log(a.alias);
  if (a.pxpipeAlias) console.log(a.pxpipeAlias);
}
' "$SETUP_CONFIG_DIR/claude-accounts.json" 2>/dev/null || true)
fi

rm -f "$BIN_DIR/cdev" "$BIN_DIR/cvex" "$BIN_DIR/cpro" "$BIN_DIR/pcdev" "$BIN_DIR/pcvex" "$BIN_DIR/pcpro"
rm -f "$BIN_DIR/claude-accounts" "$BIN_DIR/pxpipe-wrap" "$BIN_DIR/pxpipe" "$FISH_FILE"
rm -rf "$SETUP_CONFIG_DIR"

strip_rc_block() {
  local rc_file="$1"
  [[ -f "$rc_file" ]] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("node:fs");
const file = process.argv[1];
const start = "# >>> pxpipe-setup >>>";
const end = "# <<< pxpipe-setup <<<";
let text = fs.readFileSync(file, "utf8");
const re = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
text = text.replace(re, "\n").replace(/\s+$/, "") + "\n";
fs.writeFileSync(file, text);
' "$rc_file"
  fi
}

strip_rc_block "$HOME/.bashrc"
strip_rc_block "$HOME/.zshrc"

echo "[pxpipe-setup] Uninstalled wrappers, aliases, and services."
echo "[pxpipe-setup] Note: ~/.local/share/pxpipe, ~/.config/pxpipe, ~/.pxpipe, ~/.claude, and ~/.claude-profiles were preserved."
