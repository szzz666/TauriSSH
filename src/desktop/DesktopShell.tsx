import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App as AntApp, Badge, Button, Dropdown, Tooltip, Typography } from "antd";
import {
  AppstoreOutlined, DisconnectOutlined, PoweroffOutlined, ReloadOutlined,
  SettingOutlined, SunOutlined, MoonOutlined, WifiOutlined, CloseOutlined,
} from "@ant-design/icons";
import type { ConnectionInfo, ScreenSession } from "../api";
import { screen as screenApi, ssh } from "../api";
import { useTheme } from "../theme";
import { formatHost } from "../store";
import { APPS, DESKTOP_APPS, DOCK_APPS, DEFAULT_GEOMETRY, appTitle, type AppId } from "./apps";
import { RuntimeContext, type DesktopRuntime } from "./runtime";
import WindowFrame, { type FrameWindow } from "./WindowFrame";
import TerminalView, { type TerminalHandle } from "../components/TerminalView";
import FileManager from "../components/FileManager";
import EditorView from "../components/EditorView";
import MonitorView from "../components/MonitorView";
import ScreenPanel from "../components/ScreenPanel";
import HistoryView from "../components/HistoryView";
import SettingsPanel from "../components/SettingsPanel";

interface Props {
  connection: ConnectionInfo;
  isMobile: boolean;
  fontSize: number;
  setFontSize: (size: number) => void;
  connected: boolean;
  setConnected: (value: boolean) => void;
  onDisconnect: () => void;
  onReboot: () => void;
  onNewConnection: () => void;
  record: (type: string, value: string) => void;
  showWelcome: boolean;
}

interface WindowState extends FrameWindow {
  app: AppId;
  payload: Record<string, unknown>;
}

const TASKBAR = 76;

function useViewport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** 桌面 / 手机主屏外壳：图标、窗口、任务栏与开始菜单。 */
export default function DesktopShell(props: Props) {
  const { connection, isMobile, fontSize, setFontSize, connected, setConnected } = props;
  const { message, modal } = AntApp.useApp();
  const { mode, cycle } = useTheme();
  const viewport = useViewport();
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [, setZCounter] = useState(20);
  const [startOpen, setStartOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [, setScreens] = useState<ScreenSession[]>([]);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshScreens = useCallback(async () => {
    try {
      const result = await ssh.status(connection.id);
      if (!result.connected) return;
      const list = await screenApi.list(connection.id);
      setScreens(list.sessions);
    } catch {
      /* 无 screen 工具或连接已断开时静默 */
    }
  }, [connection.id]);

  useEffect(() => {
    void refreshScreens();
    const timer = setInterval(() => void refreshScreens(), 6000);
    return () => clearInterval(timer);
  }, [refreshScreens]);

  // 视口或形态变化时，把窗口限制回可视区域，避免溢出与互相遮挡
  useEffect(() => {
    setWindows((list) =>
      list.map((item) => {
        if (isMobile) {
          return { ...item, x: 0, y: 0, width: viewport.width, height: viewport.height - TASKBAR, maximized: true };
        }
        const width = Math.min(item.width, Math.max(360, viewport.width - 160));
        const height = Math.min(item.height, Math.max(280, viewport.height - TASKBAR - 100));
        const x = Math.min(Math.max(item.x, 112), Math.max(112, viewport.width - 200));
        const y = Math.min(Math.max(item.y, 0), Math.max(0, viewport.height - TASKBAR - 120));
        return { ...item, width, height, x, y, maximized: false };
      }),
    );
  }, [isMobile, viewport.height, viewport.width]);

  const focusWindow = useCallback((key: string) => {
    setZCounter((z) => {
      const next = z + 1;
      setWindows((list) => list.map((item) => (item.key === key ? { ...item, z: next, minimized: false } : item)));
      return next;
    });
  }, []);

  const openApp = useCallback(
    (app: AppId, options?: { payload?: Record<string, unknown>; title?: string }): string => {
      const payload = options?.payload ?? {};
      const key = app === "editor" && typeof payload.path === "string" ? `editor:${payload.path}` : `${app}:${JSON.stringify(payload)}`;
      setZCounter((z) => {
        const nextZ = z + 1;
        setWindows((list) => {
          const existing = list.find((item) => item.key === key);
          if (existing) {
            return list.map((item) => (item.key === key ? { ...item, z: nextZ, minimized: false } : item));
          }
          const geometry = DEFAULT_GEOMETRY[app] ?? { width: 760, height: 520 };
          const index = list.length;
          // 移动端窗口全屏（CSS 也会强制铺满），桌面端限制在可视区域内并阶梯平铺
          const width = isMobile ? viewport.width : Math.min(geometry.width, Math.max(360, viewport.width - 160));
          const height = isMobile
            ? viewport.height - TASKBAR
            : Math.min(geometry.height, Math.max(280, viewport.height - TASKBAR - 100));
          const step = 28;
          const x = isMobile ? 0 : Math.max(112, Math.round((viewport.width - width) / 2) + ((index % 4) - 1.5) * step);
          const y = isMobile ? 0 : Math.max(20, Math.round((viewport.height - TASKBAR - height) / 2) + ((index % 4) - 1.5) * step);
          return [
            ...list,
            {
              key,
              app,
              payload,
              title: options?.title ?? appTitle(app, payload),
              subtitle: `${connection.username}@${formatHost(connection.host, connection.port)}`,
              x,
              y,
              width,
              height,
              z: nextZ,
              minimized: false,
              maximized: isMobile,
              accent: APPS[app].accent,
            },
          ];
        });
        return nextZ;
      });
      setStartOpen(false);
      return key;
    },
    [connection, isMobile, viewport.height, viewport.width],
  );

  const closeWindow = useCallback((key: string) => {
    setWindows((list) => list.filter((item) => item.key !== key));
  }, []);

  // Android 返回键（由 MainActivity 转发为 taurissh-back 事件）：
  // 依次关闭开始菜单 → 最上层窗口；全部关闭后不消费事件，交给系统退出。
  useEffect(() => {
    const handler = (event: Event) => {
      if (startOpen) {
        setStartOpen(false);
        event.preventDefault();
        return;
      }
      let consumed = false;
      setWindows((list) => {
        if (list.length === 0) return list;
        consumed = true;
        const top = [...list].sort((a, b) => b.z - a.z)[0];
        return list.filter((item) => item.key !== top.key);
      });
      if (consumed) event.preventDefault();
    };
    window.addEventListener("taurissh-back", handler);
    return () => window.removeEventListener("taurissh-back", handler);
  }, [startOpen]);

  const runtime = useMemo<DesktopRuntime>(
    () => ({
      connection,
      isMobile,
      fontSize,
      setFontSize,
      openApp,
      closeWindow,
      record: props.record,
      requestDisconnect: props.onDisconnect,
      requestReboot: props.onReboot,
      requestNewConnection: props.onNewConnection,
      connected,
      setConnected,
    }),
    [connection, connected, fontSize, isMobile, openApp, closeWindow, props, setConnected, setFontSize],
  );

  useEffect(() => {
    if (!props.showWelcome) return;
    const key = "terminal:{}";
    setWindows((list) =>
      list.some((item) => item.key === key)
        ? list
        : [
            ...list,
            {
              key,
              app: "terminal" as AppId,
              payload: {},
              title: "终端",
              subtitle: `${connection.username}@${formatHost(connection.host, connection.port)}`,
              x: Math.max(24, Math.round((viewport.width - 900) / 2)),
              y: Math.max(20, Math.round((viewport.height - TASKBAR - 560) / 2)),
              width: Math.min(900, viewport.width - 120),
              height: Math.min(560, viewport.height - TASKBAR - 80),
              z: 21,
              minimized: false,
              maximized: isMobile,
              accent: APPS.terminal.accent,
            },
          ],
    );
    // 仅在挂载时打开初始终端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderApp = (win: WindowState): ReactNode => {
    switch (win.app) {
      case "terminal": {
        const screenName = typeof win.payload.screenName === "string" ? win.payload.screenName : undefined;
        return (
          <TerminalPane
            termId={win.key}
            connectionId={connection.id}
            screenName={screenName}
            fontSize={fontSize}
            onConnectedChange={setConnected}
            onFontChange={setFontSize}
          />
        );
      }
      case "files":
        return <FileManager connectionId={connection.id} initialPath={(win.payload.path as string) ?? "/"} />;
      case "monitor":
        return <MonitorView connectionId={connection.id} />;
      case "screen":
        return (
          <ScreenPanel
            connectionId={connection.id}
            onOpen={(session) => {
              refreshScreens();
              openApp("terminal", {
                payload: { screenName: session.name },
                title: `终端 · ${session.label}`,
              });
            }}
          />
        );
      case "history":
        return <HistoryView />;
      case "settings":
        return <SettingsPanel />;
      case "editor":
        return (
          <EditorView
            connectionId={connection.id}
            path={String(win.payload.path ?? "")}
            onSaved={() => message.success("已保存")}
          />
        );
      default:
        return null;
    }
  };

  const menuItems = [
    { key: "open", label: "打开" },
    { key: "minimize", label: "最小化", disabled: false },
    { type: "divider" as const },
    { key: "close", label: "关闭窗口", danger: true },
  ];

  const tasks = windows.map((win) => ({ ...win }));
  const visibleWindows = windows.filter((win) => !win.minimized);
  const activeKey = [...visibleWindows].sort((a, b) => b.z - a.z)[0]?.key;

  console.log("[TauriSSH] DesktopShell render", { windows: windows.length, isMobile, connected });
  return (
    <RuntimeContext.Provider value={runtime}>
      <div className={`os-shell${isMobile ? " is-mobile" : ""}`} ref={shellRef}>
        <div className="os-wallpaper" aria-hidden />
        <header className="os-topbar">
          <div className="os-brand">
            <span className="os-brand-badge">T</span>
            <div>
              <strong>TauriSSH</strong>
              <small>
                {connection.username}@{formatHost(connection.host, connection.port)}
              </small>
            </div>
          </div>
          <div className="os-topbar-status">
            <Badge status={connected ? "success" : "default"} text={connected ? "已连接" : "未连接"} />
            <Tooltip title={`主题：${mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}`}>
              <Button
                type="text"
                size="small"
                icon={mode === "dark" ? <MoonOutlined /> : <SunOutlined />}
                onClick={cycle}
              />
            </Tooltip>
            <span className="os-clock">
              {clock.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          </div>
        </header>

        <main className="os-desktop" onPointerDown={() => setStartOpen(false)}>
          <div className={`os-icons${isMobile ? " is-mobile" : ""}`}>
            {DESKTOP_APPS.map((app) => (
              <button key={app} type="button" className="os-icon" onClick={() => openApp(app)}>
                <span className="os-icon-tile" style={{ background: APPS[app].background }}>
                  {APPS[app].icon}
                </span>
                <span className="os-icon-label">{APPS[app].label}</span>
              </button>
            ))}
            <button type="button" className="os-icon" onClick={props.onNewConnection}>
              <span className="os-icon-tile" style={{ background: APPS.connect.background }}>
                {APPS.connect.icon}
              </span>
              <span className="os-icon-label">{APPS.connect.label}</span>
            </button>
          </div>

          {visibleWindows.map((win) => (
            <WindowFrame
              key={win.key}
              win={win}
              active={win.key === activeKey}
              hidden={win.minimized}
              bounds={{ width: viewport.width, height: viewport.height }}
              onFocus={() => focusWindow(win.key)}
              onClose={() => closeWindow(win.key)}
              onMinimize={() =>
                setWindows((list) => list.map((item) => (item.key === win.key ? { ...item, minimized: true } : item)))
              }
              onToggleMaximize={() =>
                setWindows((list) =>
                  list.map((item) => (item.key === win.key ? { ...item, maximized: !item.maximized } : item)),
                )
              }
              onMove={(x, y) =>
                setWindows((list) => list.map((item) => (item.key === win.key ? { ...item, x, y } : item)))
              }
              onResize={(width, height) =>
                setWindows((list) => list.map((item) => (item.key === win.key ? { ...item, width, height } : item)))
              }
            >
              {renderApp(win)}
            </WindowFrame>
          ))}
        </main>

        {startOpen ? (
          <div className="os-start" onPointerDown={(event) => event.stopPropagation()}>
            <div className="os-start-head">
              <Typography.Text strong>{connection.label}</Typography.Text>
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setStartOpen(false)} />
            </div>
            <div className="os-start-grid">
              {Object.values(APPS)
                .filter((app) => app.id !== "connect" && app.id !== "editor")
                .map((app) => (
                  <button key={app.id} type="button" className="os-start-item" onClick={() => openApp(app.id)}>
                    <span className="os-icon-tile" style={{ background: app.background }}>
                      {app.icon}
                    </span>
                    <span>{app.label}</span>
                  </button>
                ))}
            </div>
            <div className="os-start-footer">
              <Button block icon={<WifiOutlined />} onClick={() => openApp("screen")}>
                后台会话
              </Button>
              <Button block icon={<SettingOutlined />} onClick={() => openApp("settings")}>
                工作台设置
              </Button>
              <Button block icon={<ReloadOutlined />} onClick={props.onReboot} danger>
                重启服务器
              </Button>
              <Button block icon={<DisconnectOutlined />} onClick={props.onDisconnect} danger>
                断开连接
              </Button>
            </div>
          </div>
        ) : null}

        <footer className={`os-taskbar${isMobile ? " is-mobile" : ""}`}>
          <Button
            className="os-launcher"
            type={startOpen ? "primary" : "default"}
            icon={<AppstoreOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              setStartOpen((open) => !open);
            }}
          >
            {isMobile ? null : "应用"}
          </Button>
          <div className="os-tasks">
            {tasks.map((task) => (
              <Dropdown
                key={task.key}
                trigger={["contextMenu"]}
                menu={{
                  items: menuItems,
                  onClick: ({ key }) => {
                    if (key === "open") focusWindow(task.key);
                    if (key === "minimize")
                      setWindows((list) =>
                        list.map((item) => (item.key === task.key ? { ...item, minimized: true } : item)),
                      );
                    if (key === "close") closeWindow(task.key);
                  },
                }}
              >
                <button
                  type="button"
                  className={`os-task${task.key === activeKey ? " is-active" : ""}${task.minimized ? " is-min" : ""}`}
                  onClick={() => (task.key === activeKey && !task.minimized ? setWindows((list) => list.map((item) => (item.key === task.key ? { ...item, minimized: true } : item))) : focusWindow(task.key))}
                >
                  <span className="os-task-dot" style={{ background: task.accent }} />
                  <span className="os-task-label">{task.title}</span>
                </button>
              </Dropdown>
            ))}
          </div>
          <div className="os-dock">
            {DOCK_APPS.map((app) => (
              <Tooltip key={app} title={APPS[app].label}>
                <button type="button" className="os-dock-item" onClick={() => openApp(app)}>
                  <span className="os-icon-tile" style={{ background: APPS[app].background }}>
                    {APPS[app].icon}
                  </span>
                </button>
              </Tooltip>
            ))}
            <Tooltip title="重启服务器">
              <button
                type="button"
                className="os-dock-item"
                onClick={() =>
                  modal.confirm({
                    title: "重启远程服务器？",
                    content: "服务器将立即重启，当前连接会中断。",
                    okText: "重启",
                    okButtonProps: { danger: true },
                    cancelText: "取消",
                    onOk: props.onReboot,
                  })
                }
              >
                <span className="os-icon-tile" style={{ background: "linear-gradient(135deg, #dc2626, #f87171)" }}>
                  <PoweroffOutlined />
                </span>
              </button>
            </Tooltip>
          </div>
        </footer>
      </div>
    </RuntimeContext.Provider>
  );
}

function TerminalPane({
  termId, connectionId, screenName, fontSize, onConnectedChange, onFontChange,
}: {
  termId: string;
  connectionId: string;
  screenName?: string;
  fontSize: number;
  onConnectedChange: (value: boolean) => void;
  onFontChange: (size: number) => void;
}) {
  const ref = useRef<TerminalHandle | null>(null);
  const [ready, setReady] = useState(false);

  return (
    <div className="os-terminal">
      <div className="os-terminal-tools">
        <Button size="small" onClick={() => ref.current?.clear()}>
          清屏
        </Button>
        <Button size="small" onClick={() => { const next = Math.max(11, fontSize - 1); onFontChange(next); }}>
          小
        </Button>
        <Button size="small" onClick={() => { const next = Math.min(22, fontSize + 1); onFontChange(next); }}>
          大
        </Button>
        <span className="muted">{ready ? "已连接" : "连接中..."}</span>
      </div>
      <div className="os-terminal-host">
        <TerminalView
          key={termId}
          ref={ref}
          termId={termId}
          connectionId={connectionId}
          screenName={screenName}
          fontSize={fontSize}
          onReady={() => {
            setReady(true);
            onConnectedChange(true);
          }}
          onClosed={() => {
            setReady(false);
            onConnectedChange(false);
          }}
          onError={() => {
            setReady(false);
            onConnectedChange(false);
          }}
        />
      </div>
    </div>
  );
}
