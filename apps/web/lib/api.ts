export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STORAGE_KEY = "marlow.session";

export type StoredSession = { id: string; token: string };

export function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.id || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export async function api<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "The desk isn't reachable. Start the app and open it through the workplace port.");
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { error?: string }) : null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error || `Request failed (${response.status}).`);
  }
  return body as T;
}

export function formatSim(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function simParts(iso: string): { weekday: string; day: number; minutes: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: pick("weekday"),
    day: Number(pick("day")),
    minutes: Number(pick("hour")) * 60 + Number(pick("minute")),
  };
}

export function renderInline(text: string): { type: "text" | "code"; value: string }[] {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.filter(Boolean).map((part) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2
      ? { type: "code", value: part.slice(1, -1) }
      : { type: "text", value: part },
  );
}
