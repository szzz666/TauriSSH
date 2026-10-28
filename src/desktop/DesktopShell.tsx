import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App as AntApp, Badge, Button, Dropdown, Input, Switch, Tooltip, Typography } from "antd";
import {
  AppstoreOutlined, CloseOutlined, DisconnectOutlined, FileTextOutlined, FolderOpenOutlined,
  MoonOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, SunOutlined,
} from "@ant-design/icons";
import type { ConnectionInfo, RemoteFile, ScreenSession } from "../api";
import { files as filesApi, screen as screenApi, ssh } from "../api";
import { useTheme } from "../theme";
import { formatHost, useStore } from "../store";
import { APPS, DESKTOP_APPS, DEFAULT_GEOMETRY, appTitle, type AppId } from "./apps";
import { RuntimeContext, type DesktopRuntime, type OpenAppOptions } from "./runtime";
import WindowFrame, { type FrameWindow } from "./WindowFrame";
import TerminalView, { type TerminalHandle } from "../components/TerminalView";
import FileManager from "../components/FileManager";
import EditorView from "../components/EditorView";
import HistoryView from "../components/HistoryView";
import SettingsPanel from "../components/SettingsPanel";
import TaskManagerView from "../components/sysadmin/TaskManagerView";
import FirewallView from "../components/sysadmin/FirewallView";
import MirrorView from "../components/sysadmin/MirrorView";
import SystemTimeView from "../components/sysadmin/SystemTimeView";
import { useFileActions, FileActionProgress } from "../components/file-actions";
import { useContextMenu } from "../components/ContextMenu";
import { onDesktopChanged } from "./events";

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

function screenWindowKey(name: string) {
  return "terminal:" + JSON.stringify({ screenName: name });
}

function screenBadge(label: string) {
  const value = (label || "Screen").trim();
  return Array.from(value)[0]?.toUpperCase() || "S";
}

interface IconPosition {
  x: number;
  y: number;
}

const ICON_WIDTH = 100;
const ICON_HEIGHT = 88;
const ICON_GAP = 8;
const ICON_MARGIN = 14;
const CELL_WIDTH = ICON_WIDTH + ICON_GAP;
const CELL_HEIGHT = ICON_HEIGHT + ICON_GAP;
const MAGNET_DISTANCE = 22;

const appIconKey = (app: AppId) => "app:" + app;
const entryIconKey = (path: string) => "entry:" + path;
const desktopLayoutPath = (desktopDir: string) =>
  desktopDir.replace(/\/desktop$/, "") + "/desktop-layout.json";

function buildIconKeys(entries: RemoteFile[]) {
  return [
    ...DESKTOP_APPS.map(appIconKey),
    ...entries.map((entry) => entryIconKey(entry.path)),
    appIconKey("connect"),
  ];
}

interface IconGrid {
  columns: number;
  rows: number;
}

function iconGrid(width: number, height: number): IconGrid {
  return {
    columns: Math.max(1, Math.floor((width - ICON_MARGIN * 2 + ICON_GAP) / CELL_WIDTH)),
    rows: Math.max(1, Math.floor((height - ICON_MARGIN * 2 + ICON_GAP) / CELL_HEIGHT)),
  };
}

function cellOf(position: IconPosition) {
  return {
    column: Math.max(0, Math.round((position.x - ICON_MARGIN) / CELL_WIDTH)),
    row: Math.max(0, Math.round((position.y - ICON_MARGIN) / CELL_HEIGHT)),
  };
}

function positionOfCell(column: number, row: number): IconPosition {
  return {
    x: ICON_MARGIN + column * CELL_WIDTH,
    y: ICON_MARGIN + row * CELL_HEIGHT,
  };
}

function clampIconPosition(position: IconPosition, width: number, height: number): IconPosition {
  return {
    x: Math.max(0, Math.min(Math.max(0, width - ICON_WIDTH), position.x)),
    y: Math.max(0, Math.min(Math.max(0, height - ICON_HEIGHT), position.y)),
  };
}

/** 靠近单元格时吸附到网格，否则保持自由位置。 */
function magnetIconPosition(position: IconPosition, width: number, height: number): IconPosition {
  const clamped = clampIconPosition(position, width, height);
  const cell = cellOf(clamped);
  const grid = positionOfCell(cell.column, cell.row);
  const dx = Math.abs(grid.x - clamped.x);
  const dy = Math.abs(grid.y - clamped.y);
  if (dx <= MAGNET_DISTANCE && dy <= MAGNET_DISTANCE) {
    return clampIconPosition(grid, width, height);
  }
  return clamped;
}

/** 松手时对齐到最近的网格位置。 */
function snapIconPosition(position: IconPosition, width: number, height: number): IconPosition {
  const cell = cellOf(clampIconPosition(position, width, height));
  return clampIconPosition(positionOfCell(cell.column, cell.row), width, height);
}

function occupiedCells(positions: Record<string, IconPosition>, skip?: string) {
  const taken = new Set<string>();
  for (const [key, value] of Object.entries(positions)) {
    if (key === skip) continue;
    const cell = cellOf(value);
    taken.add(cell.column + ":" + cell.row);
  }
  return taken;
}

function firstFreeCellIn(taken: Set<string>, width: number, height: number): IconPosition {
  const grid = iconGrid(width, height);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      if (!taken.has(column + ":" + row)) {
        return positionOfCell(column, row);
      }
    }
  }
  return positionOfCell(0, Math.max(0, grid.rows - 1));
}

function firstFreeCell(positions: Record<string, IconPosition>, width: number, height: number): IconPosition {
  return firstFreeCellIn(occupiedCells(positions), width, height);
}

function nearestFreeCell(
  position: IconPosition,
  positions: Record<string, IconPosition>,
  width: number,
  height: number,
  skip?: string,
): IconPosition {
  const target = cellOf(position);
  const grid = iconGrid(width, height);
  const taken = occupiedCells(positions, skip);
  let best: IconPosition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      if (taken.has(column + ":" + row)) continue;
      const distance = Math.abs(column - target.column) + Math.abs(row - target.row) * 1.2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = positionOfCell(column, row);
      }
    }
  }
  return best ?? firstFreeCell(positions, width, height);
}

function defaultIconPositions(keys: string[], width: number, height: number): Record<string, IconPosition> {
  const grid = iconGrid(width, height);
  const positions: Record<string, IconPosition> = {};
  keys.forEach((key, index) => {
    positions[key] = positionOfCell(index % grid.columns, Math.floor(index / grid.columns));
  });
  return positions;
}

function readSavedIconPosition(value: unknown): IconPosition | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const x = Number(raw.x);
    const y = Number(raw.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  return null;
}

function useElementSize(ref: { current: HTMLElement | null }) {
  const [size, setSize] = useState({
    width: Math.max(360, window.innerWidth - 16),
    height: Math.max(300, window.innerHeight - 112),
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      setSize({ width: Math.max(360, element.clientWidth), height: Math.max(280, element.clientHeight) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** 桌面 / 手机主屏外壳：图标、窗口、任务栏与开始菜单。 */
export default function DesktopShell(props: Props) {
  const { connection, isMobile, fontSize, setFontSize, connected, setConnected } = props;
  const { message, modal } = AntApp.useApp();
  const { mode, cycle } = useTheme();
  const settings = useStore((state) => state.settings);
  const desktopRef = useRef<HTMLElement | null>(null);
  const desktopSize = useElementSize(desktopRef);
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [, setZCounter] = useState(20);
  const [startOpen, setStartOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [screens, setScreens] = useState<ScreenSession[]>([]);
  const [desktopEntries, setDesktopEntries] = useState<RemoteFile[]>([]);
  const [desktopDir, setDesktopDir] = useState("");
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [desktopLoading, setDesktopLoading] = useState(false);
  const [iconPositions, setIconPositions] = useState<Record<string, IconPosition>>({});
  const [draggingIcon, setDraggingIcon] = useState<string | null>(null);
  const iconPositionsRef = useRef<Record<string, IconPosition>>({});
  const iconDragRef = useRef<{
    key: string;
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const suppressIconClick = useRef(false);
  const sortDesktop = useRef(false);
  const welcomeOpened = useRef(false);
  const menu = useContextMenu();

  useEffect(() => {
    try {
      sortDesktop.current = localStorage.getItem("taurissh.desktop.arrange") === "1";
    } catch {
      sortDesktop.current = false;
    }
  }, []);

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

  const sortEntries = useCallback((list: RemoteFile[]) => {
    if (!sortDesktop.current) return list;
    return [...list].sort((a, b) => {
      const aDir = (a.type === "shortcut" ? a.targetType : a.type) === "directory" ? 0 : 1;
      const bDir = (b.type === "shortcut" ? b.targetType : b.type) === "directory" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }, []);

  const saveIconLayoutAt = useCallback(
    async (directory: string, positions: Record<string, IconPosition>) => {
      // 手机上图标由 CSS 网格排版，保存手机坐标会覆盖桌面端布局
      if (!directory || isMobile) return;
      try {
        await filesApi.write(
          connection.id,
          desktopLayoutPath(directory),
          JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), positions }),
        );
      } catch (error) {
        message.warning("桌面图标位置保存失败：" + (error as Error).message);
      }
    },
    [connection.id, isMobile, message],
  );

  const loadIconLayout = useCallback(
    async (directory: string, entries: RemoteFile[]) => {
      if (isMobile) {
        // 手机用网格排版，既不读取也不写回服务器上的桌面坐标
        iconPositionsRef.current = {};
        setIconPositions({});
        return;
      }
      const keys = buildIconKeys(entries);
      const defaults = defaultIconPositions(keys, desktopSize.width, desktopSize.height);
      let saved: Record<string, unknown> = {};
      if (directory) {
        try {
          const file = await filesApi.read(connection.id, desktopLayoutPath(directory));
          const data = JSON.parse(file.content) as { positions?: Record<string, unknown> };
          saved = data.positions ?? {};
        } catch {
          /* 首次使用或布局文件不存在时使用默认位置 */
        }
      }
      const merged: Record<string, IconPosition> = {};
      const taken = new Set<string>();
      // 先安置已有保存位置的图标，再为新图标寻找空格，避免新图标挤掉旧图标
      const placed = new Set<string>();
      for (const key of keys) {
        const savedPosition = readSavedIconPosition(saved[key]);
        if (!savedPosition) continue;
        const position = clampIconPosition(savedPosition, desktopSize.width, desktopSize.height);
        const cell = cellOf(position);
        if (taken.has(cell.column + ":" + cell.row)) continue;
        taken.add(cell.column + ":" + cell.row);
        merged[key] = position;
        placed.add(key);
      }
      for (const key of keys) {
        if (placed.has(key)) continue;
        let position = clampIconPosition(defaults[key], desktopSize.width, desktopSize.height);
        let cell = cellOf(position);
        if (taken.has(cell.column + ":" + cell.row)) {
          position = firstFreeCellIn(taken, desktopSize.width, desktopSize.height);
          cell = cellOf(position);
        }
        taken.add(cell.column + ":" + cell.row);
        merged[key] = position;
      }
      iconPositionsRef.current = merged;
      setIconPositions(merged);
      // 有新图标或位置被修正时，把最终布局写回服务器，避免下次重连再次重叠
      const changed = keys.some((key) => {
        const savedPosition = readSavedIconPosition(saved[key]);
        const position = merged[key];
        return !savedPosition || savedPosition.x !== position.x || savedPosition.y !== position.y;
      });
      if (changed) {
        await saveIconLayoutAt(directory, merged);
      }
    },
    [connection.id, desktopSize.height, desktopSize.width, isMobile, saveIconLayoutAt],
  );

  const saveIconLayout = useCallback(
    async (positions: Record<string, IconPosition>) => {
      await saveIconLayoutAt(desktopDir, positions);
    },
    [desktopDir, saveIconLayoutAt],
  );

  const refreshDesktop = useCallback(async () => {
    setDesktopLoading(true);
    try {
      const result = await filesApi.desktop(connection.id);
      const entries = sortEntries(result.files);
      setDesktopDir(result.dir);
      setDesktopEntries(entries);
      await loadIconLayout(result.dir, entries);
      setDesktopError(null);
    } catch (error) {
      setDesktopError((error as Error).message);
      setDesktopEntries([]);
    } finally {
      setDesktopLoading(false);
    }
  }, [connection.id, loadIconLayout, sortEntries]);

  useEffect(() => {
    void refreshDesktop();
    return onDesktopChanged(() => void refreshDesktop());
  }, [refreshDesktop]);

  // 桌面条目变化（新增图标、上传文件、窗口缩放）时补齐位置，保证新图标落在空格子上
  useEffect(() => {
    // 手机主屏用 CSS 网格排版，不参与绝对定位计算
    if (isMobile) return;
    setIconPositions((previous) => {
      const keys = buildIconKeys(desktopEntries);
      const defaults = defaultIconPositions(keys, desktopSize.width, desktopSize.height);
      const next: Record<string, IconPosition> = {};
      const taken = new Set<string>();
      let changed = Object.keys(previous).length !== keys.length;
      for (const key of keys) {
        const source = previous[key];
        let position = source
          ? clampIconPosition(source, desktopSize.width, desktopSize.height)
          : undefined;
        if (!position || taken.has(cellOf(position).column + ":" + cellOf(position).row)) {
          position = firstFreeCellIn(taken, desktopSize.width, desktopSize.height);
          if (!source) {
            const preferred = defaults[key];
            const preferredCell = cellOf(preferred);
            if (!taken.has(preferredCell.column + ":" + preferredCell.row)) {
              position = clampIconPosition(preferred, desktopSize.width, desktopSize.height);
            }
          }
          changed = true;
        }
        taken.add(cellOf(position).column + ":" + cellOf(position).row);
        next[key] = position;
        if (!source || source.x !== position.x || source.y !== position.y) changed = true;
      }
      if (!changed) return previous;
      iconPositionsRef.current = next;
      return next;
    });
  }, [desktopEntries, desktopSize.height, desktopSize.width, isMobile]);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = iconDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.pointerX;
      const dy = event.clientY - drag.pointerY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
      let position = magnetIconPosition(
        { x: drag.originX + dx, y: drag.originY + dy },
        desktopSize.width,
        desktopSize.height,
      );
      // 目标格已有其他图标时保持自由拖动，落点再由松手逻辑寻找空位
      const taken = occupiedCells(iconPositionsRef.current, drag.key);
      const cell = cellOf(position);
      if (taken.has(cell.column + ":" + cell.row)) {
        position = clampIconPosition(
          { x: drag.originX + dx, y: drag.originY + dy },
          desktopSize.width,
          desktopSize.height,
        );
      }
      drag.lastX = position.x;
      drag.lastY = position.y;
      setIconPositions((previous) => {
        const next = { ...previous, [drag.key]: position };
        iconPositionsRef.current = next;
        return next;
      });
    };

    const handleUp = () => {
      const drag = iconDragRef.current;
      if (!drag) return;
      iconDragRef.current = null;
      setDraggingIcon(null);
      document.body.style.userSelect = "";
      if (!drag.moved) return;
      const previous = iconPositionsRef.current;
      const target = snapIconPosition({ x: drag.lastX, y: drag.lastY }, desktopSize.width, desktopSize.height);
      const occupied = occupiedCells(previous, drag.key);
      const cell = cellOf(target);
      const position = occupied.has(cell.column + ":" + cell.row)
        ? nearestFreeCell(target, previous, desktopSize.width, desktopSize.height, drag.key)
        : target;
      const next = { ...previous, [drag.key]: position };
      iconPositionsRef.current = next;
      setIconPositions(next);
      void saveIconLayout(next);
      suppressIconClick.current = true;
      window.setTimeout(() => { suppressIconClick.current = false; }, 250);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.userSelect = "";
    };
  }, [desktopSize.height, desktopSize.width, saveIconLayout]);

  const beginIconDrag = useCallback(
    (event: React.PointerEvent, key: string) => {
      if (isMobile || event.button !== 0) return;
      const origin = iconPositionsRef.current[key] ?? { x: ICON_MARGIN, y: ICON_MARGIN };
      event.stopPropagation();
      iconDragRef.current = {
        key,
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: origin.x,
        originY: origin.y,
        lastX: origin.x,
        lastY: origin.y,
        moved: false,
      };
      setDraggingIcon(key);
      document.body.style.userSelect = "none";
    },
    [isMobile],
  );

  const focusWindow = useCallback((key: string) => {
    setZCounter((z) => {
      const next = z + 1;
      setWindows((list) => list.map((item) => (item.key === key ? { ...item, z: next, minimized: false } : item)));
      return next;
    });
  }, []);

  const openApp = useCallback(
    (app: AppId, options?: OpenAppOptions): string => {
      const payload = options?.payload ?? {};
      const baseKey = app === "editor" && typeof payload.path === "string"
        ? "editor:" + payload.path
        : app + ":" + JSON.stringify(payload);
      const key = options?.newWindow ? baseKey + "#" + Date.now().toString(36) : baseKey;
      setZCounter((z) => {
        const nextZ = z + 1;
        setWindows((list) => {
          const existing = list.find((item) => item.key === key);
          if (existing) {
            return list.map((item) => (item.key === key ? { ...item, z: nextZ, minimized: false } : item));
          }
          const geometry = DEFAULT_GEOMETRY[app] ?? { width: 760, height: 520 };
          const index = list.length;
          const maxWidth = Math.max(320, desktopSize.width - 16);
          const maxHeight = Math.max(240, desktopSize.height - 16);
          const width = isMobile ? desktopSize.width : Math.min(geometry.width, maxWidth);
          const height = isMobile ? desktopSize.height : Math.min(geometry.height, maxHeight);
          const step = 26;
          const centeredX = Math.round((desktopSize.width - width) / 2) + ((index % 4) - 1.5) * step;
          const centeredY = Math.round((desktopSize.height - height) / 2) + ((index % 4) - 1.5) * step;
          const iconWidth = desktopSize.width >= 1100 ? 220 : 104;
          const maxX = Math.max(8, desktopSize.width - width - 8);
          const x = isMobile ? 0 : Math.max(8, Math.min(Math.max(iconWidth, centeredX), maxX));
          const y = isMobile ? 0 : Math.min(Math.max(12, centeredY), Math.max(8, desktopSize.height - height - 8));
          return [
            ...list,
            {
              key,
              app,
              payload,
              title: options?.title ?? appTitle(app, payload),
              subtitle: connection.username + "@" + formatHost(connection.host, connection.port),
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
    [connection, desktopSize.height, desktopSize.width, isMobile],
  );

  const openScreen = useCallback(
    (session: ScreenSession) => {
      openApp("terminal", {
        payload: { screenName: session.name },
        title: "终端 · " + session.label,
      });
    },
    [openApp],
  );

  const closeWindow = useCallback((key: string) => {
    setWindows((list) => list.filter((item) => item.key !== key));
  }, []);

  const fileActions = useFileActions({
    connectionId: connection.id,
    onRefresh: refreshDesktop,
    onOpenEditor: (path) => { openApp("editor", { payload: { path } }); },
    onOpenFiles: (path) => { openApp("files", { payload: { path }, newWindow: true }); },
    onOpenScreen: (session) => {
      openScreen(session);
      void refreshScreens();
    },
  });

  useEffect(() => {
    if (isMobile) {
      setWindows((list) => list.map((item) => ({
        ...item,
        x: 0,
        y: 0,
        width: desktopSize.width,
        height: desktopSize.height,
        maximized: true,
      })));
      return;
    }
    setWindows((list) =>
      list.map((item) => {
        const width = Math.min(item.width, Math.max(360, desktopSize.width - 16));
        const height = Math.min(item.height, Math.max(280, desktopSize.height - 16));
        const x = Math.min(Math.max(item.x, 8), Math.max(8, desktopSize.width - width - 8));
        const y = Math.min(Math.max(item.y, 8), Math.max(8, desktopSize.height - height - 8));
        return { ...item, width, height, x, y };
      }),
    );
  }, [desktopSize.height, desktopSize.width, isMobile]);

  useEffect(() => {
    if (!props.showWelcome || welcomeOpened.current || desktopSize.width < 200) return;
    welcomeOpened.current = true;
    openApp("terminal");
  }, [desktopSize.width, openApp, props.showWelcome]);

  // Android 返回键：先关开始菜单，再关最上层窗口。
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

  const createScreen = useCallback(() => {
    let label = "";
    let path = "";
    let autoExit = settings.screenAutoExit;
    modal.confirm({
      title: "新建 Screen 会话",
      width: 500,
      content: (
        <div className="screen-create-form">
          <Typography.Text type="secondary">会话会在后台持续运行，可最小化或关闭窗口而不终止程序。</Typography.Text>
          <Input placeholder="会话名称（可选）" onChange={(event) => { label = event.target.value; }} />
          <Input placeholder="运行文件路径（可选，绝对路径）" onChange={(event) => { path = event.target.value; }} />
          <div className="screen-create-switch">
            <Switch defaultChecked={autoExit} onChange={(value) => { autoExit = value; }} />
            <Typography.Text type="secondary">程序结束后自动退出会话</Typography.Text>
          </div>
        </div>
      ),
      okText: "创建",
      cancelText: "取消",
      onOk: async () => {
        const status = await fileActions.ensureTools(["screen"]);
        if (!status) return Promise.reject(new Error("screen unavailable"));
        try {
          const session = await screenApi.create(connection.id, {
            label: label.trim(),
            path: path.trim(),
            autoExit,
          });
          setScreens((previous) => [...previous.filter((item) => item.name !== session.name), session]);
          openScreen(session);
          await refreshScreens();
        } catch (error) {
          message.error((error as Error).message);
          return Promise.reject(error);
        }
        return undefined;
      },
    });
  }, [connection.id, fileActions, message, modal, openScreen, refreshScreens, settings.screenAutoExit]);

  const killScreen = useCallback(
    (session: ScreenSession) => {
      modal.confirm({
        title: "退出 " + session.label + "？",
        content: "该操作会终止远程 Screen 会话及其中的程序，且无法恢复。",
        okText: "退出会话",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: async () => {
          try {
            await screenApi.create(connection.id, { action: "kill", name: session.name });
            setScreens((previous) => previous.filter((item) => item.name !== session.name));
            setWindows((list) => list.filter((item) => item.key !== screenWindowKey(session.name)));
            await refreshScreens();
            message.success("Screen 会话已退出");
          } catch (error) {
            message.error((error as Error).message);
          }
        },
      });
    },
    [connection.id, message, modal, refreshScreens],
  );

  const toggleScreen = useCallback(
    (session: ScreenSession) => {
      const key = screenWindowKey(session.name);
      const existing = windows.find((item) => item.key === key);
      if (!existing) {
        openScreen(session);
        return;
      }
      if (!existing.minimized && existing.key === [...windows].filter((item) => !item.minimized).sort((a, b) => b.z - a.z)[0]?.key) {
        setWindows((list) => list.map((item) => (item.key === key ? { ...item, minimized: true } : item)));
      } else {
        focusWindow(key);
      }
    },
    [focusWindow, openScreen, windows],
  );

  const screenMenu = useCallback(
    (session: ScreenSession) => {
      const key = screenWindowKey(session.name);
      const existing = windows.find((item) => item.key === key);
      return {
        items: [
          { key: "open", label: existing ? "打开 / 恢复" : "打开会话" },
          { key: "minimize", label: "最小化窗口", disabled: !existing || existing.minimized },
          { key: "new", label: "新建 Screen" },
          { type: "divider" as const },
          { key: "kill", label: "退出会话", danger: true },
        ],
        onClick: ({ key: action }: { key: string }) => {
          if (action === "open") openScreen(session);
          if (action === "minimize") setWindows((list) => list.map((item) => (item.key === key ? { ...item, minimized: true } : item)));
          if (action === "new") createScreen();
          if (action === "kill") killScreen(session);
        },
      };
    },
    [createScreen, killScreen, openScreen, windows],
  );

  const arrangeDesktop = useCallback(() => {
    sortDesktop.current = true;
    try {
      localStorage.setItem("taurissh.desktop.arrange", "1");
    } catch {
      /* 忽略 */
    }
    if (isMobile) {
      // 手机上图标本来就按名称流式排列，只需刷新列表
      message.success("桌面图标已自动排列");
      return;
    }
    const sorted = [...desktopEntries].sort((a, b) => {
      const aDir = (a.type === "shortcut" ? a.targetType : a.type) === "directory" ? 0 : 1;
      const bDir = (b.type === "shortcut" ? b.targetType : b.type) === "directory" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    const positions = defaultIconPositions(buildIconKeys(sorted), desktopSize.width, desktopSize.height);
    setDesktopEntries(sorted);
    iconPositionsRef.current = positions;
    setIconPositions(positions);
    void saveIconLayout(positions);
    message.success("桌面图标已自动排列");
  }, [desktopEntries, desktopSize.height, desktopSize.width, isMobile, message, saveIconLayout]);

  const desktopMenuOptions = useMemo(
    () => ({
      desktop: true,
      onOpenTerminal: () => openApp("terminal", { title: "终端" }),
      onArrange: arrangeDesktop,
    }),
    [arrangeDesktop, openApp],
  );

  const openBackgroundMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!desktopDir) {
        message.info("桌面目录尚未加载完成");
        return;
      }
      const items = fileActions.backgroundMenuItems(desktopDir, desktopMenuOptions);
      menu.open(event, items, (key) => {
        void fileActions.handleBackgroundAction(key, desktopDir, desktopMenuOptions);
      });
    },
    [desktopDir, desktopMenuOptions, fileActions, menu, message],
  );

  const openEntryMenu = useCallback(
    (event: React.MouseEvent, entry: RemoteFile) => {
      event.preventDefault();
      event.stopPropagation();
      const items = fileActions.entryMenuItems([entry], { desktop: true });
      menu.open(event, items, (key) => {
        void fileActions.handleEntryAction(key, [entry], { desktop: true });
      });
    },
    [fileActions, menu],
  );

  const openAppMenu = useCallback(
    (event: React.MouseEvent, app: AppId) => {
      event.preventDefault();
      event.stopPropagation();
      const existing = [...windows].reverse().find((item) => item.app === app);
      menu.open(
        event,
        [
          { key: "open", label: "打开" },
          { key: "minimize", label: "最小化", disabled: !existing || existing.minimized },
          { key: "close", label: "关闭窗口", disabled: !existing },
        ],
        (key) => {
          if (key === "open") openApp(app);
          if (key === "minimize" && existing) {
            setWindows((list) => list.map((item) => (item.key === existing.key ? { ...item, minimized: true } : item)));
          }
          if (key === "close" && existing) closeWindow(existing.key);
        },
      );
    },
    [closeWindow, menu, openApp, windows],
  );

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
        return <TaskManagerView connectionId={connection.id} />;
      case "firewall":
        return <FirewallView connectionId={connection.id} sshPort={connection.port} />;
      case "sources":
        return <MirrorView connectionId={connection.id} />;
      case "systemtime":
        return <SystemTimeView connectionId={connection.id} />;
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

  const minimizedWindows = windows.filter((win) => win.minimized);
  const visibleWindows = windows.filter((win) => !win.minimized);
  const activeKey = [...visibleWindows].sort((a, b) => b.z - a.z)[0]?.key;
  const minimizedMenu = (key: string) => ({
    items: [
      { key: "restore", label: "恢复窗口" },
      { key: "close", label: "关闭窗口", danger: true },
    ],
    onClick: ({ key: action }: { key: string }) => {
      if (action === "restore") focusWindow(key);
      if (action === "close") closeWindow(key);
    },
  });

  // 手机上图标改为网格流式排版，不写入绝对坐标，避免覆盖桌面端布局
  const iconStyle = (key: string) =>
    isMobile
      ? undefined
      : {
          left: iconPositions[key]?.x ?? ICON_MARGIN,
          top: iconPositions[key]?.y ?? ICON_MARGIN,
        };

  return (
    <RuntimeContext.Provider value={runtime}>
      <div className={"os-shell" + (isMobile ? " is-mobile" : "")}>
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
            <Tooltip title={"主题：" + (mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色")}>
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

        <main
          className="os-desktop"
          ref={(element) => { desktopRef.current = element; }}
          onPointerDown={() => setStartOpen(false)}
          onContextMenu={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest(".os-window,.os-icon,.os-start,.os-taskbar")) return;
            openBackgroundMenu(event);
          }}
        >
          <div className={"os-icons" + (isMobile ? " is-mobile" : "")}>
            {DESKTOP_APPS.map((app) => {
              const key = appIconKey(app);
              return (
                <button
                  key={key}
                  type="button"
                  className={"os-icon" + (draggingIcon === key ? " is-dragging" : "")}
                  style={iconStyle(key)}
                  onClick={() => {
                    if (suppressIconClick.current) return;
                    openApp(app);
                  }}
                  onPointerDown={(event) => beginIconDrag(event, key)}
                  onContextMenu={(event) => openAppMenu(event, app)}
                  onDragStart={(event) => event.preventDefault()}
                >
                  <span className="os-icon-tile" style={{ background: APPS[app].background }}>
                    {APPS[app].icon}
                  </span>
                  <span className="os-icon-label">{APPS[app].label}</span>
                </button>
              );
            })}
            {desktopEntries.map((entry) => {
              const key = entryIconKey(entry.path);
              const directory = (entry.type === "shortcut" ? entry.targetType : entry.type) === "directory";
              const shortcut = entry.type === "shortcut";
              const background = shortcut
                ? "linear-gradient(135deg,#6d28d9,#a78bfa)"
                : directory
                  ? "linear-gradient(135deg,#f59e0b,#fbbf24)"
                  : "linear-gradient(135deg,#334155,#64748b)";
              return (
                <button
                  key={key}
                  type="button"
                  className={"os-icon os-desktop-entry" + (draggingIcon === key ? " is-dragging" : "")}
                  style={iconStyle(key)}
                  title={shortcut ? entry.target : entry.path}
                  onClick={() => {
                    if (suppressIconClick.current) return;
                    void fileActions.handleEntryAction("open", [entry], { desktop: true });
                  }}
                  onPointerDown={(event) => beginIconDrag(event, key)}
                  onContextMenu={(event) => openEntryMenu(event, entry)}
                  onDragStart={(event) => event.preventDefault()}
                >
                  <span className="os-icon-tile" style={{ background }}>
                    {directory ? <FolderOpenOutlined /> : <FileTextOutlined />}
                    {shortcut ? <span className="os-icon-link" title="快捷方式" aria-label="快捷方式"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 9.6l3.2-3.2M5.2 10.8l-.7.7a2.1 2.1 0 0 1-3-3l2.3-2.3a2.1 2.1 0 0 1 3 0M10.8 5.2l.7-.7a2.1 2.1 0 1 1 3 3l-2.3 2.3a2.1 2.1 0 0 1-3 0" /></svg></span> : null}
                  </span>
                  <span className="os-icon-label">{entry.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={"os-icon" + (draggingIcon === appIconKey("connect") ? " is-dragging" : "")}
              style={iconStyle(appIconKey("connect"))}
              onClick={() => {
                if (suppressIconClick.current) return;
                props.onNewConnection();
              }}
              onPointerDown={(event) => beginIconDrag(event, appIconKey("connect"))}
              onDragStart={(event) => event.preventDefault()}
            >
              <span className="os-icon-tile" style={{ background: APPS.connect.background }}>
                {APPS.connect.icon}
              </span>
              <span className="os-icon-label">{APPS.connect.label}</span>
            </button>
          </div>
          {desktopLoading && !desktopEntries.length ? <div className="os-desktop-loading">正在加载远程桌面...</div> : null}
          {desktopError ? <div className="os-desktop-error">桌面加载失败：{desktopError}</div> : null}

          {visibleWindows.map((win) => (
            <WindowFrame
              key={win.key}
              win={win}
              active={win.key === activeKey}
              hidden={win.minimized}
              bounds={{ width: desktopSize.width, height: desktopSize.height }}
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
              <div className="os-start-brand">
                <span className="os-brand-badge">T</span>
                <div>
                  <strong>TauriSSH</strong>
                  <small>服务器工作台 · 应用菜单</small>
                </div>
              </div>
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

        <footer className={"os-taskbar" + (isMobile ? " is-mobile" : "")}>
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
          <div className="os-tasks" aria-label="最小化的窗口">
            {minimizedWindows.map((task) => (
              <Dropdown key={task.key} trigger={["contextMenu"]} menu={minimizedMenu(task.key)}>
                <button
                  type="button"
                  className="os-task"
                  title={task.title + " · 点击恢复"}
                  onClick={() => focusWindow(task.key)}
                >
                  <span className="os-task-icon" style={{ background: APPS[task.app].background }}>
                    {APPS[task.app].icon}
                  </span>
                  <span className="os-task-label">{task.title}</span>
                </button>
              </Dropdown>
            ))}
          </div>
          <div className="os-dock" aria-label="后台会话">
            {screens.map((session) => {
              const key = screenWindowKey(session.name);
              const window = windows.find((item) => item.key === key);
              const active = Boolean(window && !window.minimized);
              return (
                <Dropdown key={session.name} trigger={["contextMenu"]} menu={screenMenu(session)}>
                  <Tooltip title={session.label + " · 点击" + (active ? "最小化" : "打开") + "，右键管理"}>
                    <button
                      type="button"
                      className={"os-dock-screen" + (active ? " is-active" : "") + (window?.minimized ? " is-min" : "")}
                      onClick={() => toggleScreen(session)}
                    >
                      {screenBadge(session.label)}
                    </button>
                  </Tooltip>
                </Dropdown>
              );
            })}
            <Tooltip title="新建 Screen 会话">
              <button type="button" className="os-dock-new" onClick={createScreen}>
                <PlusOutlined />
              </button>
            </Tooltip>
          </div>
        </footer>
        <FileActionProgress progress={fileActions.progress} />
        {menu.node}
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
