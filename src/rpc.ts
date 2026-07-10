/** Minimal JSON-RPC 2.0 client shared by the EVM, Solana, and Tron adapters. */

let idCounter = 1;

export type RpcHeaders = Record<string, string>;

export async function rpcCall<T = unknown>(
  url: string,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch = fetch,
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

export interface BatchItem {
  method: string;
  params: unknown[];
}

export interface BatchResult<T = unknown> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Standard JSON-RPC 2.0 batch: send many calls in ONE HTTP request and get the
 * results back in input order. This is the practical "multicall" for chains
 * without a Multicall3 contract (e.g. Tron) — it collapses N requests into one,
 * which directly cuts rate-limit (429) pressure.
 */
export async function rpcBatch<T = unknown>(
  url: string,
  calls: BatchItem[],
  fetchFn: typeof fetch = fetch,
  headers?: RpcHeaders,
): Promise<Array<BatchResult<T>>> {
  if (calls.length === 0) return [];

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
