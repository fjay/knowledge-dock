export class OrchestratorError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number = 400) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.status = status;
  }
}
