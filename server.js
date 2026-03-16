import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3005);
const host = process.env.HOST || "127.0.0.1";
const openAiApiKey = process.env.OPENAI_API_KEY;
const chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const speechModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const transcriptionModel =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const speechVoice = process.env.OPENAI_TTS_VOICE || "alloy";
const systemPrompt =
  process.env.SYSTEM_PROMPT ||
  "You are a concise, helpful voice assistant. Reply conversationally and keep answers brief unless the user asks for more detail.";
const startedAt = new Date().toISOString();
const supportedLanguages = {
  en: "English",
  it: "Italian",
  ko: "Korean"
};
const upload = multer({ storage: multer.memoryStorage() });
const realtimeTranscriptionModel =
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

function logEvent(stage, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[${new Date().toISOString()}] ${stage}${suffix}`);
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  logEvent("health_check");
  res.json({
    ok: true,
    configured: Boolean(openAiApiKey),
    chatModel,
    transcriptionModel,
    realtimeTranscriptionModel,
    speechModel,
    speechVoice
  });
});

app.post("/api/realtime-transcription-session", async (req, res) => {
  if (!openAiApiKey) {
    logEvent("config_error", "OPENAI_API_KEY is missing");
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing. Add it to .env before using the app."
    });
  }

  const languageCode =
    typeof req.body?.language === "string" && req.body.language in supportedLanguages
      ? req.body.language
      : "en";

  const sessionConfig = {
    session: {
      type: "transcription",
      audio: {
        input: {
          noise_reduction: {
            type: "near_field"
          },
          transcription: {
            model: realtimeTranscriptionModel,
            language: languageCode
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }
    }
  };

  try {
    logEvent(
      "realtime_session_start",
      `model=${realtimeTranscriptionModel} language=${languageCode}`
    );

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(sessionConfig)
    });

    const data = await response.json();

    if (!response.ok) {
      logEvent("realtime_session_error", `status=${response.status}`);
      return res.status(response.status).json({
        error: "Failed to create realtime transcription session.",
        details: data
      });
    }

    logEvent("realtime_session_ready", `language=${languageCode}`);
    return res.json(data);
  } catch (error) {
    logEvent(
      "realtime_session_error",
      error instanceof Error ? error.message : String(error)
    );
    return res.status(500).json({
      error: "Unexpected realtime session error.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!openAiApiKey) {
    logEvent("config_error", "OPENAI_API_KEY is missing");
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing. Add it to .env before using the app."
    });
  }

  if (!req.file?.buffer?.length) {
    logEvent("request_rejected", "missing audio upload");
    return res.status(400).json({ error: "Audio upload is required." });
  }

  const languageCode =
    typeof req.body?.language === "string" && req.body.language in supportedLanguages
      ? req.body.language
      : "en";

  try {
    logEvent(
      "transcription_start",
      `model=${transcriptionModel} language=${languageCode} bytes=${req.file.buffer.length}`
    );

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }),
      req.file.originalname || "speech.webm"
    );
    formData.append("model", transcriptionModel);
    formData.append("language", languageCode);
    formData.append("response_format", "text");

    const transcriptionResponse = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`
        },
        body: formData
      }
    );

    if (!transcriptionResponse.ok) {
      const errorText = await transcriptionResponse.text();
      logEvent("transcription_error", `status=${transcriptionResponse.status}`);
      return res.status(transcriptionResponse.status).json({
        error: "OpenAI transcription request failed.",
        details: errorText
      });
    }

    const transcript = (await transcriptionResponse.text()).trim();
    logEvent("transcription_done", `chars=${transcript.length}`);
    return res.json({ transcript });
  } catch (error) {
    logEvent(
      "transcription_error",
      error instanceof Error ? error.message : String(error)
    );
    return res.status(500).json({
      error: "Unexpected transcription error.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/voice-chat", async (req, res) => {
  if (!openAiApiKey) {
    logEvent("config_error", "OPENAI_API_KEY is missing");
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing. Add it to .env before using the app."
    });
  }

  const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const languageCode =
    typeof req.body?.language === "string" && req.body.language in supportedLanguages
      ? req.body.language
      : "en";
  const languageLabel = supportedLanguages[languageCode];

  if (!transcript) {
    logEvent("request_rejected", "empty transcript");
    return res.status(400).json({ error: "Transcript is required." });
  }

  logEvent(
    "listening_complete",
    `transcript="${transcript.slice(0, 120)}" language=${languageCode}`
  );
  logEvent("processing_text", `history_items=${history.length} language=${languageCode}`);

  const messages = [
    {
      role: "system",
      content: `${systemPrompt} Always reply in ${languageLabel} unless the user explicitly asks to switch languages.`
    },
    ...history
      .filter((item) => item && typeof item.role === "string" && typeof item.content === "string")
      .slice(-12),
    { role: "user", content: transcript }
  ];

  try {
    logEvent("openai_chat_start", `model=${chatModel}`);
    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify({
        model: chatModel,
        messages,
        temperature: 0.7
      })
    });

    if (!chatResponse.ok) {
      const errorText = await chatResponse.text();
      logEvent("openai_chat_error", `status=${chatResponse.status}`);
      return res.status(chatResponse.status).json({
        error: "OpenAI chat request failed.",
        details: errorText
      });
    }

    const chatData = await chatResponse.json();
    const assistantText = chatData?.choices?.[0]?.message?.content?.trim();

    if (!assistantText) {
      logEvent("openai_chat_error", "assistant text missing");
      return res.status(502).json({
        error: "OpenAI chat response did not contain assistant text."
      });
    }

    logEvent("openai_chat_done", `assistant_chars=${assistantText.length}`);
    logEvent("tts_start", `model=${speechModel} voice=${speechVoice}`);
    const speechResponse = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify({
        model: speechModel,
        voice: speechVoice,
        input: assistantText,
        format: "mp3"
      })
    });

    if (!speechResponse.ok) {
      const errorText = await speechResponse.text();
      logEvent("tts_error", `status=${speechResponse.status}`);
      return res.status(speechResponse.status).json({
        error: "OpenAI TTS request failed.",
        details: errorText,
        assistantText
      });
    }

    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    logEvent("tts_done", `audio_bytes=${audioBuffer.length}`);
    logEvent("request_complete");

    return res.json({
      transcript,
      assistantText,
      audioBase64: audioBuffer.toString("base64"),
      mimeType: "audio/mpeg"
    });
  } catch (error) {
    logEvent(
      "request_error",
      error instanceof Error ? error.message : String(error)
    );
    return res.status(500).json({
      error: "Unexpected server error.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(port, host, () => {
  logEvent(
    "server_ready",
    `url=http://${host}:${port} started_at=${startedAt}`
  );
});
