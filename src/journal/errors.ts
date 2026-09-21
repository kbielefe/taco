export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class JournalValidationError extends JournalError {}

export class JournalConflictError extends JournalError {}

export class JournalNotFoundError extends JournalError {}

export class JournalConfigError extends JournalError {}
