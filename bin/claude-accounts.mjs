#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 47821;
const MAX_REQUEST_BYTES = process.env.PXPIPE_MAX_REQUEST_BYTES || "67108864";
const CONFLICT_FLAGS = [
  "--dangerously-skip-permissions",
  "--permission-mode",
  "--allow-dangerously-skip-permissions",
];

function getPaths() {
  const home = os.homedir();
  const setupDir = process.env.PXPIPE_SETUP_CONFIG_DIR || path.join(home, ".config", "pxpipe-setup");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const installedManifest = path.join(setupDir, "claude-accounts.json");
  const repoManifest = path.resolve(scriptDir, "..", "config", "claude-accounts.json");
  return {
    home,
    setupDir,
    manifestPath: fs.existsSync(installedManifest) ? installedManifest : repoManifest,
    localConfigPath: path.join(setupDir, "claude-accounts.local.json"),
    defaultClaudeDir: path.join(home, ".claude"),
    defaultClaudeJson: path.join(home, ".claude.json"),
    stateDir: process.env.PXPIPE_STATE_DIR || path.join(home, ".pxpipe"),
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadManifest(paths) {
  if (!fs.existsSync(paths.manifestPath)) {
    throw new Error(`Missing claude-accounts manifest: ${paths.manifestPath}`);
  }
  const data = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
  if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
    throw new Error(`Invalid claude-accounts manifest: ${paths.manifestPath}`);
  }
  return {
    profilesDir: data.profilesDir || ".claude-profiles",
    accounts: data.accounts,
  };
}

function loadLocalConfig(paths) {
  if (!fs.existsSync(paths.localConfigPath)) {
    return { exists: false, defaultAccount: null };
  }
  const data = readJsonIfExists(paths.localConfigPath);
  return {
    exists: true,
    defaultAccount: data && typeof data.defaultAccount === "string" ? data.defaultAccount : null,
  };
}

function saveLocalConfig(paths, defaultAccount) {
  fs.mkdirSync(paths.setupDir, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify({ defaultAccount: defaultAccount ?? null }, null, 2)}\n`;
  fs.writeFileSync(paths.localConfigPath, payload, { encoding: "utf8", mode: 0o600 });
}

function resolveAccount(manifest, token) {
  if (!token) return null;
  const needle = token.toLowerCase();
  return (
    manifest.accounts.find(
      (acc) =>
        acc.name.toLowerCase() === needle ||
        acc.alias.toLowerCase() === needle ||
        acc.pxpipeAlias.toLowerCase() === needle,
    ) || null
  );
}

function buildProfile(account, localConfig, paths, manifest) {
  const isDefault = localConfig.defaultAccount === account.name;
  const configDir = isDefault
    ? paths.defaultClaudeDir
    : path.join(paths.home, manifest.profilesDir, account.name);
  return {
    ...account,
    isDefault,
    configDir,
  };
}

function buildChildEnv(profile, extraEnv = {}) {
  const env = { ...process.env };
  // Default ~/.claude MUST keep CLAUDE_CONFIG_DIR unset so Claude reads ~/.claude.json.
  if (profile.isDefault) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = profile.configDir;
  }
  return { ...env, ...extraEnv };
}

function ensureProfileInitialized(profile, paths) {
  if (profile.isDefault) {
    return { createdDir: false, copiedSettings: false };
  }
  let createdDir = false;
  if (!fs.existsSync(profile.configDir)) {
    fs.mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
    createdDir = true;
  }
  const targetSettings = path.join(profile.configDir, "settings.json");
  const sourceSettings = path.join(paths.defaultClaudeDir, "settings.json");
  let copiedSettings = false;
  if (!fs.existsSync(targetSettings) && fs.existsSync(sourceSettings)) {
    fs.copyFileSync(sourceSettings, targetSettings);
    copiedSettings = true;
  }
  return { createdDir, copiedSettings };
}

function initializeAllProfiles(manifest, localConfig, paths) {
  const results = [];
  for (const acc of manifest.accounts) {
    const profile = buildProfile(acc, localConfig, paths, manifest);
    const res = ensureProfileInitialized(profile, paths);
    results.push({ profile, ...res });
  }
  return results;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveClaudeBinary(paths) {
  if (process.platform === "win32") {
    const rawPath = process.env.PATH || process.env.Path || "";
    const dirs = rawPath.split(";").filter(Boolean);
    const localBin = path.join(paths.home, ".local", "bin");
    if (!dirs.some((d) => d.replace(/[\\/]+$/, "").toLowerCase() === localBin.toLowerCase())) {
      dirs.push(localBin);
    }
    const exts = [".exe", ".com", ".cmd", ".bat", ".ps1"];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, `claude${ext}`);
        if (!isFile(candidate)) continue;
        if (ext === ".cmd" || ext === ".bat") {
          return { command: "cmd.exe", prefixArgs: ["/c", candidate], resolvedPath: candidate };
        }
        if (ext === ".ps1") {
          const siblingExe = candidate.slice(0, -4) + ".exe";
          const siblingCmd = candidate.slice(0, -4) + ".cmd";
          if (isFile(siblingExe)) {
            return { command: siblingExe, prefixArgs: [], resolvedPath: siblingExe };
          }
          if (isFile(siblingCmd)) {
            return { command: "cmd.exe", prefixArgs: ["/c", siblingCmd], resolvedPath: siblingCmd };
          }
          return {
            command: "powershell.exe",
            prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate],
            resolvedPath: candidate,
          };
        }
        return { command: candidate, prefixArgs: [], resolvedPath: candidate };
      }
    }
    throw new Error("Claude Code CLI ('claude') not found on PATH.");
  }

  const miseProbe = spawnSync("mise", ["which", "claude"], {
    env: { ...process.env, MISE_OFFLINE: "1" },
    encoding: "utf8",
  });
  if (miseProbe.status === 0 && miseProbe.stdout) {
    const candidate = miseProbe.stdout.trim();
    if (candidate && isFile(candidate)) {
      return { command: candidate, prefixArgs: [], resolvedPath: candidate };
    }
  }

  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    if (dir.includes("/mise/shims/") || dir.includes("/mise/command-wrappers/bin/")) continue;
    const candidate = path.join(dir, "claude");
    if (!isFile(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    try {
      const lstat = fs.lstatSync(candidate);
      if (!lstat.isSymbolicLink()) {
        const fd = fs.openSync(candidate, "r");
        const buf = Buffer.alloc(4096);
        const bytes = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        if (/mise (use|x) /.test(buf.subarray(0, bytes).toString("utf8"))) {
          continue;
        }
      }
    } catch {
      // Ignore inspection errors and try next check
    }
    return { command: candidate, prefixArgs: [], resolvedPath: candidate };
  }
  throw new Error("Claude Code CLI ('claude') not found on PATH.");
}

function applyYoloFlags(userArgs) {
  let hasConflict = false;
  for (const arg of userArgs) {
    if (arg === "--") break;
    if (CONFLICT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      hasConflict = true;
      break;
    }
  }
  return hasConflict ? [...userArgs] : ["--dangerously-skip-permissions", ...userArgs];
}

function parseJsonFromOutput(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function probeDefaultAuthDirect(paths, claudeBin) {
  const claudeJson = readJsonIfExists(paths.defaultClaudeJson);
  const oauth = claudeJson && typeof claudeJson.oauthAccount === "object" ? claudeJson.oauthAccount : null;

  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;

  let statusObj = null;
  if (claudeBin) {
    const res = spawnSync(claudeBin.command, [...claudeBin.prefixArgs, "auth", "status"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    statusObj = parseJsonFromOutput(res.stdout || "");
  }

  return {
    loggedIn: Boolean(statusObj?.loggedIn),
    email: statusObj?.email || oauth?.emailAddress || null,
    displayName: oauth?.displayName || null,
    orgName: statusObj?.orgName || oauth?.organizationName || null,
    planTier: statusObj?.planTier || null,
    subscriptionType: statusObj?.subscriptionType || null,
    authMethod: statusObj?.authMethod || "none",
  };
}

function detectDefaultAccount(manifest, defaultInfo) {
  const email = (defaultInfo?.email || "").trim().toLowerCase();
  const displayName = (defaultInfo?.displayName || "").trim().toLowerCase();
  if (!email && !displayName) return null;

  // Match strictly against email / displayName — never planTier or subscriptionType.
  const emailTokens = new Set(email.split(/[^a-z0-9]+/).filter(Boolean));
  const exactMatches = manifest.accounts.filter((acc) => {
    const tokens = Array.isArray(acc.matchTokens) && acc.matchTokens.length > 0 ? acc.matchTokens : [acc.name];
    return tokens.some((t) => emailTokens.has(String(t).toLowerCase()));
  });
  if (exactMatches.length === 1) {
    return exactMatches[0].name;
  }

  const localPart = email.split("@")[0] || "";
  const partialMatches = manifest.accounts.filter((acc) => {
    const tokens = Array.isArray(acc.matchTokens) && acc.matchTokens.length > 0 ? acc.matchTokens : [acc.name];
    return tokens.some((t) => {
      const k = String(t).toLowerCase();
      return (localPart && localPart.includes(k)) || (displayName && displayName.includes(k));
    });
  });
  if (partialMatches.length === 1) {
    return partialMatches[0].name;
  }

  return null;
}

function probeProfileStatus(profile, paths, claudeBin) {
  const settingsExists = fs.existsSync(path.join(profile.configDir, "settings.json"));
  if (!profile.isDefault) {
    if (!fs.existsSync(profile.configDir)) {
      return {
        exists: false,
        settingsExists: false,
        loggedIn: false,
        email: null,
        orgName: null,
        planTier: null,
        subscriptionType: null,
        authMethod: "none",
      };
    }
    const hasCreds = fs.existsSync(path.join(profile.configDir, ".credentials.json"));
    const hasCfg = fs.existsSync(path.join(profile.configDir, ".claude.json"));
    // Avoid spawning `claude auth status` on empty profile dirs so `status` stays read-only.
    if (!hasCreds && !hasCfg) {
      return {
        exists: true,
        settingsExists,
        loggedIn: false,
        email: null,
        orgName: null,
        planTier: null,
        subscriptionType: null,
        authMethod: "none",
      };
    }
  } else if (!fs.existsSync(profile.configDir) && !fs.existsSync(paths.defaultClaudeJson)) {
    return {
      exists: false,
      settingsExists: false,
      loggedIn: false,
      email: null,
      orgName: null,
      planTier: null,
      subscriptionType: null,
      authMethod: "none",
    };
  }

  const env = buildChildEnv(profile);
  const res = spawnSync(claudeBin.command, [...claudeBin.prefixArgs, "auth", "status"], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  const parsed = parseJsonFromOutput(res.stdout || "");
  const cfgPath = profile.isDefault
    ? paths.defaultClaudeJson
    : path.join(profile.configDir, ".claude.json");
  const oauth = readJsonIfExists(cfgPath)?.oauthAccount || null;

  return {
    exists: true,
    settingsExists,
    loggedIn: Boolean(parsed?.loggedIn),
    email: parsed?.email || oauth?.emailAddress || null,
    orgName: parsed?.orgName || oauth?.organizationName || null,
    planTier: parsed?.planTier || null,
    subscriptionType: parsed?.subscriptionType || null,
    authMethod: parsed?.authMethod || "none",
  };
}

function resolvePxpipeCli(paths) {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "pxpipe", "node_modules", "pxpipe-proxy", "bin", "cli.js")
            : "",
          process.env.APPDATA
            ? path.join(process.env.APPDATA, "npm", "node_modules", "pxpipe-proxy", "bin", "cli.js")
            : "",
        ]
      : [
          path.join(
            process.env.PXPIPE_INSTALL_DIR || path.join(paths.home, ".local", "share", "pxpipe"),
            "node_modules",
            "pxpipe-proxy",
            "bin",
            "cli.js",
          ),
        ];

  for (const c of candidates) {
    if (c && isFile(c)) return c;
  }
  throw new Error(
    process.platform === "win32"
      ? "pxpipe-proxy cli.js not found. Re-run windows\\install.ps1."
      : "pxpipe-proxy cli.js not found. Re-run linux/install.sh.",
  );
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureProxyPort(port, paths) {
  if (await isPortOpen(port)) return;

  if (process.platform !== "win32") {
    const unit = port === 47822 ? "pxpipe-chatgpt.service" : "pxpipe.service";
    const sys = spawnSync("systemctl", ["--user", "start", unit], { stdio: "ignore" });
    if (sys.status === 0) {
      for (let i = 0; i < 30; i += 1) {
        if (await isPortOpen(port)) return;
        await sleep(100);
      }
    }
  }

  const cliJs = resolvePxpipeCli(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(paths.stateDir, `pxpipe-${port}.log`);
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    PXPIPE_MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
  };
  if (port === 47822) {
    env.OPENAI_UPSTREAM = "https://chatgpt.com";
    env.PXPIPE_SESSION_STATE = path.join(paths.stateDir, "session-state-chatgpt.json");
  }

  const fd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [cliJs], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }

  for (let i = 0; i < 50; i += 1) {
    if (await isPortOpen(port)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for pxpipe on 127.0.0.1:${port} (see ${logFile})`);
}

function runInteractive(command, args, env) {
  return new Promise((resolve) => {
    const onSigint = () => {};
    process.on("SIGINT", onSigint);
    const child = spawn(command, args, { stdio: "inherit", env });
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onSigint);
      resolve(code);
    };
    child.once("error", (err) => {
      console.error(`[claude-accounts] failed to launch ${command}: ${err.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
      } else if (signal === "SIGINT") {
        finish(130);
      } else {
        finish(1);
      }
    });
  });
}

function parseFlagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return null;
}

function parseDefaultSelection(manifest, rawValue) {
  if (!rawValue) return null;
  const norm = rawValue.trim().toLowerCase();
  if (norm === "none" || norm === "null" || norm === "-") return null;
  const acc = resolveAccount(manifest, norm);
  if (!acc) {
    const valid = manifest.accounts.map((a) => a.name).join("|");
    throw new Error(`Unknown account '${rawValue}'. Expected one of: ${valid}|none`);
  }
  return acc.name;
}

function printStatusTable(manifest, localConfig, paths, asJson = false) {
  let claudeBin = null;
  try {
    claudeBin = resolveClaudeBinary(paths);
  } catch {
    claudeBin = null;
  }

  const rows = manifest.accounts.map((acc) => {
    const profile = buildProfile(acc, localConfig, paths, manifest);
    const st = claudeBin
      ? probeProfileStatus(profile, paths, claudeBin)
      : {
          exists: fs.existsSync(profile.configDir),
          settingsExists: fs.existsSync(path.join(profile.configDir, "settings.json")),
          loggedIn: false,
          email: null,
          orgName: null,
          planTier: null,
          subscriptionType: null,
          authMethod: "unknown",
        };
    return {
      name: profile.name,
      alias: profile.alias,
      pxpipeAlias: profile.pxpipeAlias,
      isDefault: profile.isDefault,
      configDir: profile.configDir,
      ...st,
    };
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          defaultAccount: localConfig.defaultAccount,
          localConfigPath: paths.localConfigPath,
          claudeBinary: claudeBin?.resolvedPath || null,
          accounts: rows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    `Default (~/.claude) binding: ${localConfig.defaultAccount || "unset (using ~/.claude-profiles/* for all)"}`,
  );
  console.log(`Config: ${paths.localConfigPath}`);
  for (const r of rows) {
    const binding = r.isDefault ? "default (~/.claude)" : r.configDir;
    const auth = r.loggedIn
      ? `logged in (${r.email || "unknown"}${r.planTier ? `, ${r.planTier}` : ""})`
      : "logged out";
    const settingsTag = r.settingsExists ? "settings: ok" : "settings: missing";
    console.log(
      `  ${r.name.padEnd(4)} | ${r.alias.padEnd(4)} / ${r.pxpipeAlias.padEnd(5)} | ${auth} | ${settingsTag} | ${binding}`,
    );
  }
  return 0;
}

async function cmdRun(manifest, localConfig, paths, args) {
  let usePxpipe = false;
  let idx = 0;
  if (args[idx] === "--pxpipe") {
    usePxpipe = true;
    idx += 1;
  }
  const targetToken = args[idx];
  if (!targetToken) {
    console.error("Usage: claude-accounts run [--pxpipe] <dev|vex|pro> [claude args...]");
    return 2;
  }
  const account = resolveAccount(manifest, targetToken);
  if (!account) {
    console.error(`[claude-accounts] unknown account: ${targetToken}`);
    return 2;
  }

  const profile = buildProfile(account, localConfig, paths, manifest);
  ensureProfileInitialized(profile, paths);

  const passArgs = args.slice(idx + 1);
  const finalArgs = applyYoloFlags(passArgs);
  const claudeBin = resolveClaudeBinary(paths);
  const childEnv = buildChildEnv(profile);

  if (usePxpipe && process.env.PXPIPE_WARPED !== "1") {
    await ensureProxyPort(DEFAULT_PORT, paths);
    const cliJs = resolvePxpipeCli(paths);
    const warpArgs = [cliJs, "warp", "--", claudeBin.command, ...claudeBin.prefixArgs, ...finalArgs];
    return runInteractive(process.execPath, warpArgs, { ...childEnv, PXPIPE_WARPED: "1" });
  }

  return runInteractive(claudeBin.command, [...claudeBin.prefixArgs, ...finalArgs], childEnv);
}

async function cmdLogin(manifest, localConfig, paths, args) {
  const target = args[0];
  if (!target || target.startsWith("-")) {
    console.error("Usage: claude-accounts login <dev|vex|pro|all> [--email <addr>] [--console] [--sso] [--force]");
    return 2;
  }
  const rest = args.slice(1);
  const force = rest.includes("--force");
  const forwardArgs = rest.filter((a) => a !== "--force");
  const claudeBin = resolveClaudeBinary(paths);

  const targets =
    target.toLowerCase() === "all"
      ? manifest.accounts
      : [resolveAccount(manifest, target)].filter(Boolean);

  if (targets.length === 0) {
    console.error(`[claude-accounts] unknown account: ${target}`);
    return 2;
  }

  for (const acc of targets) {
    const profile = buildProfile(acc, localConfig, paths, manifest);
    ensureProfileInitialized(profile, paths);
    if (target.toLowerCase() === "all" && !force) {
      const st = probeProfileStatus(profile, paths, claudeBin);
      if (st.loggedIn) {
        console.log(
          `[claude-accounts] Skipping '${profile.name}' (already logged in as ${st.email || "unknown"}; pass --force to re-login).`,
        );
        continue;
      }
    }
    const loc = profile.isDefault ? "~/.claude (default)" : profile.configDir;
    console.log(`[claude-accounts] Logging in '${profile.name}' (${profile.alias}/${profile.pxpipeAlias}) -> ${loc}`);
    const code = await runInteractive(
      claudeBin.command,
      [...claudeBin.prefixArgs, "auth", "login", ...forwardArgs],
      buildChildEnv(profile),
    );
    if (code !== 0) return code;
  }
  return 0;
}

async function cmdLogout(manifest, localConfig, paths, args) {
  const target = args[0];
  const account = resolveAccount(manifest, target);
  if (!account) {
    console.error("Usage: claude-accounts logout <dev|vex|pro>");
    return 2;
  }
  const profile = buildProfile(account, localConfig, paths, manifest);
  const claudeBin = resolveClaudeBinary(paths);
  return runInteractive(
    claudeBin.command,
    [...claudeBin.prefixArgs, "auth", "logout"],
    buildChildEnv(profile),
  );
}

function cmdSetDefault(manifest, paths, args) {
  const raw = args[0];
  if (!raw) {
    console.error("Usage: claude-accounts set-default <dev|vex|pro|none>");
    return 2;
  }
  const selected = parseDefaultSelection(manifest, raw);
  saveLocalConfig(paths, selected);
  const localConfig = loadLocalConfig(paths);
  initializeAllProfiles(manifest, localConfig, paths);
  return printStatusTable(manifest, localConfig, paths, false);
}

function cmdSyncSettings(manifest, localConfig, paths, args) {
  const fromRaw = parseFlagValue(args, "--from") || "default";
  const force = args.includes("--force");

  let sourceDir;
  let sourceName;
  if (fromRaw.toLowerCase() === "default") {
    sourceDir = paths.defaultClaudeDir;
    sourceName = "default (~/.claude)";
  } else {
    const acc = resolveAccount(manifest, fromRaw);
    if (!acc) {
      console.error(`[claude-accounts] unknown --from account: ${fromRaw}`);
      return 2;
    }
    const p = buildProfile(acc, localConfig, paths, manifest);
    sourceDir = p.configDir;
    sourceName = p.name;
  }

  const sourceFile = path.join(sourceDir, "settings.json");
  if (!fs.existsSync(sourceFile)) {
    console.error(`[claude-accounts] source settings.json not found: ${sourceFile}`);
    return 1;
  }

  const seen = new Set([path.resolve(sourceDir)]);
  let copied = 0;
  let skipped = 0;

  const targets = [
    { name: "default", dir: paths.defaultClaudeDir },
    ...manifest.accounts.map((acc) => {
      const p = buildProfile(acc, localConfig, paths, manifest);
      return { name: p.name, dir: p.configDir };
    }),
  ];

  for (const t of targets) {
    const resolvedDir = path.resolve(t.dir);
    if (seen.has(resolvedDir)) continue;
    seen.add(resolvedDir);
    fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const destFile = path.join(t.dir, "settings.json");
    if (fs.existsSync(destFile) && !force) {
      console.log(`  skip  ${t.name} (${destFile} exists; pass --force to overwrite)`);
      skipped += 1;
      continue;
    }
    fs.copyFileSync(sourceFile, destFile);
    console.log(`  copy  ${t.name} <- ${sourceName} (${destFile})`);
    copied += 1;
  }

  console.log(`[claude-accounts] sync-settings done: ${copied} copied, ${skipped} skipped.`);
  return 0;
}

function cmdAutoInit(manifest, paths, args) {
  const explicitDefault = parseFlagValue(args, "--default");
  let localConfig = loadLocalConfig(paths);
  let claudeBin = null;
  try {
    claudeBin = resolveClaudeBinary(paths);
  } catch {
    claudeBin = null;
  }

  let note = "";
  if (explicitDefault !== null) {
    const chosen = parseDefaultSelection(manifest, explicitDefault);
    saveLocalConfig(paths, chosen);
    localConfig = loadLocalConfig(paths);
    note = `bound default ~/.claude -> ${chosen || "none"} (--default)`;
  } else if (!localConfig.exists) {
    const defaultInfo = probeDefaultAuthDirect(paths, claudeBin);
    const detected = detectDefaultAccount(manifest, defaultInfo);
    saveLocalConfig(paths, detected);
    localConfig = loadLocalConfig(paths);
    if (detected) {
      note = `auto-bound default ~/.claude -> '${detected}' (${defaultInfo.email || defaultInfo.displayName})`;
    } else {
      note = defaultInfo.email
        ? `could not auto-match '${defaultInfo.email}' to dev/vex/pro; run 'claude-accounts setup'`
        : "no default ~/.claude login detected; run 'claude-accounts setup'";
    }
  } else {
    note = `keeping existing default binding -> ${localConfig.defaultAccount || "none"}`;
  }

  initializeAllProfiles(manifest, localConfig, paths);
  console.log(`[claude-accounts] ${note}`);
  if (claudeBin) {
    for (const acc of manifest.accounts) {
      const profile = buildProfile(acc, localConfig, paths, manifest);
      const st = probeProfileStatus(profile, paths, claudeBin);
      if (!st.loggedIn) {
        console.log(
          `[claude-accounts]   '${profile.name}' not logged in -> run: claude-accounts login ${profile.name}`,
        );
      }
    }
  }
  return 0;
}

async function cmdSetup(manifest, paths, args) {
  const explicitDefault = parseFlagValue(args, "--default");
  const wantLoginFlag = args.includes("--login");
  const noLoginFlag = args.includes("--no-login");

  let claudeBin = null;
  try {
    claudeBin = resolveClaudeBinary(paths);
  } catch {
    claudeBin = null;
  }

  let localConfig = loadLocalConfig(paths);
  const defaultInfo = probeDefaultAuthDirect(paths, claudeBin);
  const detected = detectDefaultAccount(manifest, defaultInfo);

  if (explicitDefault !== null) {
    saveLocalConfig(paths, parseDefaultSelection(manifest, explicitDefault));
    localConfig = loadLocalConfig(paths);
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    const currentDefault = localConfig.defaultAccount ?? detected;
    console.log("Detected current ~/.claude login:");
    console.log(
      `  Email: ${defaultInfo.email || "(not logged in)"}${defaultInfo.planTier ? ` (${defaultInfo.planTier})` : ""}`,
    );
    if (detected) {
      console.log(`  Suggested account name: ${detected}`);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const choices = manifest.accounts.map((a) => a.name).join("/");
      const hint = currentDefault ? ` [${currentDefault}]` : " [none]";
      const answer = (
        await rl.question(`Which account is ~/.claude on this PC (${choices}/none)${hint}: `)
      ).trim();
      const chosen = answer ? parseDefaultSelection(manifest, answer) : currentDefault;
      saveLocalConfig(paths, chosen);
      localConfig = loadLocalConfig(paths);

      initializeAllProfiles(manifest, localConfig, paths);
      printStatusTable(manifest, localConfig, paths, false);

      const shouldLogin = wantLoginFlag
        ? true
        : noLoginFlag
          ? false
          : (await rl.question("Log in to any logged-out accounts now? [y/N]: "))
              .trim()
              .toLowerCase()
              .startsWith("y");

      if (shouldLogin) {
        rl.close();
        return cmdLogin(manifest, localConfig, paths, ["all"]);
      }
      return 0;
    } finally {
      rl.close();
    }
  } else {
    if (!localConfig.exists) {
      saveLocalConfig(paths, detected);
      localConfig = loadLocalConfig(paths);
    }
  }

  initializeAllProfiles(manifest, localConfig, paths);
  printStatusTable(manifest, localConfig, paths, false);
  if (wantLoginFlag) {
    return cmdLogin(manifest, localConfig, paths, ["all"]);
  }
  return 0;
}

function printHelp() {
  console.log(`Usage: claude-accounts <command> [args...]

Commands:
  status [--json]                     Show dev/vex/pro profile bindings and login status
  setup [--default <name|none>]       Interactive setup wizard for this PC
        [--login | --no-login]
  auto-init [--default <name|none>]   Non-interactive init (used by install scripts)
  set-default <dev|vex|pro|none>      Bind which account uses the default ~/.claude dir
  login <dev|vex|pro|all>             Sign in via 'claude auth login' for an account
        [--email <addr>] [--console] [--sso] [--force]
  logout <dev|vex|pro>                Sign out of an account
  sync-settings [--from <src>]        Copy settings.json across profiles (default: ~/.claude)
                [--force]
  run [--pxpipe] <dev|vex|pro> [...]  Launch Claude (aliases: cdev/cvex/cpro, pcdev/pcvex/pcpro)
  help                                Show this help`);
  return 0;
}

async function main() {
  const paths = getPaths();
  const manifest = loadManifest(paths);
  const localConfig = loadLocalConfig(paths);

  let argv = process.argv.slice(2);

  if (argv[0] === "--invoked-as" && argv.length >= 2) {
    const invoked = argv[1].toLowerCase();
    const rest = argv.slice(2);
    const directAcc = manifest.accounts.find((a) => a.alias.toLowerCase() === invoked);
    if (directAcc) {
      return cmdRun(manifest, localConfig, paths, [directAcc.name, ...rest]);
    }
    const pxpipeAcc = manifest.accounts.find((a) => a.pxpipeAlias.toLowerCase() === invoked);
    if (pxpipeAcc) {
      return cmdRun(manifest, localConfig, paths, ["--pxpipe", pxpipeAcc.name, ...rest]);
    }
    console.error(`[claude-accounts] unknown alias invocation: ${invoked}`);
    return 2;
  }

  const cmd = argv[0] || "status";
  const rest = argv.slice(1);

  switch (cmd) {
    case "status":
      return printStatusTable(manifest, localConfig, paths, rest.includes("--json"));
    case "run":
      return cmdRun(manifest, localConfig, paths, rest);
    case "login":
      return cmdLogin(manifest, localConfig, paths, rest);
    case "logout":
      return cmdLogout(manifest, localConfig, paths, rest);
    case "set-default":
      return cmdSetDefault(manifest, paths, rest);
    case "sync-settings":
      return cmdSyncSettings(manifest, localConfig, paths, rest);
    case "auto-init":
      return cmdAutoInit(manifest, paths, rest);
    case "setup":
      return cmdSetup(manifest, paths, rest);
    case "help":
    case "-h":
    case "--help":
      return printHelp();
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`[claude-accounts] ${err.message}`);
    process.exit(1);
  });
