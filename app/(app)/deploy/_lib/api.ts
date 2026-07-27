// Typed client for /api/native/* (cookie-authenticated — the web PWA path). The
// native iOS client will mirror these calls with a bearer token (Phase A2/C);
// the wire contract is identical (lib/deploy/contract.ts).
//
// Error model the sync engine depends on:
//   - NetworkError  → the request never reached the server (offline). Stop
//     draining and retry the whole queue on reconnect.
//   - ApiHttpError  → the server answered with a non-2xx. `status` decides
//     whether it's permanent (4xx → dead-letter) or transient (429/5xx → retry).

import { isPermanentStatus } from "@/lib/offline/http-classification";

import type {
  BootstrapResponse,
  ChangesResponse,
  ClaimRequest,
  ClaimResponse,
  CrewView,
  DeployRequest,
  DeployResponse,
  PhotoUploadResponse,
  ReleaseRequest,
  ReleaseResponse,
} from "@/lib/deploy/contract";

export class NetworkError extends Error {}

export class ApiHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  // 4xx (except 429 and 401) means the request is malformed/forbidden and will
  // never succeed on replay — move it to the dead-letter. 429/5xx are worth
  // retrying. 401 is auth-expiry: handled separately as a re-auth prompt (the
  // queued work CAN succeed once the user signs back in), so it's not permanent.
  get permanent(): boolean {
    return isPermanentStatus(this.status);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
    });
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

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getBootstrap(): Promise<BootstrapResponse> {
  return request<BootstrapResponse>("/api/native/sync/bootstrap");
}

export function getChanges(since: string): Promise<ChangesResponse> {
  return request<ChangesResponse>(
    `/api/native/sync/changes?since=${encodeURIComponent(since)}`,
  );
}

export function createCrew(name: string): Promise<CrewView> {
  return postJson<CrewView>("/api/native/crews", { name });
}

export function joinCrew(crewId: number): Promise<CrewView> {
  return postJson<CrewView>(`/api/native/crews/${crewId}/join`, {});
}

export function leaveCrew(crewId: number): Promise<void> {
  return postJson<void>(`/api/native/crews/${crewId}/leave`, {});
}

export function postClaim(req: ClaimRequest): Promise<ClaimResponse> {
  return postJson<ClaimResponse>("/api/native/claims", req);
}

export function postRelease(req: ReleaseRequest): Promise<ReleaseResponse> {
  return postJson<ReleaseResponse>("/api/native/claims/release", req);
}

export function postDeploy(req: DeployRequest): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/native/deploys", req);
}

// Raw image bytes as the POST body — the server sniffs the type (see the photo
// route). Returns the gated serving URL.
export function postPhoto(
  deployClientId: string,
  blob: Blob,
): Promise<PhotoUploadResponse> {
  return request<PhotoUploadResponse>(
    `/api/native/deploys/${encodeURIComponent(deployClientId)}/photo`,
    { method: "POST", body: blob },
  );
}
