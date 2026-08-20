import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function env(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "1" : "0").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function listEnv(name) {
  return env(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasEnv(name) {
  const value = process.env[name];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function inferShellBin() {
  if (hasEnv("POWERSHELL_BIN")) {
    return env("POWERSHELL_BIN");
  }

  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  }

  if (process.platform === "darwin") {
    return env("SHELL", "/bin/zsh");
  }

  return env("SHELL", "/bin/bash");
}

function isPowerShellExecutable(shellBin) {
  const baseName = path.basename(String(shellBin || "")).toLowerCase();
  return baseName === "pwsh" || baseName === "pwsh.exe" || baseName === "powershell.exe";
}

function inferShellArgs(shellBin) {
  if (isPowerShellExecutable(shellBin)) {
    return ["-NoLogo"];
  }

  if (process.platform === "win32") {
    return [];
  }

  return ["-l"];
}

function inferShellQuoteStyle(shellBin) {
  return isPowerShellExecutable(shellBin) ? "powershell" : "posix";
}

const root = process.cwd();
const home = process.env.USERPROFILE || process.env.HOME || os.homedir();

// herdr installs to ~/.local/bin, which only login shells add to PATH. The pty
// for a herdr client is spawned directly rather than through a shell, so prefer
// the concrete path when it exists and fall back to PATH lookup otherwise.
function inferHerdrBin() {
  if (hasEnv("HERDR_BIN")) {
    return env("HERDR_BIN");
  }

  const local = path.join(home, ".local", "bin", "herdr");
  return fs.existsSync(local) ? local : "herdr";
}
const generatedToken = crypto.randomBytes(18).toString("base64url");
const shellBin = env("SHELL_BIN", inferShellBin());
const shellArgs = hasEnv("SHELL_ARGS") ? listEnv("SHELL_ARGS") : inferShellArgs(shellBin);

export const config = {
  root,
  home,
  platform: process.platform,
  host: env("HOST", "0.0.0.0"),
  port: intEnv("PORT", 3210),
  accessToken: env("ACCESS_TOKEN", generatedToken),
  defaultCwd: env("DEFAULT_CWD", home),
  shellBin,
  shellArgs,
  shellQuoteStyle: env("SHELL_QUOTE_STYLE", inferShellQuoteStyle(shellBin)),
  codexBin: env("CODEX_BIN", "codex"),
  codexModel: env("CODEX_MODEL", ""),
  codexProfile: env("CODEX_PROFILE", ""),
  codexFullAccess: boolEnv("CODEX_FULL_ACCESS", true),
  codexNoAltScreen: boolEnv("CODEX_NO_ALT_SCREEN", true),
  codexExtraArgs: listEnv("CODEX_EXTRA_ARGS"),
  ccBin: env("CC_BIN", "claude"),
  ccModel: env("CC_MODEL", ""),
  ccFullAccess: boolEnv("CC_FULL_ACCESS", true),
  ccExtraArgs: listEnv("CC_EXTRA_ARGS"),
  authSessionCookieName: env("AUTH_SESSION_COOKIE_NAME", "codex_web_term_session"),
  authSessionTtlMs: intEnv("AUTH_SESSION_TTL_HOURS", 24) * 60 * 60 * 1000,
  secureCookies: boolEnv("SECURE_COOKIES", false),
  authRateLimitWindowMs: intEnv("AUTH_RATE_LIMIT_WINDOW_MINUTES", 10) * 60 * 1000,
  authRateLimitMaxAttempts: intEnv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", 5),
  authRateLimitBlockMs: intEnv("AUTH_RATE_LIMIT_BLOCK_MINUTES", 15) * 60 * 1000,
  tailscaleOnly: boolEnv("TAILSCALE_ONLY", false),
  trustedCidrs: listEnv("TRUSTED_CIDRS"),
  wsHeartbeatMs: intEnv("WS_HEARTBEAT_SECONDS", 30) * 1000,
  // How far back a client can reconnect and still resume instead of rebuilding
  // its terminal. An agent redrawing its screen burns through this quickly, and
  // a rebuild costs the browser its scrollback, so the window is worth its
  // memory: this is the cap per live session.
  sessionBufferLimit: intEnv("SESSION_BUFFER_LIMIT", 4000000),
  dataDir: path.join(root, "data"),
  codexSessionsDir: env("CODEX_SESSIONS_DIR", path.join(home, ".codex", "sessions")),
  ccSessionsDir: env("CC_SESSIONS_DIR", path.join(home, ".claude", "projects")),
  herdrEnabled: boolEnv("HERDR_ENABLED", true),
  herdrBin: inferHerdrBin(),
  herdrSocket: env("HERDR_SOCKET", ""),
  // /orch integration (docs/orch-contract-v1.1.md). The scheduler writes its
  // read model and Main Agent bindings under orchDir; the web side only ever
  // reads files there and shells out to gh for cmd:* labels.
  orchDir: env("ORCH_DIR", path.join(home, ".codex-cc-web-terminal", "orch")),
  // Machine token for POST /api/orch/spawn. Unset means spawn is disabled and
  // the scheduler falls back to nohup. Deliberately not ACCESS_TOKEN.
  orchApiToken: env("ORCH_API_TOKEN", ""),
  ghBin: env("GH_BIN", "gh"),
  timezone: env("DISPLAY_TIMEZONE", "Australia/Melbourne")
};
