export class KnowledgeInboxError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number = 400) {
    super(message);
    this.name = "KnowledgeInboxError";
    this.code = code;
    this.status = status;
  }
}
