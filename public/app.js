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
  conversationMode: "push_to_talk",
  autoResumeListening: false,
  mediaRecorder: null,
  mediaStream: null,
  recordedChunks: [],
  moonshineModule: null,
  moonshineTranscriber: null,
  sonioxModule: null,
  sonioxClient: null,
  sonioxRecording: null,
  sonioxUtteranceText: "",
  sonioxSeenFinalTokenKeys: new Set(),
  transcribingChunk: false,
  pendingMessages: [],
  realtimePeerConnection: null,
  realtimeDataChannel: null,
  realtimeStream: null,
  realtimePartialByItemId: new Map()
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

function currentLanguage() {
  return languageConfig[state.language] || languageConfig.en;
}

function usingMoonshine() {
  return state.sttProvider === "moonshine";
}

function usingSoniox() {
  return state.sttProvider === "soniox";
}

function usingRealtimeMode() {
  return state.conversationMode === "realtime";
}

function usingOpenAiRealtimeStt() {
  return !usingMoonshine() && !usingSoniox() && usingRealtimeMode();
}

function extensionForMimeType(mimeType) {
  if (!mimeType) {
    return "webm";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("mp4") || mimeType.includes("mpeg")) {
    return "mp4";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  return "bin";
}

function currentIdlePrompt() {
  return usingRealtimeMode()
    ? "Click the mic to start live listening, or type a message."
    : currentLanguage().transcriptIdle;
}

function currentListeningPrompt() {
  if (usingRealtimeMode()) {
    return currentLanguage().transcriptListening.replace("... release to send.", "...");
  }

  return currentLanguage().transcriptListening;
}

function syncControls() {
  ui.micBtn.classList.toggle("active", state.listening);
  ui.micBtn.title =
    usingRealtimeMode()
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

function enqueueMessage(message) {
  const transcript = message.trim();
  if (!transcript) {
    return;
  }

  state.pendingMessages.push(transcript);
  void drainMessageQueue();
}

async function drainMessageQueue() {
  if (state.busy || !state.pendingMessages.length) {
    return;
  }

  const nextMessage = state.pendingMessages.shift();
  if (!nextMessage) {
    return;
  }

  await sendMessage(nextMessage);
  if (state.pendingMessages.length) {
    void drainMessageQueue();
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

  const resumeIfNeeded = () => {
    if (!state.autoResumeListening) {
      setState("idle", "idle");
      ui.liveTranscript.textContent = currentIdlePrompt();
      return;
    }

    state.autoResumeListening = false;
    void startListening().catch((error) => {
      addBubble(describeMicError(error), "system");
      setState("idle", "mic error");
    });
  };

  audio.addEventListener("ended", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    resumeIfNeeded();
  });

  audio.addEventListener("error", () => {
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
    addBubble("Audio playback failed in the browser.", "system");
    resumeIfNeeded();
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
    if (!state.activeAudio && !state.listening) {
      setState("idle", "idle");
      ui.liveTranscript.textContent = currentIdlePrompt();
    }
  }
}

async function ensureRecorder() {
  if (state.mediaRecorder && state.mediaStream) {
    return state.mediaRecorder;
  }

  ui.liveTranscript.textContent = "Preparing microphone...";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }

    if (usingRealtimeMode()) {
      void transcribeChunk(event.data);
    } else {
      state.recordedChunks.push(event.data);
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

async function ensureSonioxModule() {
  if (state.sonioxModule) {
    return state.sonioxModule;
  }

  state.sonioxModule = await import("https://esm.sh/@soniox/client");
  return state.sonioxModule;
}

async function fetchSonioxTemporaryKey() {
  const response = await fetch("/api/soniox-temporary-key", {
    method: "POST"
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.details?.error_message || data?.error || "Failed to create Soniox key.");
  }

  if (!data?.apiKey) {
    throw new Error("Soniox temporary key response did not include an api key.");
  }

  return data;
}

async function ensureSonioxClient() {
  if (state.sonioxClient) {
    return state.sonioxClient;
  }

  const { SonioxClient, BrowserPermissionResolver } = await ensureSonioxModule();
  state.sonioxClient = new SonioxClient({
    api_key: async () => {
      const session = await fetchSonioxTemporaryKey();
      return session.apiKey;
    },
    permissions: new BrowserPermissionResolver()
  });

  return state.sonioxClient;
}

function resetSonioxUtterance() {
  state.sonioxUtteranceText = "";
  state.sonioxSeenFinalTokenKeys = new Set();
}

function flushSonioxUtterance() {
  const transcript = state.sonioxUtteranceText.trim();
  resetSonioxUtterance();
  if (transcript) {
    ui.liveTranscript.textContent = transcript;
    ui.textInput.value = transcript;
    enqueueMessage(transcript);
  }
}

function handleSonioxResult(result) {
  let liveText = "";

  for (const token of result?.tokens || []) {
    if (!token?.text || token.text === "<end>") {
      continue;
    }

    liveText += token.text;
    if (token.is_final) {
      const tokenKey = `${token.start_ms ?? ""}:${token.end_ms ?? ""}:${token.text}`;
      if (!state.sonioxSeenFinalTokenKeys.has(tokenKey)) {
        state.sonioxSeenFinalTokenKeys.add(tokenKey);
        state.sonioxUtteranceText += token.text;
      }
    }
  }

  ui.liveTranscript.textContent = liveText || currentListeningPrompt();
  ui.textInput.value = liveText;

  if (result?.finished) {
    flushSonioxUtterance();
  }
}

async function ensureSonioxRecording() {
  if (state.sonioxRecording) {
    return state.sonioxRecording;
  }

  ui.liveTranscript.textContent = "Connecting Soniox...";
  resetSonioxUtterance();
  const client = await ensureSonioxClient();
  const { model } = await fetchSonioxTemporaryKey();

  const recording = await client.realtime.record({
    model,
    language_hints: [state.language],
    enable_endpoint_detection: usingRealtimeMode()
  });

  recording.on("result", (result) => {
    handleSonioxResult(result);
  });

  recording.on("endpoint", () => {
    flushSonioxUtterance();
  });

  recording.on("error", (error) => {
    addBubble(`Soniox error: ${error?.message || error}`, "system");
  });

  state.sonioxRecording = recording;
  return recording;
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
        ui.liveTranscript.textContent = text || currentListeningPrompt();
        ui.textInput.value = text || "";
      },
      onTranscriptionCommitted(text) {
        const transcript = typeof text === "string" ? text.trim() : "";
        ui.liveTranscript.textContent = transcript || currentIdlePrompt();
        ui.textInput.value = transcript;
        if (transcript) {
          enqueueMessage(transcript);
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

async function teardownSonioxRecording() {
  if (!state.sonioxRecording) {
    return;
  }

  try {
    await state.sonioxRecording.stop();
  } catch {
    // Ignore stop errors during provider/language switching.
  }

  state.sonioxRecording = null;
  flushSonioxUtterance();
}

async function transcribeChunk(audioBlob) {
  if (!audioBlob || !audioBlob.size || state.transcribingChunk) {
    return;
  }

  state.transcribingChunk = true;
  if (!state.busy) {
    setState("thinking", "transcribing");
  }
  ui.liveTranscript.textContent = "Transcribing...";

  const formData = new FormData();
  const extension = extensionForMimeType(audioBlob.type);
  formData.append("audio", audioBlob, `speech.${extension}`);
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
      enqueueMessage(transcript);
    }
  } finally {
    state.transcribingChunk = false;
    if (usingRealtimeMode() && state.listening && !state.busy) {
      setState("listening", "listening");
      ui.liveTranscript.textContent = currentListeningPrompt();
    }
  }
}

async function fetchRealtimeSessionSecret() {
  const response = await fetch("/api/realtime-transcription-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ language: state.language })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.details?.error?.message || data?.error || "Failed to create realtime session.");
  }

  const secret =
    data?.value ||
    data?.client_secret?.value ||
    data?.session?.client_secret?.value;

  if (!secret) {
    throw new Error("Realtime session response did not include a client secret.");
  }

  return secret;
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      if (!state.busy) {
        setState("listening", "speech detected");
      }
      break;
    case "input_audio_buffer.speech_stopped":
      if (!state.busy) {
        setState("thinking", "finalizing speech");
      }
      break;
    case "conversation.item.input_audio_transcription.delta": {
      const itemId = event.item_id || event.item?.id || "default";
      const previous = state.realtimePartialByItemId.get(itemId) || "";
      const next = previous + (event.delta || "");
      state.realtimePartialByItemId.set(itemId, next);
      ui.liveTranscript.textContent = next || currentListeningPrompt();
      ui.textInput.value = next;
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const itemId = event.item_id || event.item?.id || "default";
      const transcript = (event.transcript || state.realtimePartialByItemId.get(itemId) || "").trim();
      state.realtimePartialByItemId.delete(itemId);
      ui.liveTranscript.textContent = transcript || currentListeningPrompt();
      ui.textInput.value = transcript;
      if (transcript) {
        enqueueMessage(transcript);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.failed":
      addBubble("Realtime transcription failed.", "system");
      break;
    default:
      break;
  }
}

async function ensureOpenAiRealtimeConnection() {
  if (state.realtimePeerConnection && state.realtimeDataChannel?.readyState !== "closed") {
    return;
  }

  ui.liveTranscript.textContent = "Connecting realtime transcription...";

  const secret = await fetchRealtimeSessionSecret();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel("oai-events");

  dataChannel.addEventListener("message", (messageEvent) => {
    try {
      const event = JSON.parse(messageEvent.data);
      handleRealtimeEvent(event);
    } catch {
      // Ignore malformed events.
    }
  });

  for (const track of stream.getTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Realtime WebRTC setup failed: ${errorText}`);
  }

  const answerSdp = await response.text();
  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp
  });

  state.realtimePeerConnection = peerConnection;
  state.realtimeDataChannel = dataChannel;
  state.realtimeStream = stream;
  state.realtimePartialByItemId.clear();
}

async function teardownOpenAiRealtimeConnection() {
  if (state.realtimeDataChannel) {
    try {
      state.realtimeDataChannel.close();
    } catch {
      // Ignore close errors.
    }
  }

  if (state.realtimePeerConnection) {
    try {
      state.realtimePeerConnection.close();
    } catch {
      // Ignore close errors.
    }
  }

  if (state.realtimeStream) {
    for (const track of state.realtimeStream.getTracks()) {
      track.stop();
    }
  }

  state.realtimePeerConnection = null;
  state.realtimeDataChannel = null;
  state.realtimeStream = null;
  state.realtimePartialByItemId.clear();
}

async function startListening() {
  stopPlayback();

  if (usingMoonshine()) {
    const transcriber = await ensureMoonshineTranscriber();
    await transcriber.start();
  } else if (usingSoniox()) {
    await ensureSonioxRecording();
  } else if (usingOpenAiRealtimeStt()) {
    await ensureOpenAiRealtimeConnection();
  } else {
    const recorder = await ensureRecorder();
    if (recorder.state === "recording") {
      return;
    }

    state.recordedChunks = [];
    recorder.start(usingRealtimeMode() ? 2500 : undefined);
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
  } else if (usingSoniox()) {
    await teardownSonioxRecording();
  } else if (usingOpenAiRealtimeStt()) {
    await teardownOpenAiRealtimeConnection();
  } else {
    if (!state.mediaRecorder) {
      state.listening = false;
      syncControls();
      setState("idle", "idle");
      ui.liveTranscript.textContent = currentIdlePrompt();
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
  enqueueMessage(ui.textInput.value);
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
  await teardownSonioxRecording();
  await teardownOpenAiRealtimeConnection();
  ui.liveTranscript.textContent = currentIdlePrompt();
  addBubble(`Language set to ${currentLanguage().label}.`, "system");
  syncControls();
});

ui.sttProviderSelect.addEventListener("change", async (event) => {
  const nextProvider =
    event.target.value === "moonshine"
      ? "moonshine"
      : event.target.value === "soniox"
        ? "soniox"
        : "openai";
  if (nextProvider === state.sttProvider) {
    return;
  }

  if (state.listening) {
    await stopListening();
  }

  state.sttProvider = nextProvider;
  await teardownMoonshine();
  await teardownSonioxRecording();
  await teardownOpenAiRealtimeConnection();

  addBubble(
    nextProvider === "moonshine"
      ? "STT switched to Moonshine. Transcription runs in the browser."
      : nextProvider === "soniox"
        ? "STT switched to Soniox realtime transcription."
      : usingRealtimeMode()
        ? "STT switched to OpenAI Realtime transcription with VAD."
        : "STT switched to gpt-4o-mini-transcribe.",
    "system"
  );
  ui.liveTranscript.textContent = currentIdlePrompt();
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
  await teardownSonioxRecording();
  await teardownOpenAiRealtimeConnection();
  addBubble(
    nextMode === "realtime"
      ? usingMoonshine() || usingSoniox()
        ? "Mode switched to real-time free speech."
        : "Mode switched to real-time free speech with OpenAI Realtime transcription + VAD."
      : "Mode switched to push to talk.",
    "system"
  );
  ui.liveTranscript.textContent = currentIdlePrompt();
  syncControls();
});

ui.textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    enqueueMessage(ui.textInput.value);
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
  "Choose push to talk or real-time free speech. STT providers: OpenAI, Soniox, or Moonshine.",
  "system"
);
setState("idle", "idle");
ui.liveTranscript.textContent = currentIdlePrompt();
syncControls();
