import { describe, expect, it } from "vitest";
import { MAX_HISTORY, MAX_TURN, localDate, parseAskRequest } from "./request.js";

describe("parseAskRequest", () => {
  it("uses the time zone's calendar day", () => {
    expect(localDate("America/Chicago", new Date("2026-10-03T03:30:00.000Z"))).toBe("2026-10-02");
    expect(localDate("America/Chicago", new Date("2026-10-03T05:30:00.000Z"))).toBe("2026-10-03");
    expect(localDate("Not/AZone")).toBeUndefined();
  });

  it("rejects an empty question or a missing time zone", () => {
    expect(parseAskRequest({ question: "  ", timeZone: "America/Chicago" })).toMatchObject({
      ok: false,
      message: "Enter a question.",
    });
    expect(parseAskRequest({ question: "Weight?", timeZone: "Not/AZone" })).toMatchObject({
      ok: false,
      message: "Send a time zone.",
    });
  });

  it("keeps the newest turns and shortens a long reply", () => {
    const messages = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 0 ? "x".repeat(MAX_TURN + 20) : `turn ${index}`,
    }));
    const parsed = parseAskRequest({ question: "And today?", timeZone: "UTC", messages });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.history).toHaveLength(MAX_HISTORY);
    expect(parsed.history[0]?.content).toBe("turn 5");
    expect(parsed.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const long = parseAskRequest({
      question: "Hi",
      timeZone: "UTC",
      messages: [{ role: "assistant", content: "y".repeat(MAX_TURN + 10) }],
    });
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.history[0]?.content).toHaveLength(MAX_TURN);
    }
  });

  it("rejects a turn with an unknown role", () => {
    expect(parseAskRequest({ question: "Hi", timeZone: "UTC", messages: [{ role: "system", content: "no" }] })).toMatchObject({
      ok: false,
      message: "That conversation isn't valid.",
    });
  });
});
