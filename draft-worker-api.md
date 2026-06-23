# anon-rpc Worker API Draft

The sandboxed WebWorker (inside null origin iframe) communicates with the wallet via messaging.

However, it's easier to wrap this messaging in an API and make that the standard instead of the messages. This should make it easier to write the standard and also easier to use it:

```ts
// before

addEventListener('message', ev => {
  if (ev.data.type === 'fetch') {
    const response = await anonymousFetch(
      ev.data.url,
      ev.data.requestInit,
    );
  
    postMessage({
      type: 'fetch-result',
      response,
    });
  }
});
```

```ts
// after

while (true) {
  const call = await anonRpc.acceptCall();

  switch (call.kind) {
    case 'fetch':
      call.respond(anonymousFetch(call.url, call.requestInit));
      break;
  }
}
```

This API will include some important capabilities too:

- `kps`: key-pinned secure stream transport
- `storage`: async persistent byte storage
- `log`: console-like api so wallets can see/control what happens with logs

By including `kps`, we remove the temptation to place the network client in an iframe so it can have full WebRTC access. This would unnecessarily lock the implementation to the web. `kps` server listeners will support both WebRTC and QUIC clients, so a non-web environment can simply use QUIC, and the network client does not know or care which one is being used.

## Type definitions

```ts
export interface AnonRpcWorkerApi {
  acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall>
  readonly kps: KpsApi
  readonly storage: StorageApi
  readonly log: LogApi
}

/**
 * A call made by the wallet/host into the worker. Discriminated by `kind` so
 * new call kinds can be added without growing the accept surface.
 */
export type IncomingCall =
  | FetchCall
// future call kinds are added here

export interface FetchCall {
  readonly kind: "fetch"

  /**
   * The request URL. Separated from `requestInit` to mirror `fetch(url, init)`.
   */
  readonly url: string

  /**
   * The rest of the request. Shaped like a DOM `RequestInit` but portable
   * across non-web harnesses (`HeaderList` headers, `ByteBody` body), and
   * carries the cancellation `signal` like `fetch(url, init)` does.
   */
  readonly requestInit?: AnonRequestInit

  /**
   * Deliver the response exactly once. A rejected promise fails the call.
   */
  respond(response: AnonFetchResponse | Promise<AnonFetchResponse>): void
}

/**
 * An ordered list of header name/value pairs.
 * Order and duplicates are preserved.
 */
export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>

/**
 * A request or response body.
 *
 * Either a complete byte buffer, or a stream of byte chunks for large or
 * incremental transfers. Streaming bodies use the same
 * `ReadableStream<Uint8Array>` shape as `KpsStream.readable`: they are
 * single-consumption, apply normal backpressure, and error if the underlying
 * transfer fails or the call is aborted via the request's `signal`.
 */
export type ByteBody = Uint8Array | ReadableStream<Uint8Array>

export interface AnonRequestInit {
  /** HTTP method. Defaults to "GET". */
  readonly method?: string

  /** Request headers. */
  readonly headers?: HeaderList

  /**
   * Request body, or undefined for bodyless methods. A streaming body is read
   * by the worker as it performs the request.
   */
  readonly body?: ByteBody

  /**
   * Redirect handling. "follow" resolves to the final response; "manual"
   * returns the redirect response as-is; "error" fails the call on a redirect.
   * Defaults to "follow".
   */
  readonly redirect?: "follow" | "manual" | "error"

  /**
   * Aborted when the wallet cancels this in-flight call, like `fetch`'s
   * `signal`. A call is only cancellable when the wallet supplies one.
   */
  readonly signal?: AbortSignal
}

export interface AnonFetchResponse {
  /** HTTP status code. */
  readonly status: number

  /** Response headers. */
  readonly headers: HeaderList

  /**
   * Response body. May be a streaming body that the wallet drains as bytes
   * arrive; the call is not complete until the body is fully read or errors.
   * Empty (zero-length) for bodyless responses.
   */
  readonly body: ByteBody

  /** Final URL after any followed redirects (useful when redirect was "follow"). */
  readonly url?: string
}

/* KPS */

export type KpsAddr = string

export interface KpsApi {
  /**
   * Open a secure multiplexed KPS connection to a pinned KPS address.
   */
  dial(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsConn>

  /**
   * Convenience wrapper for:
   *
   *   const conn = await kps.dial(addr)
   *   const stream = await conn.openStream()
   *
   * The returned stream owns the hidden connection. Closing the stream should
   * also close the hidden connection.
   */
  openStream(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsStream>
}

export interface KpsDialOptions {
  signal?: AbortSignal
}

export interface KpsConn {
  /**
   * Open a new unnamed reliable bidirectional byte stream inside this connection.
   */
  openStream(opts?: KpsOpenStreamOptions): Promise<KpsStream>

  /**
   * Accept a stream opened by the server.
   */
  acceptStream(opts?: { signal?: AbortSignal }): Promise<KpsStream>

  /**
   * Close the whole connection.
   *
   * This invalidates all streams associated with it.
   */
  close(reason?: KpsReason): Promise<void>

  /**
   * Connection-level unreliable datagrams.
   *
   * Always present: every connection supports datagrams, so worker code does
   * not need to feature-detect. Datagrams are separate from streams —
   * unreliable, unordered, message-oriented, and size-limited.
   */
  readonly datagrams: KpsDatagrams

  /**
   * Resolves when the connection is closed by either side or fails.
   */
  readonly closed: Promise<KpsConnCloseInfo>
}

export interface KpsOpenStreamOptions {
  signal?: AbortSignal
}

export interface KpsStream {
  /**
   * Reliable ordered inbound bytes.
   *
   * No message boundaries are preserved.
   */
  readonly readable: ReadableStream<Uint8Array>

  /**
   * Reliable ordered outbound bytes.
   *
   * Backpressure should be represented through normal WritableStream backpressure.
   */
  readonly writable: WritableStream<Uint8Array>

  /**
   * Gracefully finish the local write half.
   *
   * The peer should eventually observe EOF after all previously written bytes.
   */
  closeWrite(): Promise<void>

  /**
   * Cancel the local read half.
   *
   * This means the worker no longer wants inbound bytes on this stream.
   * It is not graceful EOF. Where supported, the peer should be told to stop
   * sending.
   */
  cancelRead(reason?: KpsReason): Promise<void>

  /**
   * Abort the local write half.
   *
   * The peer should observe a stream error rather than EOF. Previously buffered
   * bytes may or may not be delivered.
   */
  resetWrite(reason?: KpsReason): Promise<void>

  /**
   * Close or abort the whole stream.
   *
   * This performs cleanup of both halves using the best available transport
   * semantics.
   */
  close(reason?: KpsReason): Promise<void>

  /**
   * Resolves when the stream is closed, reset, cancelled, or otherwise failed.
   */
  readonly closed: Promise<KpsStreamCloseInfo>
}

export type KpsErrorCode =
  | "cancelled"
  | "closed"
  | "reset"
  | "timeout"
  | "network-error"
  | "protocol-error"
  | "unsupported"
  | "too-large"
  | "queue-full"
  | "permission-denied"
  | "internal-error"

/**
 * A close/reset reason. The same shape is used for connection close, stream
 * close, `cancelRead`, and `resetWrite`; the meaning is given by the operation
 * and by `code`.
 */
export interface KpsReason {
  code?: KpsErrorCode
  message?: string
}

export interface KpsConnCloseInfo {
  ok: boolean
  reason?: KpsReason
}

export interface KpsStreamCloseInfo {
  ok: boolean
  reason?: KpsReason
}

export interface KpsDatagrams {
  /** Maximum payload size currently allowed for one datagram. May be conservative; larger sends must fail. */
  readonly maxSize: number

  /**
   * Send one unreliable unordered message. The promise resolving means the
   * harness accepted it for best-effort sending, not that the peer received it.
   */
  send(data: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>

  /**
   * Inbound datagrams. Because datagrams arrive unsolicited, delivery must be
   * defined against a bounded buffer (for example, drop-oldest when full)
   * rather than a single racing receive call.
   */
  readonly incoming: ReadableStream<Uint8Array>
}

/* Storage */

/**
 * Storage keys are plain strings. Workers that want hierarchy can adopt a
 * delimiter convention such as "/" and use it with the `prefix` option on
 * `list` and `clear`; the delimiter has no special meaning to the harness.
 */
export type StorageKey = string

export interface StorageApi {
  /**
   * Get a value by key.
   *
   * Returns undefined if the key does not exist.
   */
  get(key: StorageKey, opts?: StorageReadOptions): Promise<Uint8Array | undefined>

  /**
   * Set or replace a value.
   */
  set(key: StorageKey, value: Uint8Array, opts?: StorageWriteOptions): Promise<void>

  /**
   * Delete a key.
   */
  delete(key: StorageKey, opts?: StorageWriteOptions): Promise<void>

  /**
   * Check whether a key exists.
   */
  has(key: StorageKey, opts?: StorageReadOptions): Promise<boolean>

  /**
   * List keys with an optional prefix.
   *
   * This is async iterable so implementations can page internally.
   */
  list(opts?: StorageListOptions): AsyncIterable<StorageKey>

  /**
   * Clear keys in the worker's storage namespace.
   *
   * If prefix is provided, only matching keys are cleared.
   */
  clear(opts?: StorageClearOptions): Promise<void>
}

export interface StorageReadOptions {
  signal?: AbortSignal
}

export interface StorageWriteOptions {
  signal?: AbortSignal
}

export interface StorageListOptions {
  prefix?: string
  signal?: AbortSignal
}

export interface StorageClearOptions {
  prefix?: string
  signal?: AbortSignal
}

/* Logging */

export interface LogApi {
  debug(...args: LogArg[]): void
  log(...args: LogArg[]): void
  info(...args: LogArg[]): void
  warn(...args: LogArg[]): void
  error(...args: LogArg[]): void

  /**
   * Optional console-like grouping helpers.
   */
  group?(...args: LogArg[]): void
  groupCollapsed?(...args: LogArg[]): void
  groupEnd?(): void
}

export type LogArg =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | readonly LogArg[]
  | { readonly [key: string]: LogArg }
```
