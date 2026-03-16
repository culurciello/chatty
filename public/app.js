const state = {
  listening: false,
  busy: false,
  history: [],
  activeAudio: null,
  typingBubble: null,
  spaceHeld: false,
  micHeld: false,
  language: "en",
  sttProvider: "openai",
  mediaRecorder: null,
  mediaStream: null,
  recordedChunks: [],
  moonshineModule: null,
  moonshineTranscriber: null,
  transcribingChunk: false,
  conversationMode: "push_to_talk",
  autoResumeListening: false
};

const ui = {
  scene: document.querySelector("#scene"),
  micBtn: document.querySelector("#micBtn"),
  status: document.querySelector("#status"),
  liveTranscript: document.querySelector("#liveTranscript"),
  chatBox: document.querySelector("#chatBox"),
  textInput: document.querySelector("#textInput"),
  sendBtn: document.querySelector("#sendBtn"),
  stopAudioBtn: document.querySelector("#stopAudioBtn"),
  languageSelect: document.querySelector("#languageSelect"),
  sttProviderSelect: document.querySelector("#sttProviderSelect"),
  conversationModeSelect: document.querySelector("#conversationModeSelect")
};

const languageConfig = {
  en: {
    label: "English",
    transcriptIdle: "Hold space to talk, or type a message.",
    transcriptListening: "Listening in English... release to send."
  },
  it: {
    label: "Italian",
    transcriptIdle: "Tieni premuto spazio per parlare, oppure scrivi un messaggio.",
    transcriptListening: "Ascolto in italiano... rilascia per inviare."
  },
  ko: {
    label: "Korean",
    transcriptIdle: "스페이스바를 누르고 말하거나, 직접 입력하세요.",
    transcriptListening: "한국어로 듣는 중... 놓으면 전송합니다."
  }
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
  ui.micBtn.title =
    state.conversationMode === "realtime"
      ? state.listening
        ? "Stop listening"
        : "Start listening"
      : state.listening
        ? "Release to stop"
        : "Hold to talk";
  ui.sendBtn.disabled = state.busy;
  ui.languageSelect.disabled = state.busy || state.listening;
  ui.sttProviderSelect.disabled = state.busy || state.listening;
  ui.conversationModeSelect.disabled = state.busy || state.listening;
}

function currentLanguage() {
  return languageConfig[state.language] || languageConfig.en;
}

function usingMoonshine() {
  return state.sttProvider === "moonshine";
}

function usingRealtimeMode() {
  return state.conversationMode === "realtime";
}

function currentIdlePrompt() {
  return usingRealtimeMode()
    ? "Click the mic to start live listening, or type a message."
    : currentLanguage().transcriptIdle;
}

function currentListeningPrompt() {
  return usingRealtimeMode()
    ? currentLanguage().transcriptListening.replace("... release to send.", "...")
    : currentLanguage().transcriptListening;
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
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
  if (usingRealtimeMode() && state.listening) {
    state.autoResumeListening = true;
    await stopListening();
  } else {
    state.autoResumeListening = false;
  }

  stopPlayback();

  const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
  state.activeAudio = audio;
  setState("speaking", "speaking");

  audio.addEventListener("ended", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    if (state.autoResumeListening) {
      state.autoResumeListening = false;
      void startListening().catch((error) => {
        addBubble(describeMicError(error), "system");
        setState("idle", "mic error");
      });
      return;
    }
    setState("idle", "idle");
  });

  audio.addEventListener("error", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    addBubble("Audio playback failed in the browser.", "system");
    if (state.autoResumeListening) {
      state.autoResumeListening = false;
      void startListening().catch((error) => {
        addBubble(describeMicError(error), "system");
        setState("idle", "mic error");
      });
      return;
    }
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
        history: state.history,
        language: state.language
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

async function ensureRecorder() {
  if (state.mediaRecorder && state.mediaStream) {
    return state.mediaRecorder;
  }

  ui.liveTranscript.textContent = "Preparing microphone...";
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      if (usingRealtimeMode()) {
        void transcribeChunk(event.data);
      } else {
        state.recordedChunks.push(event.data);
      }
    }
  });

  state.mediaStream = stream;
  state.mediaRecorder = recorder;
  return recorder;
}

async function ensureMoonshineModule() {
  if (state.moonshineModule) {
    return state.moonshineModule;
  }

  state.moonshineModule = await import(
    "https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-js@latest/dist/moonshine.min.js"
  );
  return state.moonshineModule;
}

async function ensureMoonshineTranscriber() {
  if (state.moonshineTranscriber) {
    return state.moonshineTranscriber;
  }

  ui.liveTranscript.textContent = "Loading Moonshine STT...";
  const Moonshine = await ensureMoonshineModule();
  state.moonshineTranscriber = new Moonshine.MicrophoneTranscriber(
    `model/tiny/${state.language}`,
    {
      onTranscriptionUpdated(text) {
        if (!state.busy) {
          setState("listening", "listening");
        }
        ui.liveTranscript.textContent = text || currentLanguage().transcriptListening;
        ui.textInput.value = text || "";
      },
      onTranscriptionCommitted(text) {
        const transcript = typeof text === "string" ? text.trim() : "";
        ui.liveTranscript.textContent = transcript || currentLanguage().transcriptIdle;
        ui.textInput.value = transcript;
        if (transcript) {
          void sendMessage(transcript);
        }
      }
    },
    false
  );

  return state.moonshineTranscriber;
}

async function teardownMoonshine() {
  if (!state.moonshineTranscriber) {
    return;
  }

  try {
    await state.moonshineTranscriber.stop();
  } catch {
    // Ignore stop errors during provider/language switching.
  }

  state.moonshineTranscriber = null;
}

async function transcribeChunk(audioBlob) {
  if (!audioBlob || !audioBlob.size) {
    ui.liveTranscript.textContent = currentLanguage().transcriptIdle;
    return;
  }

  if (state.transcribingChunk) {
    return;
  }

  state.transcribingChunk = true;
  if (!state.busy) {
    setState("thinking", "transcribing");
  }
  ui.liveTranscript.textContent = "Transcribing...";

  const formData = new FormData();
  formData.append("audio", audioBlob, "speech.webm");
  formData.append("language", state.language);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.details || data?.error || "Transcription failed.");
    }

    const transcript = typeof data?.transcript === "string" ? data.transcript.trim() : "";
    ui.liveTranscript.textContent = transcript || currentIdlePrompt();
    ui.textInput.value = transcript;
    if (transcript) {
      await sendMessage(transcript);
    }
  } finally {
    state.transcribingChunk = false;
    if (usingRealtimeMode() && state.listening && !state.busy) {
      setState("listening", "listening");
      ui.liveTranscript.textContent = currentListeningPrompt();
    }
  }
}

async function startListening() {
  stopPlayback();
  if (usingMoonshine()) {
    const transcriber = await ensureMoonshineTranscriber();
    await transcriber.start();
  } else {
    const recorder = await ensureRecorder();
    if (recorder.state === "recording") {
      return;
    }

    state.recordedChunks = [];
    if (usingRealtimeMode()) {
      recorder.start(2500);
    } else {
      recorder.start();
    }
  }

  state.listening = true;
  syncControls();
  setState("listening", "listening");
  ui.liveTranscript.textContent = currentListeningPrompt();
}

async function stopListening() {
  if (usingMoonshine()) {
    if (state.moonshineTranscriber) {
      await state.moonshineTranscriber.stop();
    }
  } else {
    if (!state.mediaRecorder) {
      state.listening = false;
      syncControls();
      setState("idle", "idle");
      return;
    }

    const recorder = state.mediaRecorder;
    if (recorder.state === "recording") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }
  }

  state.listening = false;
  syncControls();
  if (!usingMoonshine() && !usingRealtimeMode()) {
    const mimeType = state.mediaRecorder?.mimeType || "audio/webm";
    const audioBlob = new Blob(state.recordedChunks, { type: mimeType });
    state.recordedChunks = [];
    await transcribeChunk(audioBlob);
  }
  if (!state.busy && !state.activeAudio) {
    setState("idle", "idle");
    ui.liveTranscript.textContent = currentIdlePrompt();
  }
}

ui.micBtn.addEventListener("click", () => {
  if (!usingRealtimeMode()) {
    return;
  }

  ui.micBtn.disabled = true;
  const work = async () => {
    if (state.listening) {
      await stopListening();
    } else {
      await startListening();
    }
  };

  void work()
    .catch((error) => {
      addBubble(describeMicError(error), "system");
      state.listening = false;
      syncControls();
      setState("idle", "mic error");
    })
    .finally(() => {
      ui.micBtn.disabled = false;
    });
});

ui.micBtn.addEventListener("pointerdown", async (event) => {
  if (usingRealtimeMode()) {
    return;
  }

  event.preventDefault();
  if (state.micHeld) {
    return;
  }

  state.micHeld = true;
  ui.micBtn.disabled = true;

  try {
    if (!state.listening) {
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

async function releaseMicHold() {
  if (!state.micHeld) {
    return;
  }

  state.micHeld = false;
  if (state.listening) {
    await stopListening();
  }
}

ui.micBtn.addEventListener("pointerup", () => {
  if (usingRealtimeMode()) {
    return;
  }
  void releaseMicHold();
});

ui.micBtn.addEventListener("pointerleave", () => {
  if (usingRealtimeMode()) {
    return;
  }
  void releaseMicHold();
});

ui.micBtn.addEventListener("pointercancel", () => {
  if (usingRealtimeMode()) {
    return;
  }
  void releaseMicHold();
});

ui.sendBtn.addEventListener("click", () => {
  void sendMessage(ui.textInput.value);
});

ui.stopAudioBtn.addEventListener("click", () => {
  stopPlayback();
});

ui.languageSelect.addEventListener("change", async (event) => {
  const nextLanguage = event.target.value in languageConfig ? event.target.value : "en";
  if (nextLanguage === state.language) {
    return;
  }

  if (state.listening) {
    await stopListening();
  }

  state.language = nextLanguage;
  await teardownMoonshine();
  ui.liveTranscript.textContent = currentLanguage().transcriptIdle;
  addBubble(`Language set to ${currentLanguage().label}.`, "system");
  syncControls();
});

ui.sttProviderSelect.addEventListener("change", async (event) => {
  const nextProvider = event.target.value === "moonshine" ? "moonshine" : "openai";
  if (nextProvider === state.sttProvider) {
    return;
  }

  if (state.listening) {
    await stopListening();
  }

  state.sttProvider = nextProvider;
  if (nextProvider === "moonshine") {
    addBubble("STT switched to Moonshine. Transcription runs in the browser.", "system");
  } else {
    await teardownMoonshine();
    addBubble("STT switched to gpt-4o-mini-transcribe.", "system");
  }
  ui.liveTranscript.textContent = currentLanguage().transcriptIdle;
  syncControls();
});

ui.conversationModeSelect.addEventListener("change", async (event) => {
  const nextMode = event.target.value === "realtime" ? "realtime" : "push_to_talk";
  if (nextMode === state.conversationMode) {
    return;
  }

  if (state.listening) {
    await stopListening();
  }

  state.conversationMode = nextMode;
  addBubble(
    nextMode === "realtime"
      ? "Mode switched to real-time free speech."
      : "Mode switched to push to talk.",
    "system"
  );
  ui.liveTranscript.textContent = currentIdlePrompt();
  syncControls();
});

ui.textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void sendMessage(ui.textInput.value);
  }
});

document.addEventListener("keydown", (event) => {
  if (
    usingRealtimeMode() ||
    event.code !== "Space" ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isTypingTarget(event.target)
  ) {
    return;
  }

  event.preventDefault();
  if (state.spaceHeld) {
    return;
  }

  state.spaceHeld = true;
  void startListening().catch((error) => {
    addBubble(describeMicError(error), "system");
    state.listening = false;
    state.spaceHeld = false;
    syncControls();
    setState("idle", "mic error");
  });
});

document.addEventListener("keyup", (event) => {
  if (usingRealtimeMode() || event.code !== "Space" || isTypingTarget(event.target)) {
    return;
  }

  if (!state.spaceHeld) {
    return;
  }

  event.preventDefault();
  state.spaceHeld = false;
  void stopListening();
});

addBubble(
  "Choose push to talk or real-time free speech, and choose Moonshine or gpt-4o-mini-transcribe for speech-to-text.",
  "system"
);
setState("idle", "idle");
ui.liveTranscript.textContent = currentIdlePrompt();
syncControls();
