import { createContext, useContext } from "react";
import type { ConnectionInfo } from "../api";
import type { AppId } from "./apps";

export interface OpenAppOptions {
  payload?: Record<string, unknown>;
  title?: string;
}

export interface DesktopRuntime {
  connection: ConnectionInfo;
  isMobile: boolean;
  fontSize: number;
  setFontSize: (size: number) => void;
  openApp: (app: AppId, options?: OpenAppOptions) => string;
  closeWindow: (key: string) => void;
  record: (type: string, value: string) => void;
  requestDisconnect: () => void;
  requestReboot: () => void;
  requestNewConnection: () => void;
  connected: boolean;
  setConnected: (value: boolean) => void;
}

export const RuntimeContext = createContext<DesktopRuntime | null>(null);

export function useRuntime(): DesktopRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("DesktopRuntime 未初始化");
  return runtime;
}
