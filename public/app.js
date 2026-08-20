const term = new window.Terminal({
  cursorBlink: false,
  convertEol: true,
  customGlyphs: false,
  fontSize: 11,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  lineHeight: 1,
  scrollback: 5000,
  smoothScrollDuration: 0,
  theme: {
    background: "#111318",
    foreground: "#f3f4f6",
    selectionBackground: "#3b82f655",
    selectionInactiveBackground: "#3b82f633"
  }
});

const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

const tokenInput = document.getElementById("token");
const cwdInput = document.getElementById("cwd");
const nameInput = document.getElementById("session-name");
const providerSelect = document.getElementById("session-provider");
const connectButton = document.getElementById("connect");
const newSessionButton = document.getElementById("new-session");
const closeSessionButton = document.getElementById("close-session");
const cwdPickerRoot = document.getElementById("cwd-picker");
const cwdPickerMetaRoot = document.getElementById("cwd-picker-meta");
const cwdPickerListRoot = document.getElementById("cwd-picker-list");
const browseUpButton = document.getElementById("browse-up");
const syncBrowserPathButton = document.getElementById("sync-browser-path");
const sessionsRoot = document.getElementById("sessions");
const sessionHistoryToolbarRoot = document.getElementById("session-history-toolbar");
const homeStatusRoot = document.getElementById("home-status");
const browserCurrentRoot = document.getElementById("browser-current");
const directorySummaryRoot = document.getElementById("directory-summary");
const directoryTreeRoot = document.getElementById("directory-tree");
const activeSessionNameRoot = document.getElementById("active-session-name");
const editSessionNameButton = document.getElementById("edit-session-name");
const sessionNameEditorRoot = document.getElementById("session-name-editor");
const sessionNameInlineInput = document.getElementById("session-name-inline");
const saveSessionNameButton = document.getElementById("save-session-name");
const cancelSessionNameButton = document.getElementById("cancel-session-name");
const activeSessionMetaRoot = document.getElementById("active-session-meta");
const activeSessionProviderRoot = document.getElementById("active-session-provider");
const viewConnect = document.getElementById("view-connect");
const viewWorkspace = document.getElementById("view-workspace");
const workspaceHome = document.getElementById("workspace-home");
const workspaceTerminal = document.getElementById("workspace-terminal");
const terminalTopbar = workspaceTerminal?.querySelector(".terminal-topbar");
const sessionPanel = document.getElementById("session-panel");
const panelBackdrop = document.getElementById("panel-backdrop");
const openPanelButton = document.getElementById("open-panel");
const closePanelButton = document.getElementById("close-panel");
const backToConnectButton = document.getElementById("back-to-connect");
const backToSessionsButton = document.getElementById("back-to-sessions");
const terminalRoot = document.getElementById("terminal");
const mobileComposer = document.getElementById("mobile-composer");
const imeBridge = document.getElementById("ime-bridge");
const composerEscButton = document.getElementById("composer-esc");
const composerSendButton = document.getElementById("composer-send");
const escKeyButton = document.getElementById("esc-key");
const copyTerminalButton = document.getElementById("copy-terminal");
const pasteTerminalButton = document.getElementById("paste-terminal");
const clipboardSheet = document.getElementById("clipboard-sheet");
const clipboardTitle = document.getElementById("clipboard-title");
const clipboardHint = document.getElementById("clipboard-hint");
const clipboardBuffer = document.getElementById("clipboard-buffer");
const clipboardPrimaryButton = document.getElementById("clipboard-primary");
const clipboardCloseButton = document.getElementById("clipboard-close");
const terminalArrowButtons = [...document.querySelectorAll(".terminal-arrow-key")];
const terminalScrollbarRoot = document.getElementById("terminal-scrollbar");
const terminalScrollbarThumb = document.getElementById("terminal-scrollbar-thumb");

let accessToken = "";
let activeSessionId = "";
let activeSession = null;
let socket = null;
let sessions = [];
let reconnectTimer = null;
let isManualDisconnect = false;
const ignoredSocketEvents = new WeakSet();
let isAuthenticated = false;
// Which session's output the terminal currently holds, and how far into that
// session's stream it has been written. Together they decide whether a
// reconnect can pick up where it left off or has to rebuild the screen.
let terminalSessionId = "";
let terminalStreamOffset = 0;
let pendingOutput = "";
let outputFrame = null;
let viewportFrame = null;
let keyboardWasOpen = false;
let fittingTerminal = false;
let lastSentCols = 0;
let lastSentRows = 0;
let lastFitWidth = 0;
let lastFitHeight = 0;
let imeComposing = false;
let clipboardMode = "";
let latestStatus = "Disconnected";
let mobileComposerValue = "";
let defaultCwd = "";
let displayTimezone = "Australia/Melbourne";
let displayTimeFormatter = null;
let displayCardTimeFormatter = null;
let cwdPickerRequestId = 0;
let editingSessionName = false;
let defaultProvider = "codex";
let providerCatalog = [
  { id: "codex", label: "Codex", cliLabel: "Codex CLI", historyLabel: "Saved Codex threads" },
  { id: "cc", label: "Claude", cliLabel: "Claude CLI", historyLabel: "Saved Claude threads" }
];
let historyProviderFilter = "";
let browserState = {
  path: "",
  parentPath: "",
  entries: [],
  totalEntries: 0,
  truncated: false
};

const useImeBridge = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const enableMobileComposer = false;
document.documentElement.classList.toggle("touch-input-mode", useImeBridge);
document.documentElement.classList.toggle("mobile-composer-disabled", !enableMobileComposer);

function getDisplayTimeFormatter() {
  if (!displayTimeFormatter) {
    displayTimeFormatter = new Intl.DateTimeFormat("en-AU", {
      timeZone: displayTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short"
    });
  }
  return displayTimeFormatter;
}

function getDisplayCardTimeFormatter() {
  if (!displayCardTimeFormatter) {
    displayCardTimeFormatter = new Intl.DateTimeFormat("en-AU", {
      timeZone: displayTimezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }
  return displayCardTimeFormatter;
}

function getProviderInfo(providerId) {
  return (
    providerCatalog.find((provider) => provider.id === providerId) ||
    providerCatalog[0] || {
      id: providerId || "codex",
      label: String(providerId || "codex").toUpperCase(),
      cliLabel: "CLI",
      historyLabel: "Saved threads"
    }
  );
}

function applyProviderCatalog(nextProviders = []) {
  const availableProviders = Array.isArray(nextProviders) && nextProviders.length ? nextProviders : providerCatalog;
  providerCatalog = availableProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    cliLabel: provider.cliLabel,
    historyLabel:
      provider.historyLabel === `Saved ${provider.label} sessions`
        ? `Saved ${provider.label} threads`
        : provider.historyLabel === "Saved sessions"
          ? "Saved threads"
          : provider.historyLabel
  }));

  const currentValue = providerSelect.value || defaultProvider;
  providerSelect.innerHTML = "";
  for (const provider of providerCatalog) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    providerSelect.appendChild(option);
  }

  const preferredValue = providerCatalog.some((provider) => provider.id === currentValue)
    ? currentValue
    : providerCatalog[0]?.id || "codex";
  providerSelect.value = preferredValue;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function normalizeTextForTerminalPaste(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getSessionInterruptConfig() {
  if (activeSession?.provider === "cc") {
    return {
      label: "Interrupt",
      composerLabel: "Stop",
      ariaLabel: "Interrupt Claude",
      data: "\u0003"
    };
  }

  return {
    label: "Esc",
    composerLabel: "Esc",
    ariaLabel: "Send Escape",
    data: "\u001b"
  };
}

function formatTextForSessionPaste(value) {
  const normalized = normalizeTextForTerminalPaste(value);
  if (activeSession?.provider === "cc") {
    return `\u001b[200~${normalized}\u001b[201~`;
  }
  return normalized.replace(/\n/g, "\r");
}

function updateInterruptButtons() {
  const control = getSessionInterruptConfig();
  escKeyButton.textContent = control.label;
  escKeyButton.setAttribute("aria-label", control.ariaLabel);
  composerEscButton.textContent = control.composerLabel;
  composerEscButton.setAttribute("aria-label", control.ariaLabel);
}

function sendInterruptControl() {
  sendToSession(getSessionInterruptConfig().data);
}

function readTerminalBufferText() {
  const buffer = term.buffer.active;
  const lines = [];
  let currentLine = "";
  let hasLine = false;

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    if (!hasLine) {
      currentLine = text;
      hasLine = true;
      continue;
    }

    if (line.isWrapped) {
      currentLine += text;
      continue;
    }

    lines.push(currentLine);
    currentLine = text;
  }

  if (hasLine) {
    lines.push(currentLine);
  }

  return lines.join("\n");
}

function closeClipboardSheet({ restoreFocus = true } = {}) {
  clipboardMode = "";
  clipboardSheet.classList.add("hidden");
  clipboardSheet.setAttribute("aria-hidden", "true");
  clipboardBuffer.value = "";
  clipboardBuffer.readOnly = false;

  if (!restoreFocus) {
    return;
  }

  if (useImeBridge) {
    focusImeBridge();
    return;
  }

  term.focus();
}

function openClipboardSheet(mode) {
  clipboardMode = mode;
  blurImeBridge();
  clipboardSheet.classList.remove("hidden");
  clipboardSheet.setAttribute("aria-hidden", "false");

  if (mode === "copy") {
    const text = readTerminalBufferText();
    if (!text.trim()) {
      closeClipboardSheet({ restoreFocus: false });
      setStatus("No terminal output available to copy.");
      return;
    }

    clipboardTitle.textContent = "Copy Terminal Text";
    clipboardHint.textContent = "Long-press below to select any part of the terminal output.";
    clipboardPrimaryButton.textContent = "Copy All";
    clipboardBuffer.readOnly = true;
    clipboardBuffer.value = text;
  } else {
    clipboardTitle.textContent = "Paste Into Terminal";
    clipboardHint.textContent = "Long-press inside the box, paste text, then send it to the terminal.";
    clipboardPrimaryButton.textContent = "Send to Terminal";
    clipboardBuffer.readOnly = false;
    clipboardBuffer.value = "";
  }

  window.requestAnimationFrame(() => {
    clipboardBuffer.focus({ preventScroll: true });
    const length = clipboardBuffer.value.length;
    clipboardBuffer.setSelectionRange(length, length);
    if (mode === "copy") {
      clipboardBuffer.scrollTop = clipboardBuffer.scrollHeight;
    }
  });
}

function isClipboardSheetOpen() {
  return !clipboardSheet.classList.contains("hidden");
}

async function handleClipboardPrimaryAction() {
  if (clipboardMode === "copy") {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardBuffer.value);
        setStatus("Terminal text copied.");
      } else {
        setStatus("Text selected. Use your browser copy action.");
      }
    } catch {
      setStatus("Text selected. Use your browser copy action.");
    }
    return;
  }

  const text = clipboardBuffer.value;
  if (!text) {
    setStatus("Paste text into the box first.");
    return;
  }

  sendToSession(formatTextForSessionPaste(text));
  closeClipboardSheet();
  scrollTerminalToLatest({ force: true });
  setStatus("Clipboard text sent to terminal.");
}

function flushPendingOutput() {
  outputFrame = null;
  if (!pendingOutput) {
    return;
  }

  const wasAtBottom = isTerminalAtBottom();
  term.write(pendingOutput);
  pendingOutput = "";
  if (wasAtBottom) {
    scrollTerminalToLatest({ force: true });
  }
  layoutTerminalScrollbar();
}

// Clearing the screen invalidates the resume offset with it: whatever the
// server would send from that point on would land on top of nothing.
function resetTerminalContent() {
  pendingOutput = "";
  if (outputFrame !== null) {
    window.cancelAnimationFrame(outputFrame);
    outputFrame = null;
  }
  term.reset();
  terminalSessionId = "";
  terminalStreamOffset = 0;
  layoutTerminalScrollbar();
}

function queueTerminalOutput(chunk) {
  if (!chunk) {
    return;
  }

  pendingOutput += chunk;
  if (outputFrame === null) {
    outputFrame = window.requestAnimationFrame(flushPendingOutput);
  }
}

function isTextInputFocused() {
  const element = document.activeElement;
  if (!element || element === document.body) {
    return false;
  }

  const tagName = element.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || element.isContentEditable === true;
}

// Reading the buffer beats comparing scroll pixels: pixel offsets drift while
// the mobile URL bar animates, which is exactly when we must not guess wrong.
function isTerminalAtBottom() {
  const buffer = term.buffer?.active;
  if (buffer) {
    return buffer.viewportY >= buffer.baseY;
  }

  const viewport = terminalRoot.querySelector(".xterm-viewport");
  if (!viewport) {
    return true;
  }

  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 8;
}

// Stick-to-bottom is an explicit decision made by the caller. Pass force only
// for a deliberate user action or for new output that arrived while already at
// the bottom. Never call this from a viewport measurement path: measurements
// fire on every visualViewport scroll, and snapping there steals the scroll
// gesture the user is in the middle of.
function scrollTerminalToLatest({ ensureVisible = false, force = false } = {}) {
  if (!force && !isTerminalAtBottom()) {
    return;
  }

  const run = () => {
    if (ensureVisible) {
      terminalRoot.scrollIntoView({
        block: "end",
        inline: "nearest"
      });
    }

    term.scrollToBottom?.();
    const viewport = terminalRoot.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  };

  window.requestAnimationFrame(() => {
    run();
    window.requestAnimationFrame(run);
    window.setTimeout(run, 80);
    window.setTimeout(run, 220);
  });
}

// --- Scrolling the terminal by touch, and the overlay scrollbar ------------
//
// There are two scroll models. In the normal buffer, history lives in xterm's
// scrollback and both native touch scrolling and a positional scrollbar work
// on it directly. In the alternate buffer (the claude CLI lives there) the
// application owns its screen: xterm has no scrollback and, with mouse
// reporting active, ignores touch entirely. Scrolling that screen means
// speaking the application's language, and the one dialect every TUI speaks is
// the mouse wheel: xterm forwards wheel events as wheel reports (or arrow
// keys) for the application to scroll itself. So a swipe here is translated
// into synthetic wheel events, one per line of finger travel, and the same
// translation backs the scrollbar when it has no position to show.

function terminalOwnsScrolling() {
  return term.buffer?.active?.type === "alternate";
}

function terminalCellHeight() {
  const rows = terminalRoot.querySelector(".xterm-rows");
  const height = rows && term.rows > 0 ? rows.clientHeight / term.rows : 0;
  return height > 4 ? height : 17;
}

function emitTerminalWheel(lines) {
  const target = terminalRoot.querySelector(".xterm");
  if (!target || !lines) {
    return;
  }

  // Wheel reports carry a cell position, and xterm drops the event outright
  // when the coordinates fall outside its screen. Aim at the screen's center.
  const screen = terminalRoot.querySelector(".xterm-screen") || target;
  const rect = screen.getBoundingClientRect();
  const step = Math.sign(lines) * terminalCellHeight();
  const count = Math.min(Math.abs(lines), 60);
  for (let i = 0; i < count; i += 1) {
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: step,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      })
    );
  }
}

const touchScroll = {
  tracking: false,
  lastY: 0,
  lastTime: 0,
  remainder: 0,
  velocity: 0,
  flingFrame: null
};

function stopTerminalFling() {
  if (touchScroll.flingFrame !== null) {
    window.cancelAnimationFrame(touchScroll.flingFrame);
    touchScroll.flingFrame = null;
  }
}

// Momentum for the synthetic path: without it, one screen of claude history
// costs a full swipe. Decay tuned to feel like a plain list fling.
function startTerminalFling() {
  if (Math.abs(touchScroll.velocity) < 0.35) {
    return;
  }

  let velocity = touchScroll.velocity;
  let remainder = 0;
  let lastTime = performance.now();
  const stepFrame = (now) => {
    touchScroll.flingFrame = null;
    if (!terminalOwnsScrolling() || !hasLiveSession()) {
      return;
    }

    const elapsed = Math.min(64, Math.max(1, now - lastTime));
    lastTime = now;
    remainder += velocity * elapsed;
    velocity *= Math.pow(0.945, elapsed / 16);
    const cell = terminalCellHeight();
    const lines = Math.trunc(remainder / cell);
    remainder -= lines * cell;
    emitTerminalWheel(lines);
    if (Math.abs(velocity) > 0.05) {
      touchScroll.flingFrame = window.requestAnimationFrame(stepFrame);
    }
  };
  touchScroll.flingFrame = window.requestAnimationFrame(stepFrame);
}

terminalRoot.addEventListener(
  "touchstart",
  (ev) => {
    stopTerminalFling();
    showTerminalScrollbar();
    if (!terminalOwnsScrolling() || ev.touches.length !== 1) {
      touchScroll.tracking = false;
      return;
    }

    touchScroll.tracking = true;
    touchScroll.lastY = ev.touches[0].clientY;
    touchScroll.lastTime = ev.timeStamp;
    touchScroll.remainder = 0;
    touchScroll.velocity = 0;
  },
  { passive: true }
);

terminalRoot.addEventListener(
  "touchmove",
  (ev) => {
    if (!touchScroll.tracking) {
      return;
    }
    if (!terminalOwnsScrolling() || ev.touches.length !== 1 || !hasLiveSession()) {
      touchScroll.tracking = false;
      return;
    }

    const y = ev.touches[0].clientY;
    const delta = touchScroll.lastY - y;
    const elapsed = Math.max(1, ev.timeStamp - touchScroll.lastTime);
    touchScroll.velocity = 0.75 * (delta / elapsed) + 0.25 * touchScroll.velocity;
    touchScroll.lastY = y;
    touchScroll.lastTime = ev.timeStamp;
    touchScroll.remainder += delta;
    const cell = terminalCellHeight();
    const lines = Math.trunc(touchScroll.remainder / cell);
    touchScroll.remainder -= lines * cell;
    emitTerminalWheel(lines);
    showTerminalScrollbar();
    // The gesture belongs to the application now; anything the browser would
    // do with it (rubber-banding, pull-to-refresh) only fights the scroll.
    ev.preventDefault();
  },
  { passive: false }
);

const endTouchScroll = () => {
  if (touchScroll.tracking) {
    touchScroll.tracking = false;
    startTerminalFling();
  }
};
terminalRoot.addEventListener("touchend", endTouchScroll, { passive: true });
terminalRoot.addEventListener("touchcancel", endTouchScroll, { passive: true });

let scrollbarFadeTimer = null;
let scrollbarDrag = null;

function terminalScrollbarMode() {
  if (terminalOwnsScrolling()) {
    return "jog";
  }

  const buffer = term.buffer?.active;
  return buffer && buffer.baseY > 0 ? "position" : "none";
}

function layoutTerminalScrollbar() {
  if (!terminalScrollbarRoot || !terminalScrollbarThumb) {
    return;
  }

  const mode = terminalScrollbarMode();
  terminalScrollbarRoot.classList.toggle("jog", mode === "jog");
  if (mode === "none") {
    terminalScrollbarRoot.classList.remove("visible", "dragging");
    return;
  }

  const track = terminalScrollbarRoot.clientHeight;
  if (track <= 0) {
    return;
  }

  if (mode === "position") {
    const buffer = term.buffer.active;
    const thumbHeight = Math.min(
      track,
      Math.max(36, Math.round((track * term.rows) / buffer.length))
    );
    const maxTop = track - thumbHeight;
    const top = buffer.baseY > 0 ? Math.round((maxTop * buffer.viewportY) / buffer.baseY) : maxTop;
    terminalScrollbarThumb.style.height = `${thumbHeight}px`;
    terminalScrollbarThumb.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
    return;
  }

  // Jog mode has no position to show: a fixed handle rides mid-track, follows
  // the finger while dragging, and springs back on release.
  const thumbHeight = Math.min(track, 56);
  const maxTop = track - thumbHeight;
  const restingTop = Math.round(maxTop / 2);
  const top = scrollbarDrag && scrollbarDrag.mode === "jog"
    ? Math.max(0, Math.min(maxTop, scrollbarDrag.jogTop))
    : restingTop;
  terminalScrollbarThumb.style.height = `${thumbHeight}px`;
  terminalScrollbarThumb.style.top = `${top}px`;
}

function showTerminalScrollbar() {
  if (!terminalScrollbarRoot || terminalScrollbarMode() === "none") {
    return;
  }

  layoutTerminalScrollbar();
  terminalScrollbarRoot.classList.add("visible");
  if (scrollbarFadeTimer !== null) {
    window.clearTimeout(scrollbarFadeTimer);
  }
  scrollbarFadeTimer = window.setTimeout(() => {
    scrollbarFadeTimer = null;
    if (!scrollbarDrag) {
      terminalScrollbarRoot.classList.remove("visible");
    }
  }, 1600);
}

function scrollTerminalToFraction(clientY) {
  const rect = terminalScrollbarRoot.getBoundingClientRect();
  const thumbHeight = terminalScrollbarThumb.getBoundingClientRect().height;
  const span = rect.height - thumbHeight;
  if (span <= 0) {
    return;
  }

  const top = clientY - rect.top - scrollbarDrag.grabOffset;
  const fraction = Math.max(0, Math.min(1, top / span));
  term.scrollToLine(Math.round(fraction * term.buffer.active.baseY));
}

terminalScrollbarRoot?.addEventListener("pointerdown", (ev) => {
  const mode = terminalScrollbarMode();
  if (mode === "none") {
    return;
  }

  stopTerminalFling();
  terminalScrollbarRoot.setPointerCapture(ev.pointerId);
  const thumbRect = terminalScrollbarThumb.getBoundingClientRect();
  const onThumb = ev.clientY >= thumbRect.top && ev.clientY <= thumbRect.bottom;
  scrollbarDrag = {
    mode,
    pointerId: ev.pointerId,
    lastY: ev.clientY,
    remainder: 0,
    jogTop: thumbRect.top - terminalScrollbarRoot.getBoundingClientRect().top,
    grabOffset: onThumb ? ev.clientY - thumbRect.top : thumbRect.height / 2
  };
  terminalScrollbarRoot.classList.add("dragging");
  if (mode === "position") {
    scrollTerminalToFraction(ev.clientY);
  }
  showTerminalScrollbar();
  ev.preventDefault();
});

terminalScrollbarRoot?.addEventListener("pointermove", (ev) => {
  if (!scrollbarDrag || ev.pointerId !== scrollbarDrag.pointerId) {
    return;
  }

  if (scrollbarDrag.mode === "position") {
    scrollTerminalToFraction(ev.clientY);
  } else if (hasLiveSession()) {
    const delta = ev.clientY - scrollbarDrag.lastY;
    scrollbarDrag.lastY = ev.clientY;
    scrollbarDrag.jogTop += delta;
    scrollbarDrag.remainder += delta;
    const cell = terminalCellHeight();
    const lines = Math.trunc(scrollbarDrag.remainder / cell);
    scrollbarDrag.remainder -= lines * cell;
    emitTerminalWheel(lines);
    layoutTerminalScrollbar();
  }
  showTerminalScrollbar();
  ev.preventDefault();
});

const endScrollbarDrag = (ev) => {
  if (!scrollbarDrag || ev.pointerId !== scrollbarDrag.pointerId) {
    return;
  }

  scrollbarDrag = null;
  terminalScrollbarRoot.classList.remove("dragging");
  layoutTerminalScrollbar();
  showTerminalScrollbar();
};
terminalScrollbarRoot?.addEventListener("pointerup", endScrollbarDrag);
terminalScrollbarRoot?.addEventListener("pointercancel", endScrollbarDrag);

term.onScroll(() => {
  layoutTerminalScrollbar();
  showTerminalScrollbar();
});

terminalRoot.addEventListener(
  "wheel",
  () => {
    showTerminalScrollbar();
  },
  { passive: true }
);

function settleTerminalViewport() {
  let firstPass = true;
  const run = () => {
    requestViewportMetrics();
    // The first pass re-fits even when the container reads the same size: a
    // renderer that measured while the page was hidden can hold zeroed cell
    // metrics, which makes fit() a silent no-op. Later passes only absorb
    // layout settling, so they must not force and re-open the flapping window.
    syncTerminalSize({ force: firstPass });
    firstPass = false;
    scrollTerminalToLatest();
  };

  window.requestAnimationFrame(run);
  window.setTimeout(run, 80);
  window.setTimeout(run, 220);
  window.setTimeout(run, 500);
}

function lockRootScrollPosition() {
  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    return;
  }

  const scrollingRoot = document.scrollingElement;
  if (scrollingRoot) {
    scrollingRoot.scrollTop = 0;
    scrollingRoot.scrollLeft = 0;
  }
  window.scrollTo(0, 0);
}

function deferRootScrollLock() {
  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    return;
  }

  window.requestAnimationFrame(() => {
    lockRootScrollPosition();
  });
}

function setComposerExpanded(expanded) {
  if (!enableMobileComposer) {
    workspaceTerminal.classList.remove("composer-active");
    return;
  }
  workspaceTerminal.classList.toggle("composer-active", Boolean(expanded));
}

function syncTerminalChromeBounds() {
  if (!workspaceTerminal) {
    return;
  }

  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    workspaceTerminal.style.removeProperty("--terminal-header-height");
    workspaceTerminal.style.removeProperty("--terminal-composer-height");
    return;
  }

  const headerHeight = Math.ceil(terminalTopbar?.getBoundingClientRect().height || 0);
  const composerHeight = enableMobileComposer
    ? Math.ceil(mobileComposer?.getBoundingClientRect().height || 0)
    : 0;
  const headerOffset = headerHeight > 0 ? headerHeight + 6 : 0;
  const composerOffset = composerHeight > 0 ? composerHeight + 6 : 0;
  workspaceTerminal.style.setProperty("--terminal-header-height", `${headerOffset}px`);
  workspaceTerminal.style.setProperty("--terminal-composer-height", `${composerOffset}px`);

  if (!workspaceTerminal.classList.contains("hidden")) {
    window.requestAnimationFrame(() => {
      syncTerminalSize();
    });
  }
}

function syncComposerLayout() {
  if (!useImeBridge || !enableMobileComposer) {
    return;
  }

  imeBridge.style.height = "0px";
  const keyboardOpen = document.documentElement.classList.contains("keyboard-open");
  const minHeight = workspaceTerminal.classList.contains("composer-active")
    ? keyboardOpen
      ? 30
      : 38
    : 30;
  const maxHeight = keyboardOpen ? 48 : 58;
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, imeBridge.scrollHeight || 0));
  imeBridge.style.height = `${nextHeight}px`;
  syncTerminalChromeBounds();
}

function resetImeBridge() {
  imeBridge.value = "";
  mobileComposerValue = "";
  imeComposing = false;
  syncComposerLayout();
}

function focusImeBridge() {
  if (!useImeBridge || !hasLiveSession() || isClipboardSheetOpen()) {
    return;
  }

  setComposerExpanded(true);
  imeBridge.focus({ preventScroll: true });
  const length = imeBridge.value.length;
  imeBridge.setSelectionRange(length, length);
  syncComposerLayout();
}

function blurImeBridge() {
  if (!useImeBridge) {
    return;
  }

  imeBridge.blur();
  if (!imeBridge.value) {
    setComposerExpanded(false);
  }
}

function syncImeBridgeValue() {
  if (imeComposing) {
    return;
  }

  const nextValue = String(imeBridge.value || "").replace(/\r/g, "");
  if (imeBridge.value !== nextValue) {
    imeBridge.value = nextValue;
  }

  if (nextValue === mobileComposerValue) {
    syncComposerLayout();
    return;
  }

  if (nextValue.startsWith(mobileComposerValue)) {
    sendToSession(nextValue.slice(mobileComposerValue.length));
  } else if (mobileComposerValue.startsWith(nextValue)) {
    sendToSession("\u007f".repeat(mobileComposerValue.length - nextValue.length));
  } else {
    if (mobileComposerValue.length) {
      sendToSession("\u007f".repeat(mobileComposerValue.length));
    }
    if (nextValue) {
      sendToSession(nextValue);
    }
  }

  mobileComposerValue = nextValue;
  syncComposerLayout();
  scrollTerminalToLatest({ force: true });
}

function submitImeBridge() {
  if (!hasLiveSession()) {
    setStatus("Open a thread first.");
    return;
  }

  syncImeBridgeValue();
  sendToSession("\r");
  resetImeBridge();
  focusImeBridge();
  requestViewportMetrics();
  scrollTerminalToLatest({ force: true });
}

function flushImeBridgeValue() {
  syncImeBridgeValue();
}

function applyViewportMetrics() {
  viewportFrame = null;
  const viewport = window.visualViewport;
  const viewportHeight = Math.round(viewport?.height || window.innerHeight);
  const viewportOffsetTop = Math.round(viewport?.offsetTop || 0);
  const keyboardInset = Math.max(0, window.innerHeight - viewportHeight);
  // The inset alone latches: a stale visualViewport reading on resume from the
  // background pins the layout into keyboard mode with no event left to release
  // it. Requiring a focused text input gives the latch an unconditional exit.
  const keyboardOpen = keyboardInset > 120 && isTextInputFocused();
  const keyboardJustOpened = keyboardOpen && !keyboardWasOpen;
  document.documentElement.style.setProperty("--vvh", keyboardOpen ? `${viewportHeight}px` : "100dvh");
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewportHeight}px`);
  document.documentElement.style.setProperty("--visual-viewport-offset-top", `${viewportOffsetTop}px`);
  document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  if (keyboardOpen) {
    deferRootScrollLock();
  }
  if (useImeBridge) {
    if (keyboardOpen) {
      setComposerExpanded(true);
    } else if (!imeBridge.matches(":focus") && !imeBridge.value) {
      setComposerExpanded(false);
    }
    syncComposerLayout();
  }
  syncTerminalSize();
  if (keyboardJustOpened) {
    scrollTerminalToLatest({ force: true });
  }
  if (
    keyboardOpen &&
    useImeBridge &&
    hasLiveSession() &&
    !document.hidden &&
    !isClipboardSheetOpen() &&
    !imeBridge.matches(":focus")
  ) {
    focusImeBridge();
  }
  keyboardWasOpen = keyboardOpen;
}

function requestViewportMetrics() {
  if (viewportFrame !== null) {
    return;
  }

  viewportFrame = window.requestAnimationFrame(applyViewportMetrics);
}

function hasLiveSession() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN && activeSessionId);
}

function setView(name) {
  const workspace = name === "workspace";
  viewConnect.classList.toggle("hidden", workspace);
  viewWorkspace.classList.toggle("hidden", !workspace);
}

function setWorkspaceScreen(name) {
  const terminal = name === "terminal";
  workspaceHome.classList.toggle("hidden", terminal);
  workspaceTerminal.classList.toggle("hidden", !terminal);
  document.documentElement.classList.toggle("terminal-layer-mode", terminal && useImeBridge);
  if (!terminal) {
    setComposerExpanded(false);
  }
  deferRootScrollLock();
  syncTerminalChromeBounds();
  syncComposerLayout();
  if (terminal && useImeBridge && hasLiveSession()) {
    window.requestAnimationFrame(() => {
      focusImeBridge();
    });
  }
}

function setPanelOpen(open) {
  sessionPanel.classList.toggle("open", open);
  panelBackdrop.classList.toggle("hidden", !open);
  sessionPanel.setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("panel-open", open);
}

function updateInputControls() {
  const enabled = hasLiveSession();
  updateInterruptButtons();
  escKeyButton.disabled = !enabled;
  imeBridge.disabled = !enabled;
  composerEscButton.disabled = !enabled || !enableMobileComposer;
  composerSendButton.disabled = !enabled || !enableMobileComposer;
  copyTerminalButton.disabled = !activeSessionId;
  pasteTerminalButton.disabled = !enabled;
  closeSessionButton.disabled = !activeSessionId;
  editSessionNameButton.disabled = !activeSessionId;
  for (const button of terminalArrowButtons) {
    button.disabled = !enabled;
  }

  if (!enabled) {
    resetImeBridge();
    blurImeBridge();
    setComposerExpanded(false);
    clearReconnectTimer();
    editingSessionName = false;
    sessionNameEditorRoot.classList.add("hidden");
  }
}

function setStatus(text) {
  latestStatus = String(text || "").trim() || "Disconnected";
  if (homeStatusRoot) {
    homeStatusRoot.textContent = latestStatus;
  }
  updateWorkspaceSummary();
}

function headers() {
  return {
    "Content-Type": "application/json"
  };
}

function formatTime(value) {
  try {
    return getDisplayTimeFormatter().format(new Date(value));
  } catch {
    return value || "";
  }
}

function formatCardTime(value) {
  try {
    return getDisplayCardTimeFormatter().format(new Date(value));
  } catch {
    return value || "";
  }
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 102.4) / 10} KB`;
  }
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

async function copyText(text, fallbackStatus) {
  const value = String(text || "");
  if (!value) {
    return false;
  }

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fallback to selection-based copy below.
  }

  clipboardTitle.textContent = "Copy Path";
  clipboardHint.textContent = "Select the path below and use your browser copy action.";
  clipboardPrimaryButton.textContent = "Select All";
  clipboardMode = "copy";
  clipboardSheet.classList.remove("hidden");
  clipboardSheet.setAttribute("aria-hidden", "false");
  clipboardBuffer.readOnly = true;
  clipboardBuffer.value = value;

  window.requestAnimationFrame(() => {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
  });

  if (fallbackStatus) {
    setStatus(fallbackStatus);
  }
  return false;
}

function updateWorkspaceSummaryLegacy() {
  return;

  if (activeSession) {
    const parts = [activeSession.status || "unknown"];
    if (activeSession.cwd) {
      parts.push(activeSession.cwd);
    }
    activeSessionMetaRoot.textContent = parts.join(" · ");
  } else {
    activeSessionMetaRoot.textContent = "Connect, then open a thread.";
  }

  browserPillRoot.textContent = browserState.path || "Not loaded";
}

function openSessionNameEditor() {
  if (!activeSessionId || !activeSession) {
    return;
  }

  editingSessionName = true;
  sessionNameInlineInput.value = activeSession.name || "";
  sessionNameEditorRoot.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    sessionNameInlineInput.focus({ preventScroll: true });
    sessionNameInlineInput.select();
  });
}

function closeSessionNameEditor() {
  editingSessionName = false;
  sessionNameEditorRoot.classList.add("hidden");
  sessionNameInlineInput.value = "";
}

function updateWorkspaceSummary() {
  activeSessionProviderRoot.textContent = activeSession?.cliLabel || getProviderInfo(providerSelect.value).cliLabel || "CLI";
  activeSessionNameRoot.textContent = activeSession?.name || "No active thread";
  sessionNameEditorRoot.classList.toggle("hidden", !editingSessionName);

  if (activeSession) {
    const parts = [];
    if (latestStatus) {
      parts.push(latestStatus);
    }
    if (activeSession.status && activeSession.status !== latestStatus) {
      parts.push(activeSession.status);
    }
    if (activeSession.cwd) {
      parts.push(activeSession.cwd);
    }
    activeSessionMetaRoot.textContent = parts.join(" | ");
    return;
  }

  activeSessionMetaRoot.textContent = "Open a thread to start.";
}

async function renameActiveSession() {
  if (!activeSessionId) {
    return;
  }

  const nextName = String(sessionNameInlineInput.value || "").trim();
  if (!nextName) {
    setStatus("Enter a thread name.");
    sessionNameInlineInput.focus({ preventScroll: true });
    return;
  }

  try {
    const payload = await request(`/api/sessions/${activeSessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nextName })
    });
    const updatedSession = payload.session;
    sessions = sessions.map((session) => (session.id === updatedSession.id ? updatedSession : session));
    activeSession = updatedSession;
    renderSessions();
    closeSessionNameEditor();
    updateWorkspaceSummary();
    setStatus(`Thread renamed to ${updatedSession.name}`);
  } catch (err) {
    setStatus(err.message || String(err));
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.headers || {}),
      ...headers()
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401) {
      isAuthenticated = false;
    }
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
}

async function loginWithToken(token) {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  isAuthenticated = true;
}

async function logoutSession() {
  try {
    await request("/api/logout", { method: "POST" });
  } catch {
    // Ignore logout failures during local UI reset.
  }
  isAuthenticated = false;
}

function buildSectionLabel(text) {
  const label = document.createElement("div");
  label.className = "session-section-label";
  label.textContent = text;
  return label;
}

function buildSectionHead(text, extraNode = null) {
  const head = document.createElement("div");
  head.className = "session-section-head";
  head.appendChild(buildSectionLabel(text));
  if (extraNode) {
    head.appendChild(extraNode);
  }
  return head;
}

function buildThreadListSection(title, items, { extraNode = null, emptyState = null } = {}) {
  const section = document.createElement("section");
  section.className = "thread-list-section";
  section.appendChild(buildSectionHead(title, extraNode));

  const list = document.createElement("div");
  list.className = "thread-list-scroll";
  if (items.length) {
    for (const session of items) {
      list.appendChild(buildSessionCard(session));
    }
  } else if (emptyState) {
    list.appendChild(emptyState);
  }
  section.appendChild(list);
  return section;
}

function buildEmptyState(title, description) {
  const empty = document.createElement("div");
  empty.className = "session-empty";

  const heading = document.createElement("h3");
  heading.textContent = title;
  empty.appendChild(heading);

  const body = document.createElement("p");
  body.textContent = description;
  empty.appendChild(body);
  return empty;
}

function buildBadge(text, extraClass = "") {
  const badge = document.createElement("span");
  badge.className = `session-badge${extraClass ? ` ${extraClass}` : ""}`;
  badge.textContent = text;
  return badge;
}

function getHistoryProviderFilter() {
  const availableProviders = providerCatalog;
  if (!availableProviders.length) {
    historyProviderFilter = "";
    return "";
  }

  if (historyProviderFilter && availableProviders.some((provider) => provider.id === historyProviderFilter)) {
    return historyProviderFilter;
  }

  if (activeSession?.provider && availableProviders.some((provider) => provider.id === activeSession.provider)) {
    historyProviderFilter = activeSession.provider;
    return historyProviderFilter;
  }

  historyProviderFilter = availableProviders[0].id;
  return historyProviderFilter;
}

function buildHistoryToggle() {
  const availableProviders = providerCatalog;
  if (availableProviders.length <= 1) {
    return null;
  }

  const currentFilter = getHistoryProviderFilter();
  const toggle = document.createElement("div");
  toggle.className = "session-history-toggle";

  for (const provider of availableProviders) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ghost session-history-toggle-button${provider.id === currentFilter ? " active" : ""}`;
    button.textContent = provider.label;
    button.addEventListener("click", () => {
      historyProviderFilter = provider.id;
      renderSessions();
    });
    toggle.appendChild(button);
  }

  return toggle;
}

function renderSessions() {
  sessionsRoot.innerHTML = "";
  if (sessionHistoryToolbarRoot) {
    sessionHistoryToolbarRoot.innerHTML = "";
    sessionHistoryToolbarRoot.classList.add("hidden");
  }
  const liveSessions = sessions.filter((session) => session.kind === "live");
  const savedSessions = sessions.filter((session) => session.kind === "history");

  if (!sessions.length) {
    sessionsRoot.appendChild(
      buildEmptyState(
        "No threads yet",
        "Create a new thread here. If the name is blank, the first prompt will become the title."
      )
    );
    return;
  }

  if (liveSessions.length) {
    sessionsRoot.appendChild(buildThreadListSection("Live", liveSessions));
  }

  if (savedSessions.length || providerCatalog.length > 1) {
    const currentFilter = getHistoryProviderFilter();
    const toggle = buildHistoryToggle();
    const provider = getProviderInfo(currentFilter);
    const filteredHistory = savedSessions.filter((session) => session.provider === currentFilter);
    sessionsRoot.appendChild(
      buildThreadListSection(provider.historyLabel || "History", filteredHistory, {
        extraNode: toggle,
        emptyState: buildEmptyState(
          `No ${String(provider.historyLabel || `saved ${provider.label} threads`).toLowerCase()}`,
          "Create a new thread or switch providers."
        )
      })
    );
  }
}

function buildCompactSessionMeta(text, extraClass = "") {
  const item = document.createElement("p");
  item.className = `session-meta-line compact${extraClass ? ` ${extraClass}` : ""}`;

  const body = document.createElement("span");
  body.className = "session-meta-value";
  body.textContent = text || "--";
  item.appendChild(body);

  return item;
}

function buildSessionCard(session) {
  const card = document.createElement("button");
  const isCurrent = session.kind === "live" && session.id === activeSessionId;
  card.className = `session-card${isCurrent ? " active" : ""}`;

  const head = document.createElement("div");
  head.className = "session-card-head";

  const title = document.createElement("h3");
  title.textContent = session.name;
  head.appendChild(title);

  const badgeRow = document.createElement("div");
  badgeRow.className = "session-badge-row";
  badgeRow.appendChild(buildBadge(session.providerLabel || getProviderInfo(session.provider).label, "ghost-badge"));
  if (isCurrent) {
    badgeRow.appendChild(buildBadge("Current"));
  }
  if (session.kind === "history") {
    badgeRow.appendChild(buildBadge("Saved", "ghost-badge"));
  }
  if (session.meta?.kind === "worker") {
    badgeRow.appendChild(
      buildBadge(
        [session.meta.ticket ? `#${session.meta.ticket}` : "", session.meta.phase || ""].join(" ").trim() || "orch",
        "ghost-badge"
      )
    );
  }
  head.appendChild(badgeRow);
  card.appendChild(head);

  if (session.inputPreview) {
    const preview = document.createElement("p");
    preview.className = "session-preview";
    preview.textContent = session.inputPreview;
    card.appendChild(preview);
  }

  const metaGrid = document.createElement("div");
  metaGrid.className = "session-meta-grid";
  const summaryParts = [];
  if (session.status) {
    summaryParts.push(session.status);
  }
  if (session.updatedAt) {
    summaryParts.push(formatCardTime(session.updatedAt));
  }
  if (summaryParts.length) {
    metaGrid.appendChild(buildCompactSessionMeta(summaryParts.join(" · ")));
  }
  if (session.cwd) {
    metaGrid.appendChild(buildCompactSessionMeta(session.cwd, "session-meta-path"));
  }
  card.appendChild(metaGrid);

  card.addEventListener("click", () => activateSessionFromList(session));
  return card;
}

function buildSessionMeta(label, value) {
  const item = document.createElement("p");
  item.className = "session-meta-line";

  const caption = document.createElement("span");
  caption.className = "session-meta-label";
  caption.textContent = `${label}: `;
  item.appendChild(caption);

  const body = document.createElement("span");
  body.className = "session-meta-value";
  /*
  body.textContent = value || "—";
  item.appendChild(body);
  */
  body.textContent = value || "--";
  item.appendChild(body);

  return item;
}

async function activateSessionFromList(session) {
  if (session.kind === "history") {
    try {
      const payload = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: session.provider,
          cwd: session.cwd,
          name: session.name,
          resumeSessionId: session.resumeSessionId
        })
      });
      await refreshSessions();
      await openSession(payload.session.id);
      await loadDirectory(session.cwd);
    } catch (err) {
      setStatus(err.message || String(err));
    }
    return;
  }

  await openSession(session.id);
  await loadDirectory(session.cwd);
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  sessions = payload.sessions || [];
  activeSession = sessions.find((session) => session.id === activeSessionId) || activeSession;
  if (activeSessionId && !sessions.some((session) => session.id === activeSessionId)) {
    activeSession = null;
    activeSessionId = "";
  }
  renderSessions();
  updateWorkspaceSummary();
  updateInputControls();
}

function sendTerminalResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (term.cols === lastSentCols && term.rows === lastSentRows) {
    return;
  }

  lastSentCols = term.cols;
  lastSentRows = term.rows;
  socket.send(
    JSON.stringify({
      type: "resize",
      cols: term.cols,
      rows: term.rows
    })
  );
}

// fitAddon.fit() calls term.resize(), which fires term.onResize. Re-entering
// fit() from that handler recurses until the stack blows, so the handler only
// reports the new size and this guard covers any other path back in.
//
// Cell width is measured in device pixels and rounded, so on a fractional
// devicePixelRatio it lands on two different values either side of a column
// boundary. Re-fitting an unchanged container therefore flaps the column count
// forever. Fit is a function of container size, so only run it when that moved.
function syncTerminalSize({ force = false } = {}) {
  if (fittingTerminal) {
    return;
  }

  const rect = terminalRoot.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!force && width === lastFitWidth && height === lastFitHeight) {
    sendTerminalResize();
    return;
  }

  lastFitWidth = width;
  lastFitHeight = height;
  fittingTerminal = true;
  try {
    fitAddon.fit();
  } finally {
    fittingTerminal = false;
  }

  sendTerminalResize();
}

function disconnectSocket() {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    ignoredSocketEvents.add(currentSocket);
    currentSocket.close();
  }
  updateInputControls();
}

function scheduleReconnect(sessionId = activeSessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId || !isAuthenticated || document.hidden || reconnectTimer || hasLiveSession()) {
    return;
  }

  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;
    if (
      !targetSessionId ||
      !isAuthenticated ||
      document.hidden ||
      hasLiveSession() ||
      activeSessionId !== targetSessionId
    ) {
      return;
    }

    try {
      await connectToSession(targetSessionId, { allowReconnect: true });
    } catch (err) {
      setStatus(err.message || String(err));
      scheduleReconnect(targetSessionId);
    }
  }, 600);
}

async function connectToSession(sessionId, { allowReconnect = false } = {}) {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    ignoredSocketEvents.add(currentSocket);
    currentSocket.close();
  }

  activeSessionId = sessionId;
  activeSession = sessions.find((session) => session.id === sessionId) || activeSession;
  closeSessionNameEditor();
  renderSessions();
  updateWorkspaceSummary();
  setWorkspaceScreen("terminal");
  setPanelOpen(false);

  // Reconnecting to the session already on screen keeps that screen: term.reset()
  // would throw away a scrollback the server cannot rebuild, since all it has is
  // the tail of the raw stream. Switching sessions still clears, so the old
  // session's output is not left sitting under the new one's.
  const resumeOffset = terminalSessionId === sessionId ? terminalStreamOffset : null;
  if (resumeOffset === null) {
    resetTerminalContent();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({ sessionId });
  if (resumeOffset !== null) {
    query.set("since", String(resumeOffset));
  }
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws?${query}`);
  socket = ws;

  ws.addEventListener("open", async () => {
    setStatus("connected");
    lastSentCols = 0;
    lastSentRows = 0;
    syncTerminalSize({ force: true });
    if (useImeBridge) {
      focusImeBridge();
    } else {
      term.focus();
    }
    updateInputControls();
    await refreshSessions();
  });

  ws.addEventListener("message", async (event) => {
    // A superseded socket can still deliver what it had already buffered, and
    // counting those bytes would leave the resume offset pointing at output
    // this terminal never showed.
    if (socket !== ws) {
      return;
    }

    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      activeSession = payload.session || activeSession;
      updateWorkspaceSummary();
      if (payload.reset) {
        resetTerminalContent();
      }
      terminalSessionId = sessionId;
      terminalStreamOffset = Number.isInteger(payload.streamOffset) ? payload.streamOffset : 0;
      queueTerminalOutput(payload.buffer || "");
      scrollTerminalToLatest({ force: true });
      setStatus(payload.session.status || "running");
      return;
    }
    if (payload.type === "data") {
      const data = payload.data || "";
      terminalStreamOffset += data.length;
      queueTerminalOutput(data);
      return;
    }
    if (payload.type === "exit") {
      setStatus(`exited ${payload.exitCode}`);
      await refreshSessions();
      return;
    }
    if (payload.type === "error") {
      setStatus(payload.error || "Thread error");
    }
  });

  ws.addEventListener("close", () => {
    if (ignoredSocketEvents.has(ws)) {
      return;
    }
    if (socket === ws) {
      socket = null;
    }
    setStatus("disconnected");
    updateInputControls();
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect(sessionId);
    }
  });

  ws.addEventListener("error", () => {
    if (ignoredSocketEvents.has(ws)) {
      return;
    }
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect(sessionId);
    }
  });
}

async function openSession(sessionId) {
  isManualDisconnect = false;
  await connectToSession(sessionId, { allowReconnect: true });
  await loadDirectory(activeSession?.cwd || "");
}

function sendToSession(data) {
  if (!hasLiveSession()) {
    setStatus("Open a thread first.");
    return;
  }

  socket.send(JSON.stringify({ type: "input", data }));
}

function buildDirectoryEntry(entry) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `directory-entry ${entry.type}`;

  const icon = document.createElement("span");
  icon.className = "directory-icon";
  icon.textContent = entry.type === "directory" ? "DIR" : "FILE";
  item.appendChild(icon);

  const copy = document.createElement("div");
  copy.className = "directory-copy";

  const name = document.createElement("strong");
  name.textContent = entry.name;
  copy.appendChild(name);

  const meta = document.createElement("span");
  if (entry.type === "directory") {
    meta.textContent = entry.path;
  } else {
    const sizeText = humanFileSize(entry.size);
    meta.textContent = sizeText ? `${sizeText} · ${entry.path}` : entry.path;
  }
  copy.appendChild(meta);
  item.appendChild(copy);

  item.addEventListener("click", async () => {
    if (entry.type === "directory") {
      await loadDirectory(entry.path);
      return;
    }

    const copied = await copyText(entry.path, "Path selected. Use your browser copy action.");
    if (copied) {
      setStatus(`Copied ${entry.path}`);
      return;
    }
    setStatus(entry.path);
  });

  return item;
}

function renderDirectoryBrowser() {
  directoryTreeRoot.innerHTML = "";

  if (!browserState.path) {
    directorySummaryRoot.textContent = "";
    directoryTreeRoot.appendChild(
      buildEmptyState("No folder loaded", "Open a thread first, then use the menu to browse files.")
    );
    updateWorkspaceSummary();
    return;
  }

  directorySummaryRoot.textContent = browserState.truncated
    ? `Showing first ${browserState.entries.length} of ${browserState.totalEntries} entries.`
    : `${browserState.totalEntries} entries`;

  if (!browserState.entries.length) {
    directoryTreeRoot.appendChild(
      buildEmptyState("This folder is empty", "Go up one level or sync back to the thread directory.")
    );
    updateWorkspaceSummary();
    return;
  }

  for (const entry of browserState.entries) {
    directoryTreeRoot.appendChild(buildDirectoryEntry(entry));
  }

  updateWorkspaceSummary();
}

function closeCwdPicker() {
  cwdPickerRoot.classList.add("hidden");
  cwdPickerRoot.setAttribute("aria-hidden", "true");
}

function openCwdPicker() {
  cwdPickerRoot.classList.remove("hidden");
  cwdPickerRoot.setAttribute("aria-hidden", "false");
}

function normalizeDirectoryInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return `${trimmed[0]}:\\`;
  }
  return trimmed;
}

function splitDirectoryInput(value) {
  const candidate = normalizeDirectoryInput(value);
  if (!candidate) {
    return { path: "", prefix: "" };
  }
  if (/^[A-Za-z]:\\$/.test(candidate) || candidate === "\\" || candidate === "/") {
    return { path: candidate, prefix: "" };
  }

  const normalized = candidate.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (slashIndex < 0) {
    return { path: normalized, prefix: "" };
  }

  let pathValue = normalized.slice(0, slashIndex);
  if (/^[A-Za-z]:$/.test(pathValue)) {
    pathValue = `${pathValue}\\`;
  }
  return {
    path: pathValue,
    prefix: normalized.slice(slashIndex + 1)
  };
}

function buildCwdPickerItem(label, pathValue, action) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "cwd-picker-item";

  const title = document.createElement("strong");
  title.textContent = label;
  item.appendChild(title);

  const meta = document.createElement("span");
  meta.textContent = pathValue;
  item.appendChild(meta);

  item.addEventListener("click", async () => {
    cwdInput.value = pathValue;
    await action(pathValue);
  });

  return item;
}

async function requestDirectoryPayload(pathValue) {
  const targetPath = String(pathValue || "").trim();
  const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
  return request(`/api/fs${query}`);
}

function renderCwdPickerEmpty(message) {
  cwdPickerMetaRoot.textContent = message;
  cwdPickerListRoot.innerHTML = "";
}

async function loadCwdPicker(pathValue = "") {
  const requestedPath =
    String(pathValue || "").trim() || cwdInput.value.trim() || defaultCwd || browserState.path || activeSession?.cwd;

  if (!requestedPath) {
    renderCwdPickerEmpty("No folder loaded.");
    openCwdPicker();
    return;
  }

  const requestId = ++cwdPickerRequestId;
  openCwdPicker();

  try {
    const payload = await requestDirectoryPayload(requestedPath);
    if (requestId !== cwdPickerRequestId) {
      return;
    }

    cwdPickerMetaRoot.textContent = payload.path || "No folder loaded.";
    cwdPickerListRoot.innerHTML = "";

    if (payload.parentPath) {
      cwdPickerListRoot.appendChild(
        buildCwdPickerItem(".. Parent folder", payload.parentPath, async (nextPath) => {
          await loadCwdPicker(nextPath);
        })
      );
    }

    const directories = (payload.entries || []).filter((entry) => entry.type === "directory");
    for (const entry of directories) {
      cwdPickerListRoot.appendChild(
        buildCwdPickerItem(entry.name, entry.path, async (nextPath) => {
          await loadCwdPicker(nextPath);
        })
      );
    }

    if (!directories.length) {
      cwdPickerListRoot.appendChild(
        buildCwdPickerItem("Use this folder", payload.path, async () => {
          closeCwdPicker();
        })
      );
    }
    return;
  } catch {
    const { path: parentPath, prefix } = splitDirectoryInput(requestedPath);
    if (!parentPath || parentPath === requestedPath) {
      renderCwdPickerEmpty("Directory not found.");
      return;
    }

    try {
      const payload = await requestDirectoryPayload(parentPath);
      if (requestId !== cwdPickerRequestId) {
        return;
      }

      const directories = (payload.entries || []).filter((entry) => {
        return entry.type === "directory" && entry.name.toLowerCase().startsWith(prefix.toLowerCase());
      });

      cwdPickerMetaRoot.textContent = payload.path || parentPath;
      cwdPickerListRoot.innerHTML = "";

      if (payload.parentPath) {
        cwdPickerListRoot.appendChild(
          buildCwdPickerItem(".. Parent folder", payload.parentPath, async (nextPath) => {
            await loadCwdPicker(nextPath);
          })
        );
      }

      for (const entry of directories) {
        cwdPickerListRoot.appendChild(
          buildCwdPickerItem(entry.name, entry.path, async (nextPath) => {
            await loadCwdPicker(nextPath);
          })
        );
      }

      if (!directories.length) {
        renderCwdPickerEmpty(`No matching folders under ${payload.path || parentPath}`);
      }
    } catch {
      renderCwdPickerEmpty("Directory not found.");
    }
  }
}

async function loadDirectory(targetPath = "") {
  try {
    const requestedPath =
      String(targetPath || "").trim() ||
      activeSession?.cwd ||
      cwdInput.value.trim();
    const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
    const payload = await request(`/api/fs${query}`);

    browserState = {
      ...browserState,
      path: payload.path || "",
      parentPath: payload.parentPath || "",
      entries: payload.entries || [],
      totalEntries: payload.totalEntries || 0,
      truncated: Boolean(payload.truncated)
    };

    browserCurrentRoot.textContent = payload.path || "No folder loaded.";
    renderDirectoryBrowser();
  } catch (err) {
    setStatus(err.message || String(err));
  }
}

async function browseToParentDirectory() {
  if (!browserState.parentPath) {
    setStatus("Already at the top folder.");
    return;
  }

  await loadDirectory(browserState.parentPath);
}

async function enterWorkspace(payload) {
  defaultCwd = payload.defaultCwd || "";
  displayTimezone = payload.timezone || displayTimezone;
  displayTimeFormatter = null;
  displayCardTimeFormatter = null;
  defaultProvider = payload.defaultProvider || defaultProvider;
  applyProviderCatalog(payload.providers || []);
  cwdInput.value = cwdInput.value.trim() || payload.defaultCwd || "";
  providerSelect.value = providerCatalog.some((provider) => provider.id === defaultProvider)
    ? defaultProvider
    : providerCatalog[0]?.id || "codex";
  newSessionButton.disabled = false;
  setView("workspace");
  setWorkspaceScreen("home");
  setPanelOpen(false);
  setStatus("Connected. Create or open a thread.");
  await refreshSessions();
  await loadDirectory(cwdInput.value.trim());
  updateInputControls();
  await openDeepLinkedSession();
}

// /orch (and anything else) can hand off into a specific thread with
// /?session=<live id>. Consume the parameter so a later reload of the tab
// does not keep re-opening a thread that may be long gone.
function takeDeepLinkedSessionId() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = String(params.get("session") || "").trim();
  if (!sessionId) {
    return "";
  }
  params.delete("session");
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return sessionId;
}

async function openDeepLinkedSession() {
  const sessionId = takeDeepLinkedSessionId();
  if (!sessionId) {
    return;
  }

  const target = sessions.find((session) => session.kind === "live" && session.id === sessionId);
  if (!target) {
    setStatus("Linked thread not found. It may have exited and been cleaned up.");
    return;
  }
  await openSession(sessionId);
}

connectButton.addEventListener("click", async () => {
  try {
    accessToken = tokenInput.value.trim();
    if (!accessToken) {
      throw new Error("Enter the access token first.");
    }
    await loginWithToken(accessToken);
    const payload = await request("/api/config");
    accessToken = "";
    tokenInput.value = "";
    await enterWorkspace(payload);
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

newSessionButton.addEventListener("click", async () => {
  try {
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        provider: providerSelect.value || defaultProvider,
        cwd: cwdInput.value.trim(),
        name: nameInput.value.trim()
      })
    });
    await refreshSessions();
    await openSession(payload.session.id);
    nameInput.value = "";
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

closeSessionButton.addEventListener("click", async () => {
  if (!activeSessionId) {
    return;
  }
  try {
    isManualDisconnect = true;
    await request(`/api/sessions/${activeSessionId}`, { method: "DELETE" });
    disconnectSocket();
    closeSessionNameEditor();
    resetTerminalContent();
    activeSessionId = "";
    activeSession = null;
    updateInputControls();
    updateWorkspaceSummary();
    await refreshSessions();
    setStatus("Thread closed.");
    setWorkspaceScreen("home");
    setPanelOpen(false);
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

openPanelButton.addEventListener("click", () => {
  setPanelOpen(true);
});

closePanelButton.addEventListener("click", () => {
  setPanelOpen(false);
});

panelBackdrop.addEventListener("click", () => {
  setPanelOpen(false);
});

backToConnectButton.addEventListener("click", () => {
  isManualDisconnect = true;
  disconnectSocket();
  closeClipboardSheet({ restoreFocus: false });
  closeCwdPicker();
  closeSessionNameEditor();
  activeSessionId = "";
  activeSession = null;
  setPanelOpen(false);
  setWorkspaceScreen("home");
  setView("connect");
  resetTerminalContent();
  setStatus("Disconnected");
  logoutSession();
  updateWorkspaceSummary();
});

backToSessionsButton.addEventListener("click", async () => {
  isManualDisconnect = true;
  disconnectSocket();
  closeSessionNameEditor();
  activeSessionId = "";
  activeSession = null;
  setPanelOpen(false);
  setWorkspaceScreen("home");
  resetTerminalContent();
  await refreshSessions();
  setStatus("Choose another thread.");
});

copyTerminalButton.addEventListener("click", () => {
  openClipboardSheet("copy");
});

pasteTerminalButton.addEventListener("click", () => {
  if (!hasLiveSession()) {
    setStatus("Open a thread first.");
    return;
  }
  openClipboardSheet("paste");
});

clipboardPrimaryButton.addEventListener("click", async () => {
  if (clipboardTitle.textContent === "Copy Path") {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
    setStatus("Path selected. Use your browser copy action.");
    return;
  }

  await handleClipboardPrimaryAction();
});

clipboardCloseButton.addEventListener("click", () => {
  closeClipboardSheet();
});

editSessionNameButton.addEventListener("click", () => {
  openSessionNameEditor();
});

saveSessionNameButton.addEventListener("click", async () => {
  await renameActiveSession();
});

cancelSessionNameButton.addEventListener("click", () => {
  closeSessionNameEditor();
  updateWorkspaceSummary();
});

browseUpButton.addEventListener("click", async () => {
  await browseToParentDirectory();
});

syncBrowserPathButton.addEventListener("click", async () => {
  const nextPath = activeSession?.cwd || cwdInput.value.trim() || browserState.path;
  if (!nextPath) {
    setStatus("No thread folder available.");
    return;
  }
  await loadDirectory(nextPath);
});

cwdInput.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    closeCwdPicker();
    return;
  }

  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  await loadCwdPicker(cwdInput.value.trim());
});

cwdInput.addEventListener("pointerdown", async (event) => {
  event.preventDefault();
  await loadCwdPicker(cwdInput.value.trim());
});

sessionNameInlineInput.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    closeSessionNameEditor();
    updateWorkspaceSummary();
    return;
  }

  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  await renameActiveSession();
});

providerSelect.addEventListener("change", () => {
  if (!activeSession) {
    updateWorkspaceSummary();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (event.target === cwdInput || cwdPickerRoot.contains(event.target)) {
    return;
  }
  closeCwdPicker();
});

if (enableMobileComposer) {
  mobileComposer.addEventListener("click", (event) => {
    if (event.target === composerEscButton || event.target === composerSendButton) {
      return;
    }
    focusImeBridge();
  });
}

term.onData((data) => {
  // On touch devices typed text arrives via the IME bridge, so plain
  // characters from xterm's own input path would double up and are dropped.
  // Control reports are different: the terminal is their only source (mouse
  // wheel reports, wheel-to-arrow conversion), so they always go through --
  // scrolling a full-screen CLI depends on them.
  if (useImeBridge && !data.startsWith("\u001b")) {
    return;
  }
  sendToSession(data);
});

term.onResize(() => {
  sendTerminalResize();
});

terminalRoot.addEventListener("click", () => {
  if (isClipboardSheetOpen()) {
    return;
  }
  if (useImeBridge) {
    focusImeBridge();
    return;
  }

  term.focus();
});

window.addEventListener("resize", () => {
  requestViewportMetrics();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    blurImeBridge();
    return;
  }

  settleTerminalViewport();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.addEventListener("pageshow", () => {
  settleTerminalViewport();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sessionPanel.classList.contains("open")) {
    setPanelOpen(false);
  }
});

window.visualViewport?.addEventListener("resize", requestViewportMetrics);
window.visualViewport?.addEventListener("scroll", requestViewportMetrics);

imeBridge.addEventListener("compositionstart", () => {
  imeComposing = true;
});

imeBridge.addEventListener("compositionend", () => {
  imeComposing = false;
  flushImeBridgeValue();
});

imeBridge.addEventListener("focus", () => {
  setComposerExpanded(true);
  syncComposerLayout();
});

imeBridge.addEventListener("blur", () => {
  if (!imeBridge.value && !keyboardWasOpen) {
    setComposerExpanded(false);
  }
  syncComposerLayout();
  if (useImeBridge && hasLiveSession() && !document.hidden) {
    keyboardWasOpen = false;
    document.documentElement.classList.remove("keyboard-open");
    document.documentElement.style.setProperty("--vvh", "100dvh");
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
    lockRootScrollPosition();
    settleTerminalViewport();
  }
});

imeBridge.addEventListener("input", () => {
  flushImeBridgeValue();
});

imeBridge.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitImeBridge();
    return;
  }

  if (event.key === "Backspace" && !imeBridge.value && !imeComposing) {
    event.preventDefault();
    sendToSession("\u007f");
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    sendToSession("\t");
    imeBridge.value += "\t";
    mobileComposerValue = imeBridge.value;
    syncComposerLayout();
    return;
  }

  const arrowMap = {
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowLeft: "\u001b[D",
    ArrowRight: "\u001b[C"
  };
  const controlValue = arrowMap[event.key];
  if (controlValue) {
    event.preventDefault();
    sendToSession(controlValue);
  }
});

composerEscButton.addEventListener("click", () => {
  sendInterruptControl();
  focusImeBridge();
});

composerSendButton.addEventListener("click", () => {
  submitImeBridge();
});

escKeyButton.addEventListener("click", () => {
  sendInterruptControl();
  if (useImeBridge && keyboardWasOpen) {
    focusImeBridge();
    return;
  }

  term.focus();
});

for (const button of terminalArrowButtons) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    const arrowMap = {
      up: "\u001b[A",
      down: "\u001b[B",
      right: "\u001b[C",
      left: "\u001b[D"
    };
    const data = arrowMap[button.dataset.arrowKey];
    if (!data) {
      return;
    }
    sendToSession(data);
    button.blur();
    if (!useImeBridge) {
      term.focus();
    }
  });
}

applyProviderCatalog(providerCatalog);
updateInputControls();
updateWorkspaceSummary();
setView("connect");
setWorkspaceScreen("home");
setPanelOpen(false);
syncComposerLayout();
requestViewportMetrics();

// A valid auth cookie should land straight in the workspace instead of asking
// for the token again -- deep links from /orch depend on this hop being silent.
(async () => {
  try {
    const payload = await request("/api/config");
    isAuthenticated = true;
    await enterWorkspace(payload);
  } catch {
    // No live cookie; stay on the connect view.
  }
})();
