import { describe, expect, it } from "vitest";
import { JournalNotFoundError, JournalValidationError } from "./errors.js";
import type { JournalField } from "./types.js";
import { defineFields, validateValues, withAppendedOptions } from "./validate.js";

function fieldsOf(inputs: unknown, existing?: JournalField[]): JournalField[] {
  return defineFields(inputs, existing);
}

describe("journal fields", () => {
  it("defines a number field with its unit kept separate", () => {
    const [weight] = fieldsOf([{ label: " Weight ", type: "number", unit: " lb " }]);
    expect(weight).toEqual({ id: "weight", label: "Weight", type: "number", unit: "lb" });
  });

  it("defines blood pressure as two number fields on one kind", () => {
    const fields = fieldsOf([
      { label: "Systolic", type: "number", unit: "mmHg" },
      { label: "Diastolic", type: "number", unit: "mmHg" },
    ]);
    expect(fields.map((field) => [field.id, field.unit])).toEqual([
      ["systolic", "mmHg"],
      ["diastolic", "mmHg"],
    ]);
  });

  it("keeps choice order and rejects duplicates", () => {
    const [severity] = fieldsOf([{ label: "Severity", type: "enum", options: [" mild ", "moderate", "severe"] }]);
    expect(severity?.options).toEqual(["mild", "moderate", "severe"]);
    expect(() => fieldsOf([{ label: "Severity", type: "enum", options: ["Mild", "mild"] }])).toThrow(JournalValidationError);
  });

  it("requires a unit, two choices, and a unique field name", () => {
    expect(() => fieldsOf([{ label: "Weight", type: "number" }])).toThrow(/unit/i);
    expect(() => fieldsOf([{ label: "Severity", type: "enum", options: ["mild"] }])).toThrow(/two choices/i);
    expect(() => fieldsOf([{ label: "Pain", type: "text" }, { label: " pain ", type: "text" }])).toThrow(/same name/i);
    expect(() => fieldsOf([])).toThrow(/at least one field/i);
  });

  it("appends a field without reusing an id", () => {
    const existing = fieldsOf([{ label: "Area", type: "text" }]);
    const [again] = fieldsOf([{ label: "Area 2", type: "text" }], existing);
    const [collision] = fieldsOf([{ label: "Area", type: "text" }], [{ id: "area", label: "Place", type: "text" }]);
    expect(again?.id).toBe("area-2");
    expect(collision?.id).toBe("area-2");
  });

  it("appends choices after the ones already there", () => {
    const [severity] = fieldsOf([{ label: "Severity", type: "enum", options: ["mild", "moderate"] }]);
    const updated = withAppendedOptions(severity ? [severity] : [], [{ fieldId: "severity", options: ["severe"] }]);
    expect(updated[0]?.options).toEqual(["mild", "moderate", "severe"]);
    expect(() => withAppendedOptions(updated, [{ fieldId: "missing", options: ["x", "y"] }])).toThrow(JournalNotFoundError);
  });
});

describe("journal values", () => {
  const weight = fieldsOf([{ label: "Weight", type: "number", unit: "lb" }]);
  const migraine = fieldsOf([
    { label: "Severity", type: "enum", options: ["mild", "moderate", "severe"] },
    { label: "Course", type: "enum", options: ["started", "gone"] },
  ]);
  const nurtec = fieldsOf([{ label: "Taken", type: "event" }]);
  const fasting = fieldsOf([{ label: "Fasting", type: "boolean" }]);
  const pain = fieldsOf([
    { label: "Severity", type: "enum", options: ["mild", "moderate", "severe"] },
    { label: "Area", type: "text" },
  ]);

  it("accepts the sample entries", () => {
    expect(validateValues(weight, [{ fieldId: "Weight", value: 315 }])).toEqual([{ fieldId: "weight", value: 315 }]);
    expect(validateValues(migraine, [{ fieldId: "course", value: "gone" }])).toEqual([{ fieldId: "course", value: "gone" }]);
    expect(validateValues(pain, [{ fieldId: "severity", value: "moderate" }, { fieldId: "area", value: " neck " }])).toEqual([
      { fieldId: "severity", value: "moderate" },
      { fieldId: "area", value: "neck" },
    ]);
    expect(validateValues(nurtec, [{ fieldId: "taken", value: true }])).toEqual([{ fieldId: "taken", value: true }]);
    expect(validateValues(fasting, [{ fieldId: "fasting", value: false }])).toEqual([{ fieldId: "fasting", value: false }]);
  });

  it("rejects empty, mistyped, and unknown values", () => {
    expect(() => validateValues(weight, [])).toThrow(/at least one/i);
    expect(() => validateValues(weight, [{ fieldId: "weight", value: Number.NaN }])).toThrow(/number/i);
    expect(() => validateValues(migraine, [{ fieldId: "severity", value: "awful" }])).toThrow(/choices/i);
    expect(() => validateValues(nurtec, [{ fieldId: "taken", value: false }])).toThrow(/happened/i);
    expect(() => validateValues(weight, [{ fieldId: "nope", value: 1 }])).toThrow(/isn't on this kind/i);
    expect(() => validateValues(weight, [{ fieldId: "weight", value: 1 }, { fieldId: "weight", value: 2 }])).toThrow(/twice/i);
  });
});
