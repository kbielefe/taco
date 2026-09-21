import { describe, expect, it } from "vitest";
import { JournalConflictError } from "./errors.js";
import { MemoryJournalStore } from "./store.js";
import type { JournalKind, JournalObservation } from "./types.js";

function kind(nameKey: string, label = nameKey): Omit<JournalKind, "_id"> {
  return {
    label,
    nameKey,
    fields: [{ id: "weight", label: "Weight", type: "number", unit: "lb" }],
    createdAt: new Date("2026-09-20T12:00:00Z"),
  };
}

function observation(
  kindId: JournalKind["_id"],
  at: string,
  createdAt = at,
): Omit<JournalObservation, "_id"> {
  return {
    at: new Date(at),
    createdAt: new Date(createdAt),
    kindId,
    values: [{ fieldId: "weight", value: 315 }],
  };
}

describe("MemoryJournalStore", () => {
  it("rejects a duplicate kind name", async () => {
    const store = new MemoryJournalStore();
    await store.insertKind(kind("weight", "Weight"));
    await expect(store.insertKind(kind("weight", "weight"))).rejects.toBeInstanceOf(JournalConflictError);
  });

  it("lists observations in range, newest first, and deletes them", async () => {
    const store = new MemoryJournalStore();
    const storedKind = await store.insertKind(kind("weight", "Weight"));
    const morning = await store.insertObservation(observation(storedKind._id, "2026-09-20T08:00:00Z"));
    await store.insertObservation(observation(storedKind._id, "2026-09-19T12:00:00Z"));
    const later = await store.insertObservation(
      observation(storedKind._id, "2026-09-20T08:00:00Z", "2026-09-20T09:00:00Z"),
    );
    await store.insertObservation(observation(storedKind._id, "2026-09-21T00:00:00Z"));

    const listed = await store.listObservations(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
    expect(listed.map((entry) => entry._id.toHexString())).toEqual([later._id.toHexString(), morning._id.toHexString()]);

    expect(await store.deleteObservation(morning._id.toHexString())).toBe(true);
    expect(await store.deleteObservation(morning._id.toHexString())).toBe(false);
    expect(await store.deleteObservation("not-an-id")).toBe(false);
  });

  it("replaces fields and can drop a kind", async () => {
    const store = new MemoryJournalStore();
    const storedKind = await store.insertKind(kind("weight", "Weight"));
    const saved = await store.saveFields(storedKind._id.toHexString(), [
      ...storedKind.fields,
      { id: "note", label: "Note", type: "text" },
    ]);
    expect(saved?.fields.map((field) => field.id)).toEqual(["weight", "note"]);
    expect(await store.deleteKind(storedKind._id.toHexString())).toBe(true);
    expect(await store.findKind(storedKind._id.toHexString())).toBeNull();
  });
});
