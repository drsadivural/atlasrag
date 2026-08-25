import type { StreamEvent } from '@uxe/contracts';

export interface StreamHandlers {
  onStage?: (event: Extract<StreamEvent, { type: 'stage' }>) => void;
  onMessage?: (event: Extract<StreamEvent, { type: 'message' }>) => void;
  onJob?: (event: Extract<StreamEvent, { type: 'job' }>) => void;
  onError?: (event: Extract<StreamEvent, { type: 'error' }>) => void;
  onDone?: (event: Extract<StreamEvent, { type: 'done' }>) => void;
  /** Fired when the connection drops and a reconnect is scheduled. */
  onReconnecting?: (attempt: number) => void;
}

export interface StreamController {
  close: () => void;
}

/**
 * Subscribes to a consultation's SSE stream.
 *
 * The stream is treated as a live view over durable state, never as the only delivery
 * path: every event it carries is already persisted, so a dropped connection reconnects
 * with backoff and the caller re-reads the consultation. That is what makes refreshing
 * mid-generation safe.
 */
export function subscribeToConsultation(
  consultationId: string,
  handlers: StreamHandlers,
): StreamController {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;

    source = new EventSource(`/api/v1/consultations/${consultationId}/stream`, {
      withCredentials: true,
    });

    const parse = (raw: string): StreamEvent | null => {
      try {
        return JSON.parse(raw) as StreamEvent;
      } catch {
        return null;
      }
    };

    source.addEventListener('stage', (event) => {
      const parsed = parse((event as MessageEvent<string>).data);
      if (parsed?.type === 'stage') handlers.onStage?.(parsed);
    });

    source.addEventListener('message', (event) => {
      const parsed = parse((event as MessageEvent<string>).data);
      if (parsed?.type === 'message') handlers.onMessage?.(parsed);
    });

    source.addEventListener('job', (event) => {
      const parsed = parse((event as MessageEvent<string>).data);
      if (parsed?.type === 'job') handlers.onJob?.(parsed);
    });

    source.addEventListener('error', (event) => {
      const data = (event as MessageEvent<string>).data;
      if (data) {
        const parsed = parse(data);
        if (parsed?.type === 'error') {
          handlers.onError?.(parsed);
          return;
        }
      }

      // No payload means a transport failure. Reconnect with capped exponential backoff
      // rather than hammering a server that may be restarting.
      source?.close();
      if (closed) return;
      attempt += 1;
      handlers.onReconnecting?.(attempt);
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
      reconnectTimer = setTimeout(connect, delay);
    });

    source.addEventListener('done', (event) => {
      const parsed = parse((event as MessageEvent<string>).data);
      if (parsed?.type === 'done') handlers.onDone?.(parsed);
      closed = true;
      source?.close();
    });

    source.addEventListener('open', () => {
      attempt = 0;
    });
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    },
  };
}
