import { create } from "./tiny-store";
import type { ConnectionInfo } from "./api";

export type ThemeMode = "system" | "light" | "dark";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
  save: boolean;
}

export interface Settings {
  theme: ThemeMode;
  font: number;
  confirm: boolean;
  saveCredential: boolean;
  autoOpenTerminal: boolean;
  reconnect: boolean;
  screenAutoExit: boolean;
  showWelcome: boolean;
}

export interface HistoryEntry {
  time: string;
  type: string;
  value: string;
}

const SETTINGS_KEY = "taurissh.settings";
const CONNECTIONS_KEY = "taurissh.connections";
const HISTORY_KEY = "taurissh.history";

export const defaultSettings: Settings = {
  theme: "system",
  font: 14,
  confirm: true,
  saveCredential: true,
  autoOpenTerminal: true,
  reconnect: true,
  screenAutoExit: true,
  showWelcome: true,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略存储异常 */
  }
}

export function loadSettings(): Settings {
  return { ...defaultSettings, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(settings: Settings) {
  writeJson(SETTINGS_KEY, settings);
}

export function loadConnections(): SavedConnection[] {
  const list = readJson<SavedConnection[]>(CONNECTIONS_KEY, []);
  return list.filter(
    (item) =>
      item &&
      typeof item.host === "string" &&
      typeof item.username === "string" &&
      item.port >= 1 &&
      item.port <= 65535,
  );
}

export function saveConnections(list: SavedConnection[]) {
  writeJson(CONNECTIONS_KEY, list);
}

export function loadHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(HISTORY_KEY, []);
}

export function saveHistory(list: HistoryEntry[]) {
  writeJson(HISTORY_KEY, list.slice(-150));
}

export interface AppStore {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  connections: SavedConnection[];
  setConnections: (list: SavedConnection[]) => void;
  upsertConnection: (profile: Omit<SavedConnection, "id"> & { id?: string }) => SavedConnection;
  removeConnection: (id: string) => void;
  history: HistoryEntry[];
  record: (type: string, value: string) => void;
  clearHistory: () => void;
}

const HISTORY_LABELS: Record<string, string> = {
  CONNECT: "连接",
  DISCONNECT: "断开",
  REBOOT: "重启服务器",
  COMMAND: "命令",
  DOWNLOAD: "下载",
  UPLOAD: "上传",
  "FILE OPEN": "打开文件",
  "FILE RUN": "运行文件",
  "FILE WRITE": "保存文件",
  "FILE MKDIR": "新建目录",
  "FILE CREATE": "新建文件",
  "FILE RENAME": "重命名",
  "FILE COPY": "复制",
  "FILE MOVE": "移动",
  "FILE DELETE": "删除",
};

export function historyLabel(type: string): string {
  return HISTORY_LABELS[type] ?? type;
}

export const useStore = create<AppStore>((set, get) => ({
  settings: loadSettings(),
  setSettings: (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    saveSettings(next);
  },
  connections: loadConnections(),
  setConnections: (list) => {
    set({ connections: list });
    saveConnections(list);
  },
  upsertConnection: (profile) => {
    const list = [...get().connections];
    const existingIndex = list.findIndex(
      (item) =>
        (profile.id && item.id === profile.id) ||
        (item.host === profile.host && item.port === profile.port && item.username === profile.username),
    );
    const entry: SavedConnection = {
      ...profile,
      id: existingIndex >= 0 ? list[existingIndex].id : profile.id ?? crypto.randomUUID(),
    } as SavedConnection;
    if (existingIndex >= 0) {
      list[existingIndex] = entry;
    } else {
      list.unshift(entry);
    }
    set({ connections: list });
    saveConnections(list);
    return entry;
  },
  removeConnection: (id) => {
    const list = get().connections.filter((item) => item.id !== id);
    set({ connections: list });
    saveConnections(list);
  },
  history: loadHistory(),
  record: (type, value) => {
    const list = [...get().history, { time: new Date().toISOString(), type, value }].slice(-150);
    set({ history: list });
    saveHistory(list);
  },
  clearHistory: () => {
    set({ history: [] });
    saveHistory([]);
  },
}));

export function activeConnectionPayload(info: ConnectionInfo) {
  return { id: info.id, host: info.host, port: info.port, username: info.username, name: info.name };
}

export function formatHost(host: string, port: number) {
  const display = host.includes(":") ? `[${host}]` : host;
  return port === 22 ? display : `${display}:${port}`;
}
