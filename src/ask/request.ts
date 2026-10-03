export const MAX_QUESTION = 2_000;
export const MAX_HISTORY = 20;
export const MAX_TURN = 4_000;

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

export type AskRequest =
  | { ok: true; question: string; timeZone: string; today: string; history: AskTurn[] }
  | { ok: false; status: 400; message: string };

export function parseAskRequest(body: Record<string, unknown>, now = new Date()): AskRequest {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return { ok: false, status: 400, message: "Enter a question." };
  }
  if (question.length > MAX_QUESTION) {
    return { ok: false, status: 400, message: "Ask a shorter question." };
  }
  const timeZone = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
  const today = localDate(timeZone, now);
  if (!today) {
    return { ok: false, status: 400, message: "Send a time zone." };
  }
  const history = readHistory(body.messages);
  if (typeof history === "string") {
    return { ok: false, status: 400, message: history };
  }
  return { ok: true, question, timeZone, today, history };
}

export function localDate(timeZone: string, now = new Date()): string | undefined {
  if (!timeZone || timeZone.length > 100) {
    return undefined;
  }
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : undefined;
  } catch {
    return undefined;
  }
}

function readHistory(value: unknown): AskTurn[] | string {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return "That conversation isn't valid.";
  }
  const turns: AskTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "That conversation isn't valid.";
    }
    const record = item as Record<string, unknown>;
    if ((record.role !== "user" && record.role !== "assistant") || typeof record.content !== "string") {
      return "That conversation isn't valid.";
    }
    const content = record.content.trim();
    if (!content) {
      return "That conversation isn't valid.";
    }
    turns.push({ role: record.role, content: content.slice(0, MAX_TURN) });
  }
  return turns.slice(-MAX_HISTORY);
}
