/** Minimal JSON-RPC 2.0 client shared by the EVM, Solana, and Tron adapters. */

let idCounter = 1;

export type RpcHeaders = Record<string, string>;

/**
 * One or more RPC endpoints for a chain. When an array is given the client
 * load-balances across them and fails over to the next URL if a request errors,
 * only surfacing an error once every endpoint has failed.
 */
export type RpcEndpoint = string | string[];

/** Rotating cursor so successive calls spread across a multi-URL endpoint. */
let rrCounter = 0;

/**
 * Normalize an endpoint into a non-empty list of URLs to try, in order. For a
 * multi-URL endpoint the starting point rotates each call (round-robin) so load
 * is spread; the remaining URLs act as failover targets.
 */
function orderedUrls(endpoint: RpcEndpoint): string[] {
  const urls = (Array.isArray(endpoint) ? endpoint : [endpoint]).filter(Boolean);
  if (urls.length <= 1) return urls;
  const start = rrCounter++ % urls.length;
  return [...urls.slice(start), ...urls.slice(0, start)];
}

/**
 * Run `attempt` against each URL in turn, returning the first success. Throws
 * the last error only after every URL has failed.
 */
async function withFailover<T>(
  endpoint: RpcEndpoint,
  label: string,
  attempt: (url: string) => Promise<T>,
): Promise<T> {
  const urls = orderedUrls(endpoint);
  if (urls.length === 0) {
    throw new Error(`[deposit-watch] RPC ${label}: no RPC URL configured`);
  }
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return await attempt(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function rpcCallOnce<T>(
  url: string,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: idCounter++,
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`[deposit-watch] RPC ${method} → HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`[deposit-watch] RPC ${method} error ${json.error.code}: ${json.error.message}`);
  }
  return json.result as T;
}

export async function rpcCall<T = unknown>(
  url: RpcEndpoint,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch = fetch,
  headers?: RpcHeaders,
): Promise<T> {
  return withFailover(url, method, (u) => rpcCallOnce<T>(u, method, params, fetchFn, headers));
}

export interface BatchItem {
  method: string;
  params: unknown[];
}

export interface BatchResult<T = unknown> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpcBatchOnce<T>(
  url: string,
  calls: BatchItem[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<Array<BatchResult<T>>> {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`[deposit-watch] RPC batch → HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (!Array.isArray(json)) {
    // Provider rejected the batch (or errored the whole payload).
    const msg = json?.error?.message ?? "batch not supported";
    throw new Error(`[deposit-watch] RPC batch failed: ${msg}`);
  }

  const out = new Array<BatchResult<T>>(calls.length);
  for (const item of json as Array<{ id: number; result?: T; error?: BatchResult["error"] }>) {
    if (typeof item.id === "number" && item.id >= 0 && item.id < calls.length) {
      out[item.id] = { result: item.result, error: item.error };
    }
  }
  return out;
}

/**
 * Send many JSON-RPC calls in one HTTP request and restore input order.
 * Providers may count each enclosed call separately for billing and rate limits.
 */
export async function rpcBatch<T = unknown>(
  url: RpcEndpoint,
  calls: BatchItem[],
  fetchFn: typeof fetch = fetch,
  headers?: RpcHeaders,
): Promise<Array<BatchResult<T>>> {
  if (calls.length === 0) return [];
  return withFailover(url, "batch", (u) => rpcBatchOnce<T>(u, calls, fetchFn, headers));
}
