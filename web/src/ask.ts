import { MAX_TURN } from "../../src/ask/request.js";
import { releaseSurface, renderSurface } from "./a2ui.js";
import { localTimeZone } from "./time.js";

const MAX_HISTORY = 20;

/** The next turn's memory of this answer: the sentence, then the chart the page drew. */
export function assistantMemory(text: string, surface: ParentNode): string {
  const spoken = text.trim();
  const chart = chartMemory(surface);
  const combined = [spoken, chart].filter((part) => part !== "").join("\n");
  return (combined || "Shown a chart.").slice(0, MAX_TURN);
}

function chartMemory(surface: ParentNode): string {
  const lines: string[] = [];
  for (const node of surface.querySelectorAll(".ask-title, .ask-body, figcaption")) {
    const value = node.textContent?.trim() ?? "";
    if (value) {
      lines.push(value);
    }
  }
  const table = surface.querySelector("table");
  if (table) {
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = [...row.children].map((cell) => cell.textContent?.trim() ?? "").filter((cell) => cell !== "");
      if (cells.length > 0) {
        lines.push(cells.join(" "));
      }
    }
  }
  return lines.join("\n");
}

interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

interface AskHandlers {
  onStatus: (message: string) => void;
  onText: (text: string) => void;
  onSurface: (messages: unknown[]) => void;
}

function required<T extends Element>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export function mountAsk(): void {
  const form = required(document.querySelector<HTMLFormElement>("#ask-form"), "ask-form");
  const input = required(document.querySelector<HTMLInputElement>("#ask-question"), "ask-question");
  const button = required(document.querySelector<HTMLButtonElement>("#ask-button"), "ask-button");
  const errorEl = required(document.querySelector<HTMLParagraphElement>("#ask-error"), "ask-error");
  const statusEl = required(document.querySelector<HTMLParagraphElement>("#ask-status"), "ask-status");
  const emptyEl = required(document.querySelector<HTMLParagraphElement>("#ask-empty"), "ask-empty");
  const log = required(document.querySelector<HTMLElement>("#ask-log"), "ask-log");
  const history: AskTurn[] = [];
  let asking = false;

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === "";
    if (message) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  };

  const setBusy = (busy: boolean): void => {
    button.disabled = busy;
    form.setAttribute("aria-busy", busy ? "true" : "false");
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || asking) {
      return;
    }
    void send(question);
  });

  async function send(question: string): Promise<void> {
    asking = true;
    setBusy(true);
    setError("");
    input.value = "";
    emptyEl.hidden = true;
    const user = turn("user", question);
    const assistant = document.createElement("article");
    assistant.className = "ask-turn ask-assistant";
    const surface = document.createElement("div");
    surface.className = "ask-surface";
    const answer = document.createElement("p");
    answer.className = "ask-answer";
    assistant.append(surface, answer);
    log.append(user, assistant);
    assistant.scrollIntoView({ block: "nearest" });
    const messages: unknown[] = [];
    let text = "";
    try {
      await streamAsk(question, history.slice(-MAX_HISTORY), {
        onStatus(message) {
          statusEl.textContent = message;
        },
        onText(value) {
          text = value;
          answer.textContent = value;
        },
        onSurface(next) {
          messages.splice(0, messages.length, ...next);
          renderSurface(surface, messages);
        },
      });
      history.push({ role: "user", content: question }, { role: "assistant", content: assistantMemory(text, surface) });
      statusEl.textContent = "";
    } catch (error) {
      releaseSurface(surface);
      user.remove();
      assistant.remove();
      if (input.value === "") {
        input.value = question;
      }
      if (log.querySelector(".ask-turn") === null) {
        emptyEl.hidden = false;
      }
      setError(error instanceof Error ? error.message : "Couldn't answer that. Try again in a moment.");
      statusEl.textContent = "";
    } finally {
      asking = false;
      setBusy(false);
      input.focus();
    }
  }

  function turn(role: "user", text: string): HTMLElement {
    const node = document.createElement("article");
    node.className = `ask-turn ask-${role}`;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    node.append(paragraph);
    return node;
  }
}

async function streamAsk(question: string, history: AskTurn[], handlers: AskHandlers): Promise<void> {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({ question, timeZone: localTimeZone(), messages: history }),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("ndjson") || !response.body) {
    throw new Error(await readError(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed: string | undefined;
  let finished = false;
  const surface: unknown[] = [];

  const consume = (line: string): void => {
    const event = parseLine(line);
    if (!event) {
      return;
    }
    if (event.type === "status") {
      handlers.onStatus(event.message);
      return;
    }
    if (event.type === "text") {
      handlers.onText(event.text);
      return;
    }
    if (event.type === "a2ui") {
      surface.push(event.message);
      handlers.onSurface([...surface]);
      return;
    }
    if (event.type === "error") {
      failed = event.message;
      return;
    }
    finished = true;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffer + decoder.decode());
  if (failed) {
    throw new Error(failed);
  }
  if (!finished) {
    throw new Error("Couldn't answer that. Try again in a moment.");
  }
}

function parseLine(
  line: string,
):
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "a2ui"; message: unknown }
  | { type: "error"; message: string }
  | { type: "done" }
  | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "status" && typeof record.message === "string") {
    return { type: "status", message: record.message };
  }
  if (record.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  if (record.type === "a2ui" && record.message && typeof record.message === "object") {
    return { type: "a2ui", message: record.message };
  }
  if (record.type === "done") {
    return { type: "done" };
  }
  if (record.type === "error") {
    const error = record.error;
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "Couldn't answer that. Try again in a moment.";
    return { type: "error", message };
  }
  return undefined;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") {
      return body.error.message;
    }
  } catch {
    return "Couldn't answer that. Try again in a moment.";
  }
  return "Couldn't answer that. Try again in a moment.";
}
