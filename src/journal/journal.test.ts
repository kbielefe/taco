import { describe, expect, it } from "vitest";
import { Journal } from "./journal.js";
import { MemoryJournalStore } from "./store.js";
import type { JournalObservation, JournalStore } from "./types.js";

const day = new Date("2026-09-20T15:00:00Z");

function service(): Journal {
  return new Journal(new MemoryJournalStore());
}

describe("Journal", () => {
  it("logs a new kind and lists it newest first", async () => {
    const journal = service();
    const weight = await journal.log({
      at: day,
      kind: { label: "Weight", fields: [{ label: "Weight", type: "number", unit: "lb" }] },
      values: [{ fieldId: "Weight", value: 315 }],
    });
    await journal.log({
      at: new Date("2026-09-20T16:00:00Z"),
      kindId: weight.kind._id.toHexString(),
      values: [{ fieldId: "weight", value: 314 }],
    });

    const listed = await journal.list(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
    expect(listed.map((entry) => entry.observation.values[0]?.value)).toEqual([314, 315]);
    expect(listed[0]?.kind.label).toBe("Weight");

    const kinds = await journal.kinds();
    expect(kinds).toHaveLength(1);
    expect(kinds[0]?.lastUsedAt?.toISOString()).toBe("2026-09-20T16:00:00.000Z");
  });

  it("logs migraine as gone without a severity, and blood pressure as two numbers", async () => {
    const journal = service();
    const migraine = await journal.log({
      at: day,
      kind: {
        label: "Migraine",
        fields: [
          { label: "Severity", type: "enum", options: ["mild", "moderate", "severe"] },
          { label: "Course", type: "enum", options: ["started", "gone"] },
        ],
      },
      values: [{ fieldId: "Course", value: "gone" }],
    });
    expect(migraine.observation.values).toEqual([{ fieldId: "course", value: "gone" }]);

    const pressure = await journal.log({
      at: day,
      kind: {
        label: "Blood pressure",
        fields: [
          { label: "Systolic", type: "number", unit: "mmHg" },
          { label: "Diastolic", type: "number", unit: "mmHg" },
        ],
      },
      values: [
        { fieldId: "Systolic", value: 120 },
        { fieldId: "Diastolic", value: 80 },
      ],
    });
    expect(pressure.observation.values).toEqual([
      { fieldId: "systolic", value: 120 },
      { fieldId: "diastolic", value: 80 },
    ]);
  });

  it("rejects a duplicate name and rolls back a kind if the entry fails", async () => {
    const journal = service();
    await journal.log({
      at: day,
      kind: { label: "Weight", fields: [{ label: "Weight", type: "number", unit: "lb" }] },
      values: [{ fieldId: "Weight", value: 315 }],
    });
    await expect(
      journal.log({
        at: day,
        kind: { label: "weight", fields: [{ label: "Weight", type: "number", unit: "lb" }] },
        values: [{ fieldId: "Weight", value: 1 }],
      }),
    ).rejects.toThrow(/already used/i);

    class FailStore extends MemoryJournalStore implements JournalStore {
      override async insertObservation(): Promise<JournalObservation> {
        throw new Error("disk full");
      }
    }
    const failing = new Journal(new FailStore());
    await expect(
      failing.log({
        at: day,
        kind: { label: "Nurtec", fields: [{ label: "Taken", type: "event" }] },
        values: [{ fieldId: "Taken", value: true }],
      }),
    ).rejects.toThrow(/disk full/);
    expect(await failing.kinds()).toEqual([]);
  });

  it("appends a field and a choice, and suggests recent text", async () => {
    const journal = service();
    const pain = await journal.log({
      at: new Date("2026-09-20T12:00:00Z"),
      kind: {
        label: "Pain",
        fields: [
          { label: "Severity", type: "enum", options: ["mild", "moderate"] },
          { label: "Area", type: "text" },
        ],
      },
      values: [
        { fieldId: "Severity", value: "mild" },
        { fieldId: "Area", value: "head" },
      ],
    });
    await journal.log({
      at: new Date("2026-09-20T13:00:00Z"),
      kindId: pain.kind._id.toHexString(),
      values: [{ fieldId: "area", value: "neck" }],
    });
    await journal.log({
      at: new Date("2026-09-20T14:00:00Z"),
      kindId: pain.kind._id.toHexString(),
      values: [{ fieldId: "area", value: "head" }],
    });

    const withField = await journal.append(pain.kind._id.toHexString(), {
      addFields: [{ label: "Side", type: "text" }],
    });
    expect(withField.fields.map((field) => field.id)).toEqual(["severity", "area", "side"]);

    const withOption = await journal.append(pain.kind._id.toHexString(), {
      addOptions: [{ fieldId: "severity", options: ["severe"] }],
    });
    expect(withOption.fields[0]?.options).toEqual(["mild", "moderate", "severe"]);

    const listed = await journal.kinds();
    expect(listed[0]?.suggestions.area).toEqual(["head", "neck"]);
  });
});
