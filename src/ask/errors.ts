export class AskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskConfigError";
  }
}

export class AskFailedError extends Error {
  constructor(message = "Couldn't answer that. Try again in a moment.", options?: ErrorOptions) {
    super(message, options);
    this.name = "AskFailedError";
  }
}
