import { redactValue, type RedactOptions } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  service?: string;
  environment?: string;
  version?: string;
  redact?: RedactOptions;
  sink?: (line: string) => void;
}

export interface LogContext {
  traceId?: string;
  spanId?: string;
  organizationId?: string;
  workspaceId?: string;
  userId?: string;
  jobId?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Structured JSON logger.
 *
 * Every value passes through `redactValue`, so a careless `logger.info('user', user)`
 * cannot leak a password hash, a session token or a page of a customer's contract. The
 * bound context carries trace and tenant identifiers onto every line, which is what makes
 * a production incident traceable from a user-visible traceId back to the exact request.
 */
export class Logger {
  private readonly level: number;
  private readonly format: 'json' | 'pretty';
  private readonly base: Record<string, unknown>;
  private readonly redactOptions: RedactOptions;
  private readonly sink: (line: string) => void;

  constructor(
    private readonly options: LoggerOptions = {},
    private readonly context: LogContext = {},
  ) {
    this.level = LEVEL_ORDER[options.level ?? 'info'];
    this.format = options.format ?? 'json';
    this.redactOptions = options.redact ?? {};
    this.sink = options.sink ?? ((line) => globalThis.console.log(line));
    this.base = {
      service: options.service ?? 'uxe',
      env: options.environment ?? 'development',
      version: options.version ?? '1.0.0',
    };
  }

  /** Returns a logger that carries additional context on every subsequent line. */
  child(context: LogContext): Logger {
    return new Logger(this.options, { ...this.context, ...context });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const payload = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.base,
      ...this.context,
      ...(fields ? (redactValue(fields, this.redactOptions) as Record<string, unknown>) : {}),
    };

    if (this.format === 'pretty') {
      const { ts, msg, ...rest } = payload;
      this.sink(`${ts} ${level.toUpperCase().padEnd(5)} ${msg} ${JSON.stringify(rest)}`);
      return;
    }

    this.sink(JSON.stringify(payload));
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
