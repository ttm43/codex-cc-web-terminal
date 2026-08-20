import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

import {
  consumeTerminalState,
  createTerminalState,
  renderTerminalStatePrefix
} from "./terminalState.js";

const shortTimeFormatterCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getShortTimeFormatter(timezone) {
  const key = String(timezone || "UTC");
  if (!shortTimeFormatterCache.has(key)) {
    shortTimeFormatterCache.set(
      key,
      new Intl.DateTimeFormat("en-AU", {
        timeZone: key,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short"
      })
    );
  }
  return shortTimeFormatterCache.get(key);
}

function formatShortTimestamp(value, timezone) {
  const parts = getShortTimeFormatter(timezone).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

// The ring buffer drops raw bytes off the front, and the bytes a session writes
// first are exactly the ones that set the terminal up. Feed everything we drop
// through the state tracker so a full replay can be prefixed with it, and never
// leave the retained buffer starting inside a sequence whose head we discarded.
function trimSessionBuffer(session, limit) {
  // Trimming copies the whole retained buffer, so let it overshoot and cut back
  // in one go instead of paying that copy on every chunk a busy agent writes.
  if (session.buffer.length <= limit + Math.floor(limit / 4)) {
    return;
  }

  let cut = session.buffer.length - limit;
  consumeTerminalState(session.droppedState, session.buffer.slice(0, cut));
  while (session.droppedState.pending && cut < session.buffer.length) {
    consumeTerminalState(session.droppedState, session.buffer[cut]);
    cut += 1;
  }

  session.buffer = session.buffer.slice(cut);
}

function quotePosix(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildShellCommand(parts, quoteStyle) {
  const values = parts.filter((part) => String(part || "").length > 0);
  if (values.length === 0) {
    return "";
  }

  if (quoteStyle === "powershell") {
    const [command, ...args] = values;
    const quotedArgs = args.map((arg) => quotePowerShell(arg)).join(" ");
    return quotedArgs
      ? `& ${quotePowerShell(command)} ${quotedArgs}`
      : `& ${quotePowerShell(command)}`;
  }

  return values.map((part) => quotePosix(part)).join(" ");
}

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeTitleFragment(value) {
  return String(value || "")
    .replace(/\u001b\[[<>0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTerminalControlSequences(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[<>0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmbeddedUserRequest(value) {
  const text = String(value || "");
  const userRequestMarker = "User request:";
  const userRequestIndex = text.lastIndexOf(userRequestMarker);
  if (userRequestIndex >= 0) {
    return text.slice(userRequestIndex + userRequestMarker.length).trim();
  }

  const replyMarker = "Reply with exactly:";
  const replyIndex = text.lastIndexOf(replyMarker);
  if (replyIndex >= 0) {
    return text.slice(replyIndex).trim();
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      !(line.startsWith("<") && line.endsWith(">")) &&
      !line.startsWith("[") &&
      !line.startsWith("Conversation info") &&
      !line.startsWith("Sender (") &&
      !line.startsWith("Bridge info") &&
      !line.startsWith("Workspace memory") &&
      !line.startsWith("Retrieved ") &&
      !line.startsWith("Available genes")
    ) {
      return line;
    }
  }

  return text.trim();
}

function deriveSessionTitle(value, fallback) {
  const clean = sanitizeTitleFragment(extractEmbeddedUserRequest(value))
    .replace(/^(codex|continue|resume|claude|cc)\s*/i, "")
    .trim();
  if (!clean) {
    return fallback;
  }

  if (clean.length <= 52) {
    return clean;
  }

  return `${clean.slice(0, 49).trimEnd()}...`;
}

function isLowSignalTitle(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) {
    return true;
  }

  return (
    lower.startsWith("conversation info") ||
    lower.includes("safety and fallback") ||
    lower.includes("available skills") ||
    lower.includes("skill.md") ||
    lower.includes("environment_context") ||
    lower.includes("imported context from the selected codex session") ||
    lower.includes("local-command-caveat") ||
    lower.includes("invalid api key") ||
    lower.includes("please run /login")
  );
}

function isBoilerplateUserText(value) {
  const original = String(value || "").trim();
  const text = extractEmbeddedUserRequest(value).trim();
  if (!original || !text) {
    return true;
  }

  const originalLower = original.toLowerCase();
  const lower = text.toLowerCase();
  return (
    (text.startsWith("<") && text.endsWith(">")) ||
    originalLower.startsWith("# agents.md instructions") ||
    originalLower.includes("### available skills") ||
    originalLower.includes("a skill is a set of local instructions") ||
    originalLower.includes("<environment_context>") ||
    originalLower.includes("</environment_context>") ||
    originalLower.includes("<local-command-caveat>") ||
    originalLower.includes("<command-name>") ||
    originalLower.includes("<command-message>") ||
    originalLower.includes("<command-args>") ||
    originalLower.includes("<local-command-stdout>") ||
    originalLower.includes("the user doesn't want to proceed with this tool use") ||
    originalLower.includes("[request interrupted by user for tool use]") ||
    originalLower.includes("do not respond to these messages") ||
    lower.startsWith("# agents.md instructions") ||
    lower.startsWith("<environment_context>") ||
    lower.startsWith("</environment_context>") ||
    lower.startsWith("you are running inside a local discord-controlled agent bridge") ||
    lower.includes("a skill is a set of local instructions") ||
    lower.includes("### available skills") ||
    lower.includes("<instructions>") ||
    lower.includes("</instructions>") ||
    lower.includes("<local-command-caveat>") ||
    lower.includes("<command-name>") ||
    lower.includes("<command-message>") ||
    lower.includes("<command-args>") ||
    lower.includes("<local-command-stdout>") ||
    lower.includes("the user doesn't want to proceed with this tool use") ||
    lower.includes("[request interrupted by user for tool use]")
  );
}

function walkJsonlFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const result = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function readSessionPreview(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function commandBaseName(command) {
  return path
    .basename(String(command || ""))
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim().toLowerCase()))];
}

function buildPtyEnv(extra = {}) {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    ...extra
  };
  for (const key of [
    "CODEX_CI",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_THREAD_ID"
  ]) {
    delete env[key];
  }
  return env;
}

// Session metadata is written by machine callers (the orch scheduler) and read
// back by browsers, so keep it a small flat bag of strings instead of trusting
// arbitrary JSON.
function sanitizeSessionMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }

  const entries = Object.entries(meta)
    .slice(0, 16)
    .filter(([key]) => /^[a-zA-Z0-9_-]{1,32}$/.test(key))
    .map(([key, value]) => [key, sanitizeTitleFragment(String(value ?? "")).slice(0, 200)]);
  return entries.length ? Object.fromEntries(entries) : null;
}

function customNameKey(providerId, resumeSessionId) {
  return `${String(providerId || "codex").trim()}:${String(resumeSessionId || "").trim()}`;
}

function archivedSessionKey(providerId, resumeSessionId) {
  return customNameKey(providerId, resumeSessionId);
}

function normalizeCustomNameKey(key) {
  const text = String(key || "").trim();
  if (!text) {
    return "";
  }
  return text.includes(":") ? text : customNameKey("codex", text);
}

function basenameWithoutExtension(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function contentTextItems(content) {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const items = [];
  for (const item of content) {
    if (typeof item === "string") {
      items.push(item);
      continue;
    }

    if (item?.type === "input_text" && item.text) {
      items.push(String(item.text));
      continue;
    }

    if (item?.type === "text" && item.text) {
      items.push(String(item.text));
      continue;
    }

    if (item?.type === "tool_result" && item.content) {
      items.push(...contentTextItems(item.content));
    }
  }

  return items;
}

function userTextsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (payload.type === "user_message" && payload.message) {
    return [String(payload.message)];
  }

  if (payload.role === "user") {
    return contentTextItems(payload.content);
  }

  if (payload.type === "user" && payload.message) {
    return userTextsFromPayload(payload.message);
  }

  if (payload.message?.role === "user") {
    return contentTextItems(payload.message.content);
  }

  return [];
}

function buildProviders(config) {
  const codexBootstrapNames = uniqueStrings(["codex", commandBaseName(config.codexBin)]);
  const ccBootstrapNames = uniqueStrings(["cc", "claude", commandBaseName(config.ccBin)]);

  return [
    {
      id: "codex",
      aliases: ["codex"],
      label: "Codex",
      cliLabel: "Codex CLI",
      historyLabel: "Saved Codex threads",
      fallbackPrefix: "codex",
      sessionsDir: config.codexSessionsDir,
      bootstrapNames: codexBootstrapNames,
      buildCommand({ resumeSessionId }) {
        const parts = [config.codexBin];
        if (resumeSessionId) {
          parts.push("resume", "--all", resumeSessionId);
        }
        if (config.codexModel) {
          parts.push("--model", config.codexModel);
        }
        if (config.codexProfile) {
          parts.push("--profile", config.codexProfile);
        }
        if (config.codexNoAltScreen) {
          parts.push("--no-alt-screen");
        }
        if (config.codexFullAccess) {
          parts.push("--dangerously-bypass-approvals-and-sandbox");
        }
        if (config.codexExtraArgs.length > 0) {
          parts.push(...config.codexExtraArgs);
        }
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    },
    {
      id: "cc",
      aliases: ["cc", "claude"],
      label: "Claude",
      cliLabel: "Claude CLI",
      historyLabel: "Saved Claude sessions",
      fallbackPrefix: "cc",
      sessionsDir: config.ccSessionsDir,
      bootstrapNames: ccBootstrapNames,
      buildCommand({ resumeSessionId, name }) {
        const parts = [config.ccBin];
        if (resumeSessionId) {
          parts.push("--resume", resumeSessionId);
        } else if (String(name || "").trim()) {
          parts.push("--name", String(name).trim());
        }
        if (config.ccModel) {
          parts.push("--model", config.ccModel);
        }
        if (config.ccFullAccess) {
          parts.push("--dangerously-skip-permissions");
        }
        if (config.ccExtraArgs.length > 0) {
          parts.push(...config.ccExtraArgs);
        }
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    }
  ];
}

export class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
    this.customNamesPath = path.join(this.config.dataDir, "session-names.json");
    this.archivedSessionsPath = path.join(this.config.dataDir, "archived-sessions.json");
    this.customNames = new Map(
      Object.entries(readJsonFile(this.customNamesPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), value])
        .filter((entry) => entry[0] && entry[1])
    );
    this.archivedSessions = new Map(
      Object.entries(readJsonFile(this.archivedSessionsPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), String(value || "").trim()])
        .filter((entry) => entry[0] && entry[1])
    );
    fs.mkdirSync(this.config.dataDir, { recursive: true });
  }

  providerCatalog() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      cliLabel: provider.cliLabel,
      historyLabel: provider.historyLabel
    }));
  }

  getProvider(providerId = "codex") {
    const normalizedId = String(providerId || "codex").trim().toLowerCase() || "codex";
    const provider =
      this.providers.get(normalizedId) ||
      [...this.providers.values()].find((item) => Array.isArray(item.aliases) && item.aliases.includes(normalizedId));
    if (!provider) {
      throw new Error(`Unsupported session provider: ${providerId}`);
    }
    return provider;
  }

  list() {
    return this.listLiveSessions();
  }

  listLiveSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((session) => this.serialize(session));
  }

  listAll() {
    const liveSessions = this.listLiveSessions();
    const liveByResumeId = new Set(
      liveSessions
        .map((session) => this.resumeKey(session.provider, session.resumeSessionId))
        .filter(Boolean)
    );
    const historySessions = this.listHistoricalSessions({ archived: false }).filter((session) => {
      return !liveByResumeId.has(this.resumeKey(session.provider, session.resumeSessionId));
    });
    return [...liveSessions, ...historySessions].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
  }

  listArchived() {
    return this.listHistoricalSessions({ archived: true });
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  stats() {
    let clientCount = 0;
    let running = 0;
    let exited = 0;
    for (const session of this.sessions.values()) {
      clientCount += session.clients.size;
      if (session.status === "exited") {
        exited += 1;
      } else {
        running += 1;
      }
    }

    return {
      sessions: this.sessions.size,
      clients: clientCount,
      running,
      exited
    };
  }

  create({ cwd = "", name = "", resumeSessionId = "", provider = "codex" } = {}) {
    const resolvedProvider = this.getProvider(provider);
    const id = crypto.randomUUID();
    const resolvedCwd = this.resolveCwd(cwd);
    const fallbackName = `${resolvedProvider.fallbackPrefix}-${this.sessions.size + 1}`;
    const sessionName = normalizeName(name, fallbackName);
    const shell = pty.spawn(this.config.shellBin, this.config.shellArgs, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: buildPtyEnv({ CODEX_CC_WEB_SESSION_ID: id })
    });

    const session = {
      id,
      provider: resolvedProvider.id,
      providerLabel: resolvedProvider.label,
      cliLabel: resolvedProvider.cliLabel,
      name: sessionName,
      cwd: resolvedCwd,
      meta: null,
      commandSession: false,
      shell,
      buffer: "",
      // Total bytes the pty has ever written. buffer holds the tail of that
      // stream, so it covers [streamBytes - buffer.length, streamBytes).
      streamBytes: 0,
      droppedState: createTerminalState(),
      status: "starting",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      exitCode: null,
      clients: new Set(),
      autoNamed: !String(name || "").trim(),
      fallbackName,
      inputPreview: "",
      sawBootstrapCommand: false,
      bootstrapNames: resolvedProvider.bootstrapNames,
      claudeStartupStage: 0,
      resumeSessionId: String(resumeSessionId || "").trim() || null
    };

    this.wireShellEvents(session);
    this.sessions.set(id, session);
    shell.write(`${this.buildProviderCommand(session)}\r`);
    return this.serialize(session);
  }

  // POST /api/orch/spawn lands here: one PTY that runs a single command to
  // completion (an orch worker), instead of an interactive provider bootstrap.
  // The session still gets the full live-session lifecycle -- attachable,
  // resumable, scrollback retained after exit -- which is the whole point of
  // spawning workers here rather than under nohup.
  createCommand({ command = "", cwd = "", meta = null, name = "" } = {}) {
    const commandText = String(command || "").trim();
    if (!commandText) {
      throw new Error("command is required");
    }

    const requestedCwd = String(cwd || "").trim();
    if (!requestedCwd) {
      throw new Error("cwd is required");
    }
    const resolvedCwd = path.resolve(requestedCwd);
    if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
      // A worker pointed at a missing worktree must fail loudly so the
      // scheduler can fall back, not silently run in defaultCwd.
      throw new Error(`cwd does not exist: ${resolvedCwd}`);
    }

    const id = crypto.randomUUID();
    const sanitizedMeta = sanitizeSessionMeta(meta);
    const isWorker = sanitizedMeta?.kind === "worker";
    const fallbackName = isWorker
      ? `#${sanitizedMeta.ticket || "?"} ${sanitizedMeta.phase || "task"}`.trim()
      : `cmd-${this.sessions.size + 1}`;
    const shellArgs =
      this.config.shellQuoteStyle === "powershell"
        ? ["-NoLogo", "-Command", commandText]
        : ["-l", "-c", commandText];
    const shell = pty.spawn(this.config.shellBin, shellArgs, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: buildPtyEnv({ CODEX_CC_WEB_SESSION_ID: id })
    });

    const session = {
      id,
      provider: "command",
      providerLabel: isWorker ? "Worker" : "Command",
      cliLabel: isWorker ? "Orch worker" : "Command",
      name: normalizeName(name, fallbackName),
      cwd: resolvedCwd,
      meta: sanitizedMeta,
      commandSession: true,
      shell,
      buffer: "",
      streamBytes: 0,
      droppedState: createTerminalState(),
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      exitCode: null,
      clients: new Set(),
      autoNamed: false,
      fallbackName,
      inputPreview: "",
      sawBootstrapCommand: true,
      bootstrapNames: [],
      claudeStartupStage: 2,
      resumeSessionId: null
    };

    this.wireShellEvents(session);
    this.sessions.set(id, session);
    return this.serialize(session);
  }

  wireShellEvents(session) {
    session.shell.onData((chunk) => {
      session.buffer += chunk;
      session.streamBytes += chunk.length;
      trimSessionBuffer(session, this.config.sessionBufferLimit);
      session.status = "running";
      session.updatedAt = nowIso();
      this.maybeAutoAdvanceClaudeStartup(session);
      for (const client of session.clients) {
        client.send(JSON.stringify({ type: "data", data: chunk }));
      }
    });

    session.shell.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.status = "exited";
      session.updatedAt = nowIso();
      // Command sessions have no provider history to attach a name to.
      if (!session.commandSession && !this.persistSessionName(session)) {
        this.scheduleDeferredNamePersistence(session);
      }
      for (const client of session.clients) {
        client.send(JSON.stringify({ type: "exit", exitCode }));
      }
    });
  }

  // A client that still holds this session's output passes the stream offset it
  // reached. If that offset is still inside the ring buffer it only gets what
  // it missed and keeps its scrollback; otherwise it rebuilds from the retained
  // tail, which needs the setup sequences that fell out of the buffer prepended
  // to it.
  attachClient(id, ws, { since = null } = {}) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    const bufferStart = session.streamBytes - session.buffer.length;
    const resumable =
      Number.isInteger(since) && since >= bufferStart && since <= session.streamBytes;

    session.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "snapshot",
        session: this.serialize(session),
        buffer: resumable
          ? session.buffer.slice(since - bufferStart)
          : renderTerminalStatePrefix(session.droppedState) + session.buffer,
        reset: !resumable,
        streamOffset: session.streamBytes
      })
    );

    ws.on("close", () => {
      session.clients.delete(ws);
    });
  }

  write(id, data) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    const text = String(data || "");
    this.maybeAutoRename(session, text);
    session.shell.write(text);
    session.updatedAt = nowIso();
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    // Viewing a finished session (an exited orch worker's scrollback) still
    // sends resizes; the pty is gone and node-pty would throw ENOTTY.
    if (session.status === "exited") {
      return;
    }

    session.shell.resize(Math.max(20, cols || 120), Math.max(10, rows || 30));
    session.updatedAt = nowIso();
  }

  rename(id, name) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.name = normalizeName(name, session.fallbackName || session.name);
    session.autoNamed = false;
    session.updatedAt = nowIso();
    this.persistSessionName(session);
    return this.serialize(session);
  }

  close(id) {
    const session = this.get(id);
    if (!session) {
      return false;
    }

    session.status = "closing";
    session.updatedAt = nowIso();
    try {
      session.shell.kill();
    } catch {
      // Ignore PTY kill failures.
    }
    this.sessions.delete(id);
    return true;
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) {
      try {
        session.shell.kill();
      } catch {
        // Ignore PTY kill failures during shutdown.
      }
      session.clients.clear();
    }
    this.sessions.clear();
  }

  resolveCwd(cwd) {
    const value = String(cwd || "").trim();
    if (!value) {
      return this.config.defaultCwd;
    }

    const resolved = path.resolve(value);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }

    return this.config.defaultCwd;
  }

  serialize(session) {
    return {
      id: session.id,
      provider: session.provider,
      providerLabel: session.providerLabel,
      cliLabel: session.cliLabel,
      name: session.name,
      cwd: session.cwd,
      meta: session.meta || null,
      kind: "live",
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      autoNamed: session.autoNamed,
      inputPreview: session.inputPreview,
      resumeSessionId: session.resumeSessionId
    };
  }

  listHistoricalSessions({ archived = null } = {}) {
    return [...this.providers.values()]
      .flatMap((provider) => this.listHistoricalSessionsForProvider(provider, { archived }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listHistoricalSessionsForProvider(provider, { archived = null } = {}) {
    const byResumeId = new Map();

    for (const entry of this.scanHistoricalSessionsForProvider(provider)) {
      const isArchived = this.isArchived(provider.id, entry.resumeSessionId);
      if (archived !== null && isArchived !== archived) {
        continue;
      }

      const session = this.buildHistoricalSession(provider, entry, isArchived ? "archived" : "history");
      const existing = byResumeId.get(entry.resumeSessionId);
      if (!existing || existing.updatedAt < session.updatedAt) {
        byResumeId.set(entry.resumeSessionId, session);
      }
    }

    return [...byResumeId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  scanHistoricalSessionsForProvider(provider) {
    const files = walkJsonlFiles(provider.sessionsDir);
    const entries = [];

    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const preview = readSessionPreview(filePath);
        let id = "";
        let cwd = this.config.defaultCwd;
        let title = "";
        let firstInput = "";
        let fallbackInput = "";

        for (const line of preview.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }

          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }

          if (record.type === "session_meta") {
            id = String(record.payload?.id || id);
            cwd = String(record.payload?.cwd || cwd);
            title = sanitizeTitleFragment(record.payload?.thread_name || title);
          }

          id = String(record.sessionId || id || "");
          cwd = String(record.cwd || cwd || this.config.defaultCwd);
          title = sanitizeTitleFragment(record.slug || title);

          const eventCandidates = record.type === "event_msg" ? userTextsFromPayload(record.payload) : [];
          const fallbackCandidates =
            record.type === "response_item"
              ? userTextsFromPayload(record.payload)
              : userTextsFromPayload(record);
          const candidates = eventCandidates.length > 0 ? eventCandidates : fallbackCandidates;
          for (const rawCandidate of candidates) {
            const candidate = sanitizeTitleFragment(extractEmbeddedUserRequest(rawCandidate));
            if (!candidate) {
              continue;
            }
            if (!fallbackInput) {
              fallbackInput = candidate;
            }
            if (!isBoilerplateUserText(candidate)) {
              firstInput = candidate;
              break;
            }
          }

          if (id && firstInput) {
            break;
          }
        }

        id = id || basenameWithoutExtension(filePath);
        if (!id) {
          continue;
        }

        entries.push({
          filePath,
          stat,
          resumeSessionId: id,
          cwd,
          title,
          firstInput,
          fallbackInput
        });
      } catch {
        // Ignore malformed or unreadable session files.
      }
    }

    return entries;
  }

  buildHistoricalSession(provider, entry, kind = "history") {
    const effectivePreview = entry.firstInput || entry.fallbackInput || entry.title;
    const derivedName = deriveSessionTitle(
      effectivePreview || entry.title,
      `${provider.fallbackPrefix}-${entry.resumeSessionId.slice(0, 8)}`
    );
    const fallbackSavedName = `Saved ${path.basename(entry.cwd || this.config.defaultCwd)} ${formatShortTimestamp(
      entry.stat.mtime,
      this.config.timezone
    )}`;
    const finalName = isLowSignalTitle(derivedName) ? fallbackSavedName : derivedName;
    const customName = this.getCustomName(provider.id, entry.resumeSessionId);
    return {
      id: `history:${provider.id}:${entry.resumeSessionId}`,
      provider: provider.id,
      providerLabel: provider.label,
      cliLabel: provider.cliLabel,
      name: customName || finalName,
      cwd: entry.cwd,
      kind,
      status: kind === "archived" ? "archived" : "saved",
      createdAt: entry.stat.birthtime.toISOString(),
      updatedAt: entry.stat.mtime.toISOString(),
      exitCode: null,
      autoNamed: false,
      inputPreview: isLowSignalTitle(derivedName) ? "" : effectivePreview,
      resumeSessionId: entry.resumeSessionId,
      archivedAt: this.getArchivedAt(provider.id, entry.resumeSessionId)
    };
  }

  maybeAutoRename(session, chunk) {
    if (!session.autoNamed) {
      return;
    }

    const text = String(chunk || "");
    if (!text) {
      return;
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const segment of normalized.split("\n")) {
      const candidate = sanitizeTitleFragment(segment);
      if (!candidate) {
        continue;
      }

      const lowerCandidate = candidate.toLowerCase();
      if (!session.sawBootstrapCommand && session.bootstrapNames.includes(lowerCandidate)) {
        session.sawBootstrapCommand = true;
        continue;
      }

      session.inputPreview = candidate;
      session.name = deriveSessionTitle(candidate, session.fallbackName);
      session.autoNamed = false;
      session.updatedAt = nowIso();
      this.persistSessionName(session);
      return;
    }
  }

  maybeAutoAdvanceClaudeStartup(session) {
    if (!session || session.provider !== "cc" || session.claudeStartupStage >= 2) {
      return;
    }

    const text = stripTerminalControlSequences(session.buffer.slice(-6000));
    if (session.claudeStartupStage < 1 && text.includes("Yes, I trust this folder") && text.includes("No, exit")) {
      session.claudeStartupStage = 1;
      session.shell.write("\r");
      session.updatedAt = nowIso();
      return;
    }

    if (
      session.claudeStartupStage < 2 &&
      text.includes("WARNING: Claude Code running in Bypass Permissions mode") &&
      text.includes("Yes, I accept")
    ) {
      session.claudeStartupStage = 2;
      session.shell.write("\u001b[B");
      setTimeout(() => {
        if (!this.sessions.has(session.id) || session.status === "exited") {
          return;
        }
        session.shell.write("\r");
      }, 150).unref?.();
      session.updatedAt = nowIso();
    }
  }

  saveCustomNames() {
    const payload = Object.fromEntries(
      [...this.customNames.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.customNamesPath, JSON.stringify(payload, null, 2), "utf8");
  }

  saveArchivedSessions() {
    const payload = Object.fromEntries(
      [...this.archivedSessions.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.archivedSessionsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  getCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    return this.customNames.get(key) || null;
  }

  setCustomName(providerId, resumeSessionId, name) {
    const key = customNameKey(providerId, resumeSessionId);
    const value = String(name || "").trim();
    if (!key.endsWith(":") && value) {
      this.customNames.set(key, value);
      this.saveCustomNames();
    }
  }

  removeCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    if (this.customNames.delete(key)) {
      this.saveCustomNames();
    }
  }

  isArchived(providerId, resumeSessionId) {
    return this.archivedSessions.has(archivedSessionKey(providerId, resumeSessionId));
  }

  getArchivedAt(providerId, resumeSessionId) {
    return this.archivedSessions.get(archivedSessionKey(providerId, resumeSessionId)) || null;
  }

  setArchived(providerId, resumeSessionId, archivedAt = nowIso()) {
    const key = archivedSessionKey(providerId, resumeSessionId);
    this.archivedSessions.set(key, archivedAt);
    this.saveArchivedSessions();
  }

  clearArchived(providerId, resumeSessionId) {
    const key = archivedSessionKey(providerId, resumeSessionId);
    if (this.archivedSessions.delete(key)) {
      this.saveArchivedSessions();
    }
  }

  getHistoricalSession(providerId, resumeSessionId, { archived = null } = {}) {
    const provider = this.getProvider(providerId);
    return this.listHistoricalSessionsForProvider(provider, { archived }).find(
      (session) => session.resumeSessionId === String(resumeSessionId || "").trim()
    ) || null;
  }

  archiveHistoricalSession(providerId, resumeSessionId) {
    const session = this.getHistoricalSession(providerId, resumeSessionId, { archived: false });
    if (!session) {
      throw new Error(`Historical session not found: ${providerId}/${resumeSessionId}`);
    }

    this.setArchived(providerId, resumeSessionId);
    return this.getHistoricalSession(providerId, resumeSessionId, { archived: true });
  }

  restoreHistoricalSession(providerId, resumeSessionId) {
    const session = this.getHistoricalSession(providerId, resumeSessionId, { archived: true });
    if (!session) {
      throw new Error(`Archived session not found: ${providerId}/${resumeSessionId}`);
    }

    this.clearArchived(providerId, resumeSessionId);
    return this.getHistoricalSession(providerId, resumeSessionId, { archived: false });
  }

  deleteHistoricalSession(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const targetId = String(resumeSessionId || "").trim();
    const entries = this.scanHistoricalSessionsForProvider(provider).filter((entry) => entry.resumeSessionId === targetId);
    if (!entries.length) {
      throw new Error(`Historical session not found: ${providerId}/${resumeSessionId}`);
    }

    for (const entry of entries) {
      fs.rmSync(entry.filePath, { force: true });
    }
    this.clearArchived(providerId, resumeSessionId);
    this.removeCustomName(providerId, resumeSessionId);
    return true;
  }

  resumeKey(providerId, resumeSessionId) {
    const value = String(resumeSessionId || "").trim();
    if (!value) {
      return "";
    }
    return customNameKey(providerId, value);
  }

  findHistoricalMatch(session) {
    const sessionCreatedAt = Date.parse(String(session?.createdAt || ""));
    const candidates = this.listHistoricalSessions().filter((item) => {
      if (item.provider !== session.provider || item.cwd !== session.cwd) {
        return false;
      }

      if (Number.isNaN(sessionCreatedAt)) {
        return true;
      }

      const itemUpdatedAt = Date.parse(String(item.updatedAt || ""));
      return Number.isNaN(itemUpdatedAt) || itemUpdatedAt >= sessionCreatedAt;
    });
    if (!candidates.length) {
      return null;
    }

    const preview = String(session.inputPreview || "").trim().toLowerCase();
    const withSamePreview = preview
      ? candidates.filter((item) => String(item.inputPreview || "").trim().toLowerCase() === preview)
      : [];
    const pool = withSamePreview.length ? withSamePreview : candidates;
    return [...pool].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  }

  persistSessionName(session) {
    if (!session || session.autoNamed) {
      return false;
    }

    const name = String(session.name || "").trim();
    if (!name) {
      return false;
    }

    if (session.resumeSessionId) {
      this.setCustomName(session.provider, session.resumeSessionId, name);
      return true;
    }

    const historicalSession = this.findHistoricalMatch(session);
    if (historicalSession?.resumeSessionId) {
      this.setCustomName(session.provider, historicalSession.resumeSessionId, name);
      return true;
    }

    return false;
  }

  scheduleDeferredNamePersistence(session) {
    if (!session || session.autoNamed || session.resumeSessionId) {
      return;
    }

    const snapshot = {
      provider: session.provider,
      cwd: session.cwd,
      inputPreview: session.inputPreview,
      name: session.name,
      createdAt: session.createdAt,
      autoNamed: false,
      resumeSessionId: null
    };

    let attempts = 0;
    const tryPersist = () => {
      attempts += 1;
      if (this.persistSessionName(snapshot) || attempts >= 12) {
        return;
      }
      setTimeout(tryPersist, 250).unref?.();
    };

    setTimeout(tryPersist, 150).unref?.();
  }

  buildProviderCommand(session) {
    const provider = this.getProvider(session.provider);
    return provider.buildCommand({
      resumeSessionId: session.resumeSessionId,
      name: session.autoNamed ? "" : session.name
    });
  }
}
