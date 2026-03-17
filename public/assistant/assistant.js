const state = {
  worker: null,
  user: null,
  appointments: [],
  history: [],
  weekStart: startOfWeek(new Date())
};

const ui = {
  workerLabel: document.querySelector("#workerLabel"),
  userLabel: document.querySelector("#userLabel"),
  assistantStatus: document.querySelector("#assistantStatus"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  formMode: document.querySelector("#formMode"),
  editorDialog: document.querySelector("#editorDialog"),
  closeDialogButton: document.querySelector("#closeDialogButton"),
  appointmentForm: document.querySelector("#appointmentForm"),
  appointmentId: document.querySelector("#appointmentId"),
  titleInput: document.querySelector("#titleInput"),
  startInput: document.querySelector("#startInput"),
  endInput: document.querySelector("#endInput"),
  notesInput: document.querySelector("#notesInput"),
  deleteButton: document.querySelector("#deleteButton"),
  calendarRange: document.querySelector("#calendarRange"),
  calendarGrid: document.querySelector("#calendarGrid"),
  appointmentLedger: document.querySelector("#appointmentLedger"),
  previousWeekButton: document.querySelector("#previousWeekButton"),
  nextWeekButton: document.querySelector("#nextWeekButton"),
  todayButton: document.querySelector("#todayButton")
};

function startOfWeek(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  const day = value.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  value.setDate(value.getDate() + offset);
  return value;
}

function addDays(date, amount) {
  const value = new Date(date);
  value.setDate(value.getDate() + amount);
  return value;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function localDayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTimeLocal(value) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function browserTemporalContext() {
  const now = new Date();
  return {
    locale: navigator.language || "en-US",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local time",
    localNow: now.toString(),
    localIso: now.toISOString(),
    timezoneOffsetMinutes: now.getTimezoneOffset()
  };
}

function setAssistantStatus(text) {
  ui.assistantStatus.textContent = text;
}

function renderMessage(role, text) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  message.textContent = text;
  ui.chatLog.append(message);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

function syncMeta() {
  ui.workerLabel.textContent = state.worker ? `${state.worker.name} (${state.worker.id})` : "Loading...";
  ui.userLabel.textContent = state.user ? `${state.user.name} (${state.user.id})` : "Loading...";
}

function syncFormMode() {
  const editing = Boolean(ui.appointmentId.value);
  ui.formMode.textContent = editing ? "Edit appointment" : "Create appointment";
  ui.deleteButton.hidden = !editing;
}

function resetForm() {
  ui.appointmentForm.reset();
  ui.appointmentId.value = "";
  syncFormMode();
}

function openEditor() {
  if (!ui.editorDialog.open) {
    ui.editorDialog.showModal();
  }
}

function closeEditor() {
  if (ui.editorDialog.open) {
    ui.editorDialog.close();
  }
  resetForm();
}

function populateFormForCreate(day) {
  resetForm();
  const start = new Date(day);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + 30);
  ui.startInput.value = formatDateTimeLocal(start.toISOString());
  ui.endInput.value = formatDateTimeLocal(end.toISOString());
  openEditor();
}

function populateForm(appointment) {
  ui.appointmentId.value = appointment.id;
  ui.titleInput.value = appointment.title;
  ui.startInput.value = formatDateTimeLocal(appointment.startIso);
  ui.endInput.value = formatDateTimeLocal(appointment.endIso);
  ui.notesInput.value = appointment.notes || "";
  syncFormMode();
  openEditor();
}

function applyState(data) {
  state.worker = data.worker;
  state.user = data.user;
  state.appointments = data.appointments || [];
  syncMeta();
  renderCalendar();
  renderLedger();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || data?.details || "Request failed.");
  }
  return data;
}

async function loadState() {
  const data = await requestJson("/api/assistant/state");
  applyState(data);
}

function renderCalendar() {
  ui.calendarGrid.innerHTML = "";

  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
  const weekEnd = addDays(state.weekStart, 6);
  ui.calendarRange.textContent = `${state.weekStart.toLocaleDateString([], {
    month: "short",
    day: "numeric"
  })} - ${weekEnd.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric"
  })}`;

  for (const day of weekDays) {
    const dayKey = localDayKey(day);
    const column = document.createElement("section");
    column.className = "day-column";
    column.addEventListener("click", (event) => {
      if (event.target.closest(".appointment-card")) {
        return;
      }
      populateFormForCreate(day);
    });

    const heading = document.createElement("div");
    heading.className = "day-heading";
    heading.innerHTML = `
      <strong>${day.toLocaleDateString([], { weekday: "long" })}</strong>
      <span>${day.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
    `;
    column.append(heading);

    const appointments = state.appointments.filter(
      (appointment) => localDayKey(appointment.startIso) === dayKey
    );

    if (!appointments.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No appointments";
      column.append(empty);
    } else {
      for (const appointment of appointments) {
        const card = document.createElement("article");
        card.className = "appointment-card";
        card.innerHTML = `
          <div class="appointment-title">${appointment.title}</div>
          <div class="appointment-meta">${new Date(appointment.startIso).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
          })} - ${new Date(appointment.endIso).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
          })}</div>
          <div class="appointment-meta">${appointment.notes || "No notes"}</div>
        `;

        card.addEventListener("click", () => {
          populateForm(appointment);
        });

        column.append(card);
      }
    }

    ui.calendarGrid.append(column);
  }
}

function renderLedger() {
  ui.appointmentLedger.innerHTML = "";

  const header = document.createElement("div");
  header.className = "ledger-row header";
  header.innerHTML = `
    <div>Name</div>
    <div>Date</div>
    <div>Time</div>
    <div>User</div>
    <div>Worker</div>
    <div>Action</div>
  `;
  ui.appointmentLedger.append(header);

  for (const appointment of state.appointments) {
    const row = document.createElement("div");
    row.className = "ledger-row";

    const start = new Date(appointment.startIso);
    const end = new Date(appointment.endIso);
    const dateText = start.toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
    const timeText = `${start.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    })} - ${end.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    })}`;

    row.innerHTML = `
      <div class="ledger-cell">${appointment.title}</div>
      <div class="ledger-cell">${dateText}</div>
      <div class="ledger-cell">${timeText}</div>
      <div class="ledger-cell">${state.user?.name || appointment.userId}</div>
      <div class="ledger-cell">${state.worker?.name || appointment.workerId}</div>
    `;

    const actionCell = document.createElement("div");
    actionCell.className = "ledger-cell";

    const editButton = document.createElement("button");
    editButton.className = "secondary-button";
    editButton.type = "button";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => {
      populateForm(appointment);
    });

    actionCell.append(editButton);
    row.append(actionCell);
    ui.appointmentLedger.append(row);
  }
}

ui.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = ui.chatInput.value.trim();
  if (!message) {
    return;
  }

  renderMessage("user", message);
  state.history.push({ role: "user", content: message });
  ui.chatInput.value = "";
  setAssistantStatus("Working");

  try {
    const data = await requestJson("/api/assistant/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        history: state.history,
        clientContext: browserTemporalContext()
      })
    });

    renderMessage("assistant", data.reply);
    state.history.push({ role: "assistant", content: data.reply });
    applyState(data);
  } catch (error) {
    renderMessage("system", error instanceof Error ? error.message : String(error));
  } finally {
    setAssistantStatus("Ready");
  }
});

ui.appointmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    title: ui.titleInput.value,
    startIso: new Date(ui.startInput.value).toISOString(),
    endIso: new Date(ui.endInput.value).toISOString(),
    notes: ui.notesInput.value
  };

  const id = ui.appointmentId.value;
  const data = await requestJson(id ? `/api/assistant/appointments/${id}` : "/api/assistant/appointments", {
    method: id ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  applyState(data);
  closeEditor();
});

ui.deleteButton.addEventListener("click", async () => {
  const id = ui.appointmentId.value;
  if (!id) {
    closeEditor();
    return;
  }

  const data = await requestJson(`/api/assistant/appointments/${id}`, {
    method: "DELETE"
  });
  applyState(data);
  closeEditor();
});

ui.closeDialogButton.addEventListener("click", () => {
  closeEditor();
});

ui.previousWeekButton.addEventListener("click", () => {
  state.weekStart = addDays(state.weekStart, -7);
  renderCalendar();
});

ui.nextWeekButton.addEventListener("click", () => {
  state.weekStart = addDays(state.weekStart, 7);
  renderCalendar();
});

ui.todayButton.addEventListener("click", () => {
  state.weekStart = startOfWeek(new Date());
  renderCalendar();
});

renderMessage(
  "system",
  "Ask the scheduling assistant to book, move, or cancel appointments, or edit them directly below."
);

await loadState();
syncFormMode();
