export class FoodLogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
  }
}

export class FoodLogConfigError extends FoodLogError {}

export class FoodLogAiError extends FoodLogError {}

export class FoodLogMatchError extends FoodLogError {
  readonly query: string;
  readonly candidates: string[];

  constructor(message: string, options?: { query?: string; candidates?: string[]; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.query = options?.query ?? "";
    this.candidates = options?.candidates ?? [];
  }
}
