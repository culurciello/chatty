import * as Moonshine from "https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-js@latest/dist/moonshine.min.js";

const state = {
  transcriber: null,
  listening: false,
  busy: false,
  history: [],
  activeAudio: null,
  typingBubble: null
};

const ui = {
  scene: document.querySelector("#scene"),
  micBtn: document.querySelector("#micBtn"),
  status: document.querySelector("#status"),
  liveTranscript: document.querySelector("#liveTranscript"),
  chatBox: document.querySelector("#chatBox"),
  textInput: document.querySelector("#textInput"),
  sendBtn: document.querySelector("#sendBtn"),
  stopAudioBtn: document.querySelector("#stopAudioBtn")
};

function describeMicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  const normalizedName = typeof name === "string" ? name : "";
  const combined = `${normalizedName} ${message}`.toLowerCase();

  if (
    combined.includes("notallowederror") ||
    combined.includes("permission denied") ||
    combined.includes("denied permission") ||
    combined.includes("not allowed by the user agent")
  ) {
    return "Microphone permission was denied. Allow mic access for 127.0.0.1 in the browser and in macOS Privacy > Microphone.";
  }

  if (combined.includes("notfounderror") || combined.includes("device not found")) {
    return "No microphone was found. Connect or enable an input device and try again.";
  }

  if (combined.includes("notreadableerror") || combined.includes("could not start audio source")) {
    return "The microphone is busy or unavailable. Close other apps using the mic and try again.";
  }

  if (combined.includes("securityerror")) {
    return "Microphone access was blocked by the browser security context. Open the app directly at http://127.0.0.1:3005 in a normal browser tab.";
  }

  if (combined.includes("overconstrainederror")) {
    return "The browser could not satisfy the requested audio settings. Try another microphone or browser.";
  }

  return `Microphone startup failed: ${message}`;
}

function setState(nextState, detail = "") {
  ui.scene.className = nextState === "idle" ? "scene" : `scene ${nextState}`;
  ui.status.textContent = detail || nextState;
  ui.status.className = `status${nextState !== "idle" ? " active" : ""}`;
}

function syncControls() {
  ui.micBtn.classList.toggle("active", state.listening);
  ui.micBtn.title = state.listening ? "Stop listening" : "Start listening";
  ui.sendBtn.disabled = state.busy;
}

function addBubble(text, role) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  ui.chatBox.append(bubble);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
  return bubble;
}

function addTyping() {
  removeTyping();
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  ui.chatBox.append(bubble);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
  state.typingBubble = bubble;
}

function removeTyping() {
  if (state.typingBubble) {
    state.typingBubble.remove();
    state.typingBubble = null;
  }
}

function stopPlayback() {
  if (state.activeAudio) {
    state.activeAudio.pause();
    state.activeAudio.src = "";
    state.activeAudio = null;
  }

  if (state.busy) {
    setState("thinking", "processing text");
  } else if (state.listening) {
    setState("listening", "listening");
  } else {
    setState("idle", "idle");
  }
}

async function playAssistantAudio(audioBase64, mimeType) {
  stopPlayback();

  const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
  state.activeAudio = audio;
  setState("speaking", "speaking");

  audio.addEventListener("ended", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    if (state.listening) {
      setState("listening", "listening");
    } else {
      setState("idle", "idle");
    }
  });

  audio.addEventListener("error", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    addBubble("Audio playback failed in the browser.", "system");
    setState("idle", "audio error");
  });

  await audio.play();
}

async function sendMessage(message) {
  const transcript = message.trim();
  if (!transcript || state.busy) {
    return;
  }

  state.busy = true;
  syncControls();
  stopPlayback();
  addBubble(transcript, "user");
  ui.liveTranscript.textContent = transcript;
  ui.textInput.value = "";
  addTyping();
  setState("thinking", "processing text");

  try {
    const response = await fetch("/api/voice-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transcript,
        history: state.history
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.details || data?.error || "Voice request failed.");
    }

    state.history.push({ role: "user", content: transcript });
    state.history.push({ role: "assistant", content: data.assistantText });
    removeTyping();
    addBubble(data.assistantText, "assistant");
    ui.liveTranscript.textContent = data.assistantText;
    await playAssistantAudio(data.audioBase64, data.mimeType);
  } catch (error) {
    removeTyping();
    addBubble(error instanceof Error ? error.message : String(error), "system");
    setState("idle", "request failed");
  } finally {
    state.busy = false;
    syncControls();
    if (!state.activeAudio) {
      if (state.listening) {
        setState("listening", "listening");
      } else {
        setState("idle", "idle");
      }
    }
  }
}

async function ensureTranscriber() {
  if (state.transcriber) {
    return state.transcriber;
  }

  setState("thinking", "loading moonshine");
  ui.liveTranscript.textContent = "Loading local speech-to-text model...";

  state.transcriber = new Moonshine.MicrophoneTranscriber(
    "model/tiny",
    {
      onTranscriptionUpdated(text) {
        if (!state.busy) {
          setState("listening", "listening");
        }
        ui.liveTranscript.textContent = text || "Listening...";
        ui.textInput.value = text || "";
      },
      onTranscriptionCommitted(text) {
        const committed = text?.trim();
        ui.liveTranscript.textContent = committed || "Press the mic or type a message.";
        ui.textInput.value = committed || "";
        if (committed) {
          void sendMessage(committed);
        }
      }
    },
    false
  );

  return state.transcriber;
}

async function startListening() {
  stopPlayback();
  const transcriber = await ensureTranscriber();
  await transcriber.start();
  state.listening = true;
  syncControls();
  setState("listening", "listening");
  ui.liveTranscript.textContent = "Listening...";
}

async function stopListening() {
  if (!state.transcriber) {
    state.listening = false;
    syncControls();
    setState("idle", "idle");
    return;
  }

  await state.transcriber.stop();
  state.listening = false;
  syncControls();
  if (!state.busy && !state.activeAudio) {
    setState("idle", "idle");
  }
}

ui.micBtn.addEventListener("click", async () => {
  ui.micBtn.disabled = true;

  try {
    if (state.listening) {
      await stopListening();
    } else {
      await startListening();
    }
  } catch (error) {
    addBubble(describeMicError(error), "system");
    state.listening = false;
    syncControls();
    setState("idle", "mic error");
  } finally {
    ui.micBtn.disabled = false;
  }
});

ui.sendBtn.addEventListener("click", () => {
  void sendMessage(ui.textInput.value);
});

ui.stopAudioBtn.addEventListener("click", () => {
  stopPlayback();
});

ui.textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void sendMessage(ui.textInput.value);
  }
});

addBubble(
  "Moonshine transcribes locally in the browser. OpenAI generates and speaks the reply.",
  "system"
);
setState("idle", "idle");
syncControls();
