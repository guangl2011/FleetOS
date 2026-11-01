/** Typed error for world-model contract violations — code-first, never stringly. */
export class WorldModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorldModelError";
    this.code = code;
  }
}
