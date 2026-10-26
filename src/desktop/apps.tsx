import type { ReactNode } from "react";
import {
  CloudServerOutlined, CodeOutlined, DashboardOutlined, FileTextOutlined,
  FolderOpenOutlined, HistoryOutlined, PlusOutlined, SettingOutlined,
} from "@ant-design/icons";

export type AppId =
  | "terminal"
  | "files"
  | "monitor"
  | "screen"
  | "history"
  | "settings"
  | "editor"
  | "connect";

export interface AppMeta {
  id: AppId;
  label: string;
  hint: string;
  icon: ReactNode;
  accent: string;
  background: string;
}

/** 应用注册表：桌面图标、Dock、开始菜单与移动端主屏共用。 */
export const APPS: Record<AppId, AppMeta> = {
  terminal: {
    id: "terminal",
    label: "终端",
    hint: "交互式 SSH Shell",
    icon: <CodeOutlined />,
    accent: "#1677ff",
    background: "linear-gradient(135deg, #1d4ed8, #0ea5e9)",
  },
  files: {
    id: "files",
    label: "文件管理",
    hint: "SFTP 浏览与传输",
    icon: <FolderOpenOutlined />,
    accent: "#f0b429",
    background: "linear-gradient(135deg, #f59e0b, #fbbf24)",
  },
  monitor: {
    id: "monitor",
    label: "资源监控",
    hint: "CPU / 内存 / 磁盘",
    icon: <CloudServerOutlined />,
    accent: "#52c41a",
    background: "linear-gradient(135deg, #059669, #34d399)",
  },
  screen: {
    id: "screen",
    label: "后台会话",
    hint: "GNU Screen 任务",
    icon: <DashboardOutlined />,
    accent: "#722ed1",
    background: "linear-gradient(135deg, #7c3aed, #a78bfa)",
  },
  history: {
    id: "history",
    label: "操作记录",
    hint: "本地操作历史",
    icon: <HistoryOutlined />,
    accent: "#eb2f96",
    background: "linear-gradient(135deg, #db2777, #f472b6)",
  },
  settings: {
    id: "settings",
    label: "设置",
    hint: "主题与偏好",
    icon: <SettingOutlined />,
    accent: "#64748b",
    background: "linear-gradient(135deg, #475569, #94a3b8)",
  },
  editor: {
    id: "editor",
    label: "文本编辑器",
    hint: "编辑远程文件",
    icon: <FileTextOutlined />,
    accent: "#0ea5e9",
    background: "linear-gradient(135deg, #0284c7, #38bdf8)",
  },
  connect: {
    id: "connect",
    label: "新建连接",
    hint: "连接到另一台主机",
    icon: <PlusOutlined />,
    accent: "#1677ff",
    background: "linear-gradient(135deg, #2563eb, #60a5fa)",
  },
};

/** 桌面图标顺序（编辑器与连接不常驻桌面，连接单独放在末尾）。 */
export const DESKTOP_APPS: AppId[] = ["terminal", "files", "monitor", "screen", "history", "settings"];

/** Dock / 移动端主屏停靠栏。 */
export const DOCK_APPS: AppId[] = ["terminal", "files", "monitor", "settings"];

export interface WindowGeometry {
  width: number;
  height: number;
}

export const DEFAULT_GEOMETRY: Record<AppId, WindowGeometry> = {
  terminal: { width: 900, height: 560 },
  files: { width: 880, height: 560 },
  monitor: { width: 840, height: 580 },
  screen: { width: 720, height: 520 },
  history: { width: 780, height: 520 },
  settings: { width: 720, height: 560 },
  editor: { width: 880, height: 600 },
  connect: { width: 0, height: 0 },
};

export function appTitle(app: AppId, payload?: Record<string, unknown>): string {
  if (app === "editor" && typeof payload?.path === "string") {
    const name = payload.path.split("/").filter(Boolean).pop();
    return name ? `编辑器 · ${name}` : "文本编辑器";
  }
  if (app === "terminal" && typeof payload?.screenName === "string") {
    return `终端 · ${payload.screenName}`;
  }
  if (app === "files" && typeof payload?.path === "string") {
    return `文件管理 · ${payload.path}`;
  }
  return APPS[app].label;
}
