// Tracks the terminal state a stream has already established, so a replay that
// starts in the middle of that stream can be prefixed with the setup it would
// otherwise be missing.
//
// An agent CLI configures its screen exactly once, in the first few kilobytes:
// alt screen, mouse reporting, bracketed paste, the scroll region. A capped
// ring buffer drops those bytes long before a phone comes back from the
// background, and a terminal rebuilt without them has neither a scrollback of
// its own nor mouse reporting to hand the gesture to the agent, so scrolling
// stops doing anything at all.

// Longest partial sequence we hold across chunk boundaries. Big enough for the
// OSC strings these CLIs emit, small enough that a stream with a stray ESC in
// binary output resynchronises quickly instead of swallowing the rest.
const MAX_PENDING_LENGTH = 4096;

// Switching to the alternate screen has to be replayed before anything else,
// because every sequence after it belongs to the alternate buffer.
const ALT_SCREEN_MODES = [47, 1047, 1049];

export function createTerminalState() {
  return {
    pending: "",
    privateModes: new Map(),
    scrollRegion: "",
    keypadMode: ""
  };
}

// Feed the bytes that are about to be discarded. Chunks must be contiguous:
// a sequence split across two calls is carried in state.pending.
export function consumeTerminalState(state, chunk) {
  if (!chunk) {
    return;
  }

  const text = state.pending + chunk;
  state.pending = "";
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf("\x1b", index);
    if (start === -1) {
      return;
    }

    const length = readSequence(state, text, start);
    if (length === -1) {
      const tail = text.slice(start);
      state.pending = tail.length > MAX_PENDING_LENGTH ? "" : tail;
      return;
    }

    index = start + length;
  }
}

export function renderTerminalStatePrefix(state) {
  const parts = [];

  for (const mode of ALT_SCREEN_MODES) {
    if (state.privateModes.get(mode) === "h") {
      parts.push(`\x1b[?${mode}h`);
    }
  }

  const modes = [...state.privateModes.keys()]
    .filter((mode) => !ALT_SCREEN_MODES.includes(mode))
    .sort((left, right) => left - right);
  for (const mode of modes) {
    parts.push(`\x1b[?${mode}${state.privateModes.get(mode)}`);
  }

  if (state.scrollRegion) {
    parts.push(`\x1b[${state.scrollRegion}r`);
  }
  if (state.keypadMode) {
    parts.push(`\x1b${state.keypadMode}`);
  }

  return parts.join("");
}

// Returns how many characters the sequence at `start` occupies, or -1 when it
// runs past the end of the text.
function readSequence(state, text, start) {
  if (start + 1 >= text.length) {
    return -1;
  }

  const type = text[start + 1];
  if (type === "[") {
    return readControlSequence(state, text, start);
  }
  if (type === "]" || type === "P" || type === "X" || type === "^" || type === "_") {
    return readStringSequence(text, start);
  }
  if (type === "=" || type === ">") {
    state.keypadMode = type;
    return 2;
  }

  return 2;
}

function readControlSequence(state, text, start) {
  let index = start + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // Final byte ends the sequence; anything outside the parameter and
    // intermediate ranges means the stream is not what we thought it was.
    if (code >= 0x40 && code <= 0x7e) {
      applyControlSequence(state, text.slice(start + 2, index), text[index]);
      return index - start + 1;
    }
    if (code < 0x20 || code > 0x3f) {
      return index - start + 1;
    }
    index += 1;
  }

  return -1;
}

function applyControlSequence(state, body, final) {
  if (body.startsWith("?")) {
    if (final !== "h" && final !== "l") {
      return;
    }
    for (const part of body.slice(1).split(";")) {
      const mode = Number.parseInt(part, 10);
      if (Number.isInteger(mode)) {
        state.privateModes.set(mode, final);
      }
    }
    return;
  }

  // DECSTBM. An empty parameter list restores the full screen, which is the
  // default a rebuilt terminal already has, so it clears the record.
  if (final === "r") {
    state.scrollRegion = /^\d+(;\d+)?$/.test(body) ? body : "";
  }
}

function readStringSequence(text, start) {
  let index = start + 2;
  while (index < text.length) {
    const char = text[index];
    if (char === "\x07") {
      return index - start + 1;
    }
    if (char === "\x1b") {
      if (index + 1 >= text.length) {
        return -1;
      }
      return text[index + 1] === "\\" ? index - start + 2 : index - start;
    }
    index += 1;
  }

  return -1;
}
