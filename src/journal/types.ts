import type { ObjectId } from "mongodb";

export const HEALTH_DB = "health";
export const KINDS_COLLECTION = "kinds";
export const OBSERVATIONS_COLLECTION = "observations";

export const FIELD_TYPES = ["number", "enum", "text", "boolean", "event"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const TEXT_SUGGESTION_LIMIT = 20;

export interface JournalField {
  id: string;
  label: string;
  type: FieldType;
  unit?: string;
  options?: string[];
}

export interface JournalKind {
  _id: ObjectId;
  label: string;
  nameKey: string;
  fields: JournalField[];
  createdAt: Date;
}

export type FieldValue = number | string | boolean;

export interface JournalFieldValue {
  fieldId: string;
  value: FieldValue;
}

export interface JournalObservation {
  _id: ObjectId;
  at: Date;
  kindId: ObjectId;
  values: JournalFieldValue[];
  createdAt: Date;
}

export interface JournalStore {
  insertKind(kind: Omit<JournalKind, "_id">): Promise<JournalKind>;
  saveFields(id: string, fields: JournalField[]): Promise<JournalKind | null>;
  findKind(id: string): Promise<JournalKind | null>;
  listKinds(): Promise<JournalKind[]>;
  deleteKind(id: string): Promise<boolean>;
  insertObservation(entry: Omit<JournalObservation, "_id">): Promise<JournalObservation>;
  findObservation(id: string): Promise<JournalObservation | null>;
  listObservations(from: Date, to: Date): Promise<JournalObservation[]>;
  listAllObservations(): Promise<JournalObservation[]>;
  deleteObservation(id: string): Promise<boolean>;
}
