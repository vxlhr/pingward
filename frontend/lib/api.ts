import type {
  HealthInfo,
  Incident,
  MonitorEdit,
  MonitorSummary,
  NewMonitor,
  Ping,
  Settings,
  SettingsInfo,
  StatsPoint,
  StatsRange,
  StatusPage,
  TelegramInfo,
  TestAlertResult,
} from "@pingward/shared";

export type {
  AlertChannel,
  HealthInfo,
  Incident,
  MonitorEdit,
  MonitorStatus,
  NewMonitor,
  Ping,
  Plan,
  Settings,
  SettingsInfo,
  StatsPoint,
  StatsRange,
  StatusPage,
  TelegramInfo,
  TestAlertResult,
} from "@pingward/shared";
/** What the dashboard works with: the read-endpoint shape (no alert destinations). */
export type Monitor = MonitorSummary;

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const TOKEN_KEY = "pingward.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: ignore */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Parsed JSON error body, when the API sent one. */
    public body: unknown = null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const msg = res.status === 401 ? "Unauthorized: an API token is required or the token is wrong" : body?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

export const api = {
  health: () => request<HealthInfo>("/api/health"),
  listMonitors: () => request<Monitor[]>("/api/monitors"),
  getPings: (id: number, limit = 50) => request<Ping[]>(`/api/monitors/${id}/pings?limit=${limit}`),
  createMonitor: (data: NewMonitor) =>
    request<Monitor>("/api/monitors", { method: "POST", body: JSON.stringify(data) }),
  setPaused: (id: number, paused: boolean) =>
    request<Monitor>(`/api/monitors/${id}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  editMonitor: (id: number, edit: MonitorEdit) =>
    request<Monitor>(`/api/monitors/${id}`, { method: "PATCH", body: JSON.stringify(edit) }),
  /** 0 ends the maintenance window. */
  setMaintenance: (id: number, minutes: number) =>
    request<Monitor>(`/api/monitors/${id}`, { method: "PATCH", body: JSON.stringify({ maintenance_minutes: minutes }) }),
  getStats: (id: number, range: StatsRange) => request<StatsPoint[]>(`/api/monitors/${id}/stats?range=${range}`),
  getStatus: () => request<StatusPage>("/api/status"),
  /** Per-channel results; a 502 (some channel failed) still carries them, so it isn't thrown. */
  testAlert: (id: number) =>
    request<TestAlertResult>(`/api/monitors/${id}/test-alert`, { method: "POST" }).catch((e: unknown) => {
      const body = e instanceof ApiError ? (e.body as Partial<TestAlertResult> | null) : null;
      if (body?.results) return body as TestAlertResult;
      throw e;
    }),
  getTelegram: () => request<TelegramInfo>("/api/telegram"),
  getIncidents: (id: number, limit = 20) => request<Incident[]>(`/api/monitors/${id}/incidents?limit=${limit}`),
  deleteMonitor: (id: number) => request<null>(`/api/monitors/${id}`, { method: "DELETE" }),
  getSettings: () => request<SettingsInfo>("/api/settings"),
  updateSettings: (patch: Partial<Settings>) =>
    request<SettingsInfo>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};

/** "3h 12m", "45m", "20s" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function timeAgo(ts: number | null, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
