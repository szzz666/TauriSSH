import type { ReactNode } from "react";
import {
  BarChartOutlined, CloudDownloadOutlined, CodeOutlined, FileTextOutlined,
  FolderOpenOutlined, HistoryOutlined, PlusOutlined, SafetyCertificateOutlined,
  SettingOutlined, SyncOutlined,
} from "@ant-design/icons";

export type AppId =
  | "terminal"
  | "files"
  | "monitor"
  | "firewall"
  | "sources"
  | "systemtime"
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
    label: "任务管理器",
    hint: "进程 / 性能 / 服务",
    icon: <BarChartOutlined />,
    accent: "#52c41a",
    background: "linear-gradient(135deg, #059669, #34d399)",
  },
  firewall: {
    id: "firewall",
    label: "防火墙策略",
    hint: "默认拒绝入站，按需放行",
    icon: <SafetyCertificateOutlined />,
    accent: "#dc2626",
    background: "linear-gradient(135deg, #b91c1c, #f97316)",
  },
  sources: {
    id: "sources",
    label: "软件源",
    hint: "国内镜像加速",
    icon: <CloudDownloadOutlined />,
    accent: "#0891b2",
    background: "linear-gradient(135deg, #2563eb, #06b6d4)",
  },
  systemtime: {
    id: "systemtime",
    label: "系统时间",
    hint: "NTP 同步与时区",
    icon: <SyncOutlined />,
    accent: "#16a34a",
    background: "linear-gradient(135deg, #0f766e, #22c55e)",
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
export const DESKTOP_APPS: AppId[] = [
  "terminal", "files", "monitor", "firewall", "sources", "systemtime", "history", "settings",
];

export interface WindowGeometry {
  width: number;
  height: number;
}

export const DEFAULT_GEOMETRY: Record<AppId, WindowGeometry> = {
  terminal: { width: 960, height: 600 },
  files: { width: 1120, height: 660 },
  monitor: { width: 1120, height: 720 },
  firewall: { width: 1080, height: 700 },
  sources: { width: 1040, height: 680 },
  systemtime: { width: 1040, height: 700 },
  history: { width: 900, height: 560 },
  settings: { width: 820, height: 600 },
  editor: { width: 960, height: 620 },
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
