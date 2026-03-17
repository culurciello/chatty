import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const sonioxApiKey = process.env.SONIOX_API_KEY;
const sonioxRealtimeModel = process.env.SONIOX_REALTIME_MODEL || "stt-rt-preview";
const schedulingAssistantModel =
  process.env.OPENAI_SCHEDULING_MODEL || chatModel;
const defaultWorkerId = "worker-1";
const defaultUserId = "user-1";
const dataDirectory = path.join(__dirname, "data");
const sqlitePath = path.join(dataDirectory, "assistant.sqlite");

fs.mkdirSync(dataDirectory, { recursive: true });
const sqlite = new DatabaseSync(sqlitePath);

function logEvent(stage, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[${new Date().toISOString()}] ${stage}${suffix}`);
}

function localTimezoneName() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}

function localOffsetIso(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function localDateTimeReference(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${localOffsetIso(date)}`;
}

function clientTemporalReference(clientContext) {
  const fallbackNow = new Date();
  const candidate =
    typeof clientContext?.localNow === "string" && !Number.isNaN(Date.parse(clientContext.localNow))
      ? new Date(clientContext.localNow)
      : typeof clientContext?.localIso === "string" && !Number.isNaN(Date.parse(clientContext.localIso))
        ? new Date(clientContext.localIso)
        : fallbackNow;

  return {
    now: candidate,
    localNow: localDateTimeReference(candidate),
    utcNow: candidate.toISOString(),
    locale:
      typeof clientContext?.locale === "string" && clientContext.locale.trim()
        ? clientContext.locale.trim()
        : "en-US",
    timeZone:
      typeof clientContext?.timeZone === "string" && clientContext.timeZone.trim()
        ? clientContext.timeZone.trim()
        : localTimezoneName(),
    localOffset: localOffsetIso(candidate)
  };
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(worker_id) REFERENCES workers(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

const insertWorkerStatement = sqlite.prepare(`
  INSERT OR IGNORE INTO workers (id, name)
  VALUES (?, ?)
`);
const insertUserStatement = sqlite.prepare(`
  INSERT OR IGNORE INTO users (id, name)
  VALUES (?, ?)
`);
const insertAppointmentStatement = sqlite.prepare(`
  INSERT OR IGNORE INTO appointments (
    id, worker_id, user_id, title, notes, start_iso, end_iso, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertWorkerStatement.run(defaultWorkerId, "Studio Calendar");
insertUserStatement.run(defaultUserId, "Walk-in User");
insertAppointmentStatement.run(
  "appt-1",
  defaultWorkerId,
  defaultUserId,
  "Planning Session",
  "Initial intake call",
  "2026-03-17T10:00:00.000Z",
  "2026-03-17T10:45:00.000Z",
  "2026-03-16T15:00:00.000Z",
  "2026-03-16T15:00:00.000Z"
);

function currentContext() {
  return {
    worker: sqlite
      .prepare("SELECT id, name FROM workers WHERE id = ?")
      .get(defaultWorkerId),
    user: sqlite
      .prepare("SELECT id, name FROM users WHERE id = ?")
      .get(defaultUserId)
  };
}

function getAppointmentsForWorker(workerId = defaultWorkerId) {
  return sqlite
    .prepare(`
      SELECT
        id,
        worker_id AS workerId,
        user_id AS userId,
        title,
        notes,
        start_iso AS startIso,
        end_iso AS endIso,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM appointments
      WHERE worker_id = ?
      ORDER BY start_iso ASC
    `)
    .all(workerId);
}

function serializeAppointment(appointment) {
  return {
    id: appointment.id,
    workerId: appointment.workerId,
    userId: appointment.userId,
    title: appointment.title,
    notes: appointment.notes,
    startIso: appointment.startIso,
    endIso: appointment.endIso,
    createdAt: appointment.createdAt,
    updatedAt: appointment.updatedAt
  };
}

function parseAppointmentPayload(payload, fallback = {}) {
  const title = typeof payload?.title === "string" ? payload.title.trim() : fallback.title;
  const notes = typeof payload?.notes === "string" ? payload.notes.trim() : fallback.notes || "";
  const startIso =
    typeof payload?.startIso === "string" ? new Date(payload.startIso).toISOString() : fallback.startIso;
  const endIso =
    typeof payload?.endIso === "string" ? new Date(payload.endIso).toISOString() : fallback.endIso;

  if (!title) {
    throw new Error("Appointment title is required.");
  }

  if (!startIso || !endIso || Number.isNaN(Date.parse(startIso)) || Number.isNaN(Date.parse(endIso))) {
    throw new Error("Valid start and end datetimes are required.");
  }

  if (Date.parse(endIso) <= Date.parse(startIso)) {
    throw new Error("Appointment end must be after start.");
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (Date.parse(startIso) < todayStart.getTime()) {
    throw new Error("Appointments cannot be booked in the past relative to today.");
  }

  return { title, notes, startIso, endIso };
}

function createAppointment(payload, actor = "manual") {
  const parsed = parseAppointmentPayload(payload);
  const nowIso = new Date().toISOString();
  const appointmentId = `appt-${crypto.randomUUID()}`;
  sqlite
    .prepare(`
      INSERT INTO appointments (
        id, worker_id, user_id, title, notes, start_iso, end_iso, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      appointmentId,
      defaultWorkerId,
      defaultUserId,
      parsed.title,
      parsed.notes,
      parsed.startIso,
      parsed.endIso,
      nowIso,
      nowIso
    );

  logEvent("appointment_created", `id=${appointmentId} actor=${actor}`);
  return serializeAppointment(
    sqlite
      .prepare(`
        SELECT
          id,
          worker_id AS workerId,
          user_id AS userId,
          title,
          notes,
          start_iso AS startIso,
          end_iso AS endIso,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM appointments
        WHERE id = ?
      `)
      .get(appointmentId)
  );
}

function updateAppointment(id, payload, actor = "manual") {
  const existing = sqlite
    .prepare(`
      SELECT
        id,
        worker_id AS workerId,
        user_id AS userId,
        title,
        notes,
        start_iso AS startIso,
        end_iso AS endIso,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM appointments
      WHERE id = ?
    `)
    .get(id);
  if (!existing) {
    throw new Error("Appointment not found.");
  }

  const parsed = parseAppointmentPayload(payload, existing);
  const updatedAt = new Date().toISOString();
  sqlite
    .prepare(`
      UPDATE appointments
      SET title = ?, notes = ?, start_iso = ?, end_iso = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(parsed.title, parsed.notes, parsed.startIso, parsed.endIso, updatedAt, id);

  logEvent("appointment_updated", `id=${id} actor=${actor}`);
  return serializeAppointment(
    sqlite
      .prepare(`
        SELECT
          id,
          worker_id AS workerId,
          user_id AS userId,
          title,
          notes,
          start_iso AS startIso,
          end_iso AS endIso,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM appointments
        WHERE id = ?
      `)
      .get(id)
  );
}

function deleteAppointment(id, actor = "manual") {
  const existing = sqlite
    .prepare(`
      SELECT
        id,
        worker_id AS workerId,
        user_id AS userId,
        title,
        notes,
        start_iso AS startIso,
        end_iso AS endIso,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM appointments
      WHERE id = ?
    `)
    .get(id);
  if (!existing) {
    throw new Error("Appointment not found.");
  }

  sqlite.prepare("DELETE FROM appointments WHERE id = ?").run(id);
  logEvent("appointment_deleted", `id=${id} actor=${actor}`);
  return serializeAppointment(existing);
}

function assistantStateResponse() {
  const { worker, user } = currentContext();
  return {
    worker,
    user,
    appointments: getAppointmentsForWorker().map(serializeAppointment)
  };
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/assistant", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "assistant", "index.html"));
});

app.get("/api/health", (_req, res) => {
  logEvent("health_check");
  res.json({
    ok: true,
    configured: Boolean(openAiApiKey),
    sonioxConfigured: Boolean(sonioxApiKey),
    chatModel,
    transcriptionModel,
    realtimeTranscriptionModel,
    sonioxRealtimeModel,
    schedulingAssistantModel,
    speechModel,
    speechVoice
  });
});

app.get("/api/assistant/state", (_req, res) => {
  res.json(assistantStateResponse());
});

app.post("/api/assistant/appointments", (req, res) => {
  try {
    const appointment = createAppointment(req.body, "manual");
    res.status(201).json({
      appointment,
      ...assistantStateResponse()
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.patch("/api/assistant/appointments/:id", (req, res) => {
  try {
    const appointment = updateAppointment(req.params.id, req.body, "manual");
    res.json({
      appointment,
      ...assistantStateResponse()
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.delete("/api/assistant/appointments/:id", (req, res) => {
  try {
    const appointment = deleteAppointment(req.params.id, "manual");
    res.json({
      appointment,
      ...assistantStateResponse()
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/assistant/chat", async (req, res) => {
  if (!openAiApiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is missing. Add it to .env before using the assistant."
    });
  }

  const userMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const temporal = clientTemporalReference(req.body?.clientContext);

  if (!userMessage) {
    return res.status(400).json({ error: "Message is required." });
  }

  const assistantTools = [
    {
      type: "function",
      function: {
        name: "list_appointments",
        description: "List all appointments for the current worker.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_appointment",
        description: "Create a calendar appointment for the current user on the current worker calendar.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["title", "startIso", "endIso"],
          properties: {
            title: { type: "string" },
            notes: { type: "string" },
            startIso: {
              type: "string",
              description: "ISO 8601 datetime in local timezone with numeric offset, for example 2026-03-17T16:00:00-04:00"
            },
            endIso: {
              type: "string",
              description: "ISO 8601 datetime in local timezone with numeric offset, for example 2026-03-17T17:00:00-04:00"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_appointment",
        description: "Modify an existing appointment by id.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            notes: { type: "string" },
            startIso: {
              type: "string",
              description: "ISO 8601 datetime in local timezone with numeric offset, for example 2026-03-17T16:00:00-04:00"
            },
            endIso: {
              type: "string",
              description: "ISO 8601 datetime in local timezone with numeric offset, for example 2026-03-17T17:00:00-04:00"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_appointment",
        description: "Delete an appointment by id.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string" }
          }
        }
      }
    }
  ];

  const toolHandlers = {
    list_appointments: () =>
      JSON.stringify({
        appointments: getAppointmentsForWorker().map(serializeAppointment)
      }),
    create_appointment: (argumentsJson) => {
      const appointment = createAppointment(JSON.parse(argumentsJson || "{}"), "assistant");
      return JSON.stringify({ appointment, appointments: getAppointmentsForWorker().map(serializeAppointment) });
    },
    update_appointment: (argumentsJson) => {
      const args = JSON.parse(argumentsJson || "{}");
      const appointment = updateAppointment(args.id, args, "assistant");
      return JSON.stringify({ appointment, appointments: getAppointmentsForWorker().map(serializeAppointment) });
    },
    delete_appointment: (argumentsJson) => {
      const args = JSON.parse(argumentsJson || "{}");
      const appointment = deleteAppointment(args.id, "assistant");
      return JSON.stringify({ appointment, appointments: getAppointmentsForWorker().map(serializeAppointment) });
    }
  };

  const { worker, user } = currentContext();
  const messages = [
    {
      role: "system",
      content:
        `You are an automated scheduling assistant. Current worker: ${worker.name} (${worker.id}). ` +
        `Current user: ${user.name} (${user.id}). Use tools whenever the user wants to book, move, edit, cancel, or inspect appointments. ` +
        `The website locale is ${temporal.locale}. The current UTC datetime is ${temporal.utcNow}. The current local datetime from the website is ${temporal.localNow} in timezone ${temporal.timeZone}. ` +
        `Always interpret user times in local timezone ${temporal.timeZone} with offset ${temporal.localOffset}, never as UTC unless the user explicitly says UTC. ` +
        `When you call tools, emit ISO datetimes with the local timezone offset, not with Z unless the user explicitly requested UTC. ` +
        `If the user omits year, assume the current year from ${temporal.localNow}. ` +
        `If the user omits month, assume the current month from ${temporal.localNow}. ` +
        `If the user omits week, assume the current week containing ${temporal.localNow}. ` +
        `If the user omits a specific day or date entirely, assume today relative to ${temporal.localNow}. ` +
        "When the user gives a partial date, fill in the missing pieces from today in local time unless they explicitly say otherwise. " +
        "Never book, move, or modify an appointment into the past relative to today. " +
        "Be concise and confirm the resulting schedule state after changes. If essential information is missing, ask one short clarifying question."
    },
    ...history
      .filter((item) => item && typeof item.role === "string" && typeof item.content === "string")
      .slice(-12),
    { role: "user", content: userMessage }
  ];

  try {
    let completionMessages = messages;
    let assistantReply = "";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`
        },
        body: JSON.stringify({
          model: schedulingAssistantModel,
          messages: completionMessages,
          tools: assistantTools,
          tool_choice: "auto",
          temperature: 0.2
        })
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: "Scheduling assistant request failed.",
          details: data
        });
      }

      const message = data?.choices?.[0]?.message;
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

      if (!toolCalls.length) {
        assistantReply = message?.content?.trim() || "I updated the schedule.";
        break;
      }

      completionMessages = [...completionMessages, message];
      for (const toolCall of toolCalls) {
        const handler = toolHandlers[toolCall.function?.name];
        const toolResult = handler
          ? handler(toolCall.function?.arguments)
          : JSON.stringify({ error: "Unknown tool." });

        completionMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }
    }

    return res.json({
      reply: assistantReply || "Done.",
      ...assistantStateResponse()
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected scheduling assistant error.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/soniox-temporary-key", async (_req, res) => {
  if (!sonioxApiKey) {
    logEvent("config_error", "SONIOX_API_KEY is missing");
    return res.status(500).json({
      error: "SONIOX_API_KEY is missing. Add it to .env before using Soniox."
    });
  }

  try {
    logEvent("soniox_temp_key_start", `model=${sonioxRealtimeModel}`);
    const response = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sonioxApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        usage_type: "transcribe_websocket",
        expires_in_seconds: 60
      })
    });

    const data = await response.json();
    if (!response.ok) {
      logEvent("soniox_temp_key_error", `status=${response.status}`);
      return res.status(response.status).json({
        error: "Failed to create Soniox temporary API key.",
        details: data
      });
    }

    logEvent("soniox_temp_key_ready");
    return res.json({
      apiKey: data?.api_key,
      model: sonioxRealtimeModel
    });
  } catch (error) {
    logEvent(
      "soniox_temp_key_error",
      error instanceof Error ? error.message : String(error)
    );
    return res.status(500).json({
      error: "Unexpected Soniox temporary key error.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
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
