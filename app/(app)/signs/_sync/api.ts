// Typed client for POST /api/native/sign-status (cookie-authenticated — the web
// path). A focused copy of the deploy tool's api.ts error model, scoped to the
// one call this queue makes:
//   - NetworkError  → the request never reached the server (offline). Stop
//     draining; retry the whole queue on reconnect.
//   - ApiHttpError  → the server answered non-2xx. `status` decides permanent
//     (4xx → dead-letter) vs transient (429/5xx/401 → retry).

import type {
  SetSignStatusInput,
  SetSignStatusResponse,
} from "@/lib/deploy/contract";

export class NetworkError extends Error {}

export class ApiHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  // 4xx (except 429 and 401) is malformed/forbidden and will never succeed on
  // replay → dead-letter. 429/5xx are worth retrying. 401 is auth-expiry: the
  // queued change CAN succeed once the user signs back in, so not permanent.
  get permanent(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 429 &&
      this.status !== 401
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    // fetch only rejects on a network-layer failure (offline, DNS, CORS).
    throw new NetworkError(`request to ${path} failed`);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiHttpError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// The outbox entry serialized to the wire shape. `changedAt` is an ISO string
// in the entry; setSignStatusSchema's z.coerce.date() accepts it.
export function postSignStatus(
  body: SetSignStatusInput,
): Promise<SetSignStatusResponse> {
  return request<SetSignStatusResponse>("/api/native/sign-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
