import { invoke } from "@tauri-apps/api/core";

export interface AppErrorShape {
  code?: string;
  message?: string;
}

export class ApiError extends Error {
  code: string;
  constructor(error: unknown) {
    const shape = (error ?? {}) as AppErrorShape;
    super(shape.message || (typeof error === "string" ? error : "操作失败"));
    this.code = shape.code || "UNKNOWN";
    this.name = "ApiError";
  }
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(command, args)) as T;
  } catch (error) {
    throw new ApiError(error);
  }
}

export interface Fingerprint {
  host: string;
  port: number;
  algorithm: string;
  value: string;
  changed: boolean;
}

export interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  name?: string;
}

export interface ConnectionInfo {
  id: string;
  host: string;
  port: number;
  username: string;
  name: string;
  label: string;
  connectedAt: string;
}

export interface RemoteFile {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "shortcut";
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modified: number;
}

export interface ScreenSession {
  name: string;
  label: string;
  path: string;
  startedAt: string;
}

export interface ToolStatus {
  tools: Record<string, boolean>;
  missing: string[];
  packageManager: string;
  requiresSudo: boolean;
  canInstall: boolean;
  installCommand?: string;
}

export interface FileJob {
  jobId: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  total: number;
  percent: number;
  error?: string;
}

export interface Metrics {
  cpu?: number;
  memory?: number;
  memoryTotal?: number;
  memoryUsed?: number;
  memoryAvailable?: number;
  swap?: number;
  swapTotal?: number;
  swapUsed?: number;
  disk?: number;
  diskTotal?: number;
  diskUsed?: number;
  diskAvailable?: number;
  load?: string;
  download?: number;
  upload?: number;
  uptime?: number;
  cpuModel?: string;
  cpuCores?: number;
  hostname?: string;
  kernel?: string;
  processes?: number;
  collectedAt?: string;
}

export const ssh = {
  test: (profile: ConnectionProfile) =>
    call<{ ok: boolean; message: string; fingerprint: Fingerprint }>("ssh_test", { profile }),
  connect: (profile: ConnectionProfile) =>
    call<{ connection: ConnectionInfo; fingerprint: Fingerprint }>("ssh_connect", { profile }),
  disconnect: (id: string) => call<{ status: string }>("ssh_disconnect", { id }),
  list: () => call<{ connections: ConnectionInfo[] }>("ssh_list"),
  status: (id: string) => call<{ connected: boolean; connection: ConnectionInfo }>("ssh_status", { id }),
  time: (id: string) => call<{ time: number }>("ssh_time", { id }),
  metrics: (id: string) => call<Metrics>("ssh_metrics", { id }),
  reboot: (id: string) => call<{ status: string }>("ssh_reboot", { id }),
  exec: (id: string, command: string) => call<{ exitCode: number; output: string }>("ssh_exec", { id, command }),
};

export const terminal = {
  open: (id: string, termId: string, screenName?: string, cols?: number, rows?: number) =>
    call<{ termId: string }>("term_open", { id, termId, screenName: screenName ?? null, cols, rows }),
  attachScreen: (id: string, termId: string, name: string) =>
    call<{ termId: string }>("terminal_screen_attach", { id, termId, name }),
  input: (termId: string, data: string) => call<void>("term_input", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("term_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("term_close", { termId }),
};

export const files = {
  list: (id: string, path: string) => call<{ path: string; files: RemoteFile[] }>("files_list", { id, path }),
  read: (id: string, path: string) => call<{ path: string; content: string; size: number }>("files_read", { id, path }),
  write: (id: string, path: string, content: string) => call<{ ok: boolean }>("files_write", { id, path, content }),
  desktop: (id: string) =>
    call<{ home: string; dir: string; files: RemoteFile[] }>("desktop_list", { id }),
  download: (id: string, path: string, remotePath: string) =>
    call<{ ok: boolean; size: number }>("files_download", { id, path, remotePath }),
  upload: (id: string, localPaths: string[], remoteDir: string) =>
    call<{ files: { path: string; size: number }[] }>("files_upload", { id, localPaths, remoteDir }),
  operation: (id: string, payload: Record<string, unknown>) =>
    call<Record<string, unknown>>("files_operation", { id, ...payload }),
};

export const screen = {
  list: (id: string) => call<{ sessions: ScreenSession[] }>("screen_list", { id }),
  create: (id: string, request: Record<string, unknown>) =>
    call<ScreenSession & { status?: string }>("screen_create", { id, request }),
};

export const tools = {
  inspect: (id: string, list?: string[]) => call<ToolStatus>("tools_inspect", { id, tools: list ?? null }),
  install: (id: string, list: string[]) => call<ToolStatus>("tools_install", { id, tools: list }),
};

export const jobs = {
  get: (jobId: string) => call<FileJob>("file_job", { jobId }),
};
