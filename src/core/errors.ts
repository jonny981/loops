/**
 * Structured, classified errors so the exit report can say *what* failed,
 * *where* in the loop tree, and *why* — instead of dumping a stack.
 */

export type LoopErrorCode =
  | 'ENGINE' // the backend (SDK/CLI/API) threw or returned an error
  | 'TIMEOUT' // a step exceeded its time budget
  | 'ABORTED' // an early-exit signal interrupted the work
  | 'VALIDATION' // a condition/validator could not produce a verdict
  | 'CONFIG' // the loop definition or CLI input was invalid
  | 'BODY' // the step body threw
  | 'UNKNOWN';

export type LoopPhase = 'start' | 'body' | 'until' | 'stopOn' | 'review' | 'engine';

export interface LoopErrorInit {
  code: LoopErrorCode;
  message: string;
  phase?: LoopPhase;
  path?: readonly string[];
  iteration?: number;
  cause?: unknown;
  retryable?: boolean;
}

export class LoopError extends Error {
  readonly code: LoopErrorCode;
  readonly phase?: LoopPhase;
  readonly path?: readonly string[];
  readonly iteration?: number;
  readonly retryable: boolean;

  constructor(init: LoopErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'LoopError';
    this.code = init.code;
    this.phase = init.phase;
    this.path = init.path;
    this.iteration = init.iteration;
    this.retryable = init.retryable ?? (init.code === 'ENGINE' || init.code === 'TIMEOUT');
  }

  /** Wrap an arbitrary thrown value, preserving a `LoopError` as-is. */
  static from(value: unknown, fallback: Omit<LoopErrorInit, 'message' | 'cause'>): LoopError {
    if (value instanceof LoopError) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new LoopError({ ...fallback, message, cause: value });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      path: this.path,
      iteration: this.iteration,
      retryable: this.retryable,
    };
  }
}
