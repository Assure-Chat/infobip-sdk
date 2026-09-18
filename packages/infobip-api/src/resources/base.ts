import type { HttpClient } from '../http.js';

/** Options every resource method accepts. */
export interface RequestOverrides {
  /** Abort the request from the caller's side. */
  signal?: AbortSignal | undefined;
  /** Override the client-level timeout for this call. */
  timeoutMs?: number | undefined;
  /** Extra headers for this call. */
  headers?: Record<string, string> | undefined;
}

/** @internal */
export abstract class Resource {
  protected readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }
}
