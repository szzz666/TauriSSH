import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { CloseOutlined, MinusOutlined, PushpinOutlined, BorderOutlined } from "@ant-design/icons";

export interface FrameWindow {
  key: string;
  title: string;
  subtitle?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  accent?: string;
}

interface Props {
  win: FrameWindow;
  active: boolean;
  hidden: boolean;
  children: ReactNode;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
  bounds: { width: number; height: number };
  toolbar?: ReactNode;
}

const MIN_WIDTH = 420;
const MIN_HEIGHT = 280;

/** 可拖拽 / 可缩放的窗口外壳，行为对齐桌面操作系统的窗口管理器。 */
export default function WindowFrame({
  win, active, hidden, children, onFocus, onClose, onMinimize, onToggleMaximize,
  onMove, onResize, bounds, toolbar,
}: Props) {
  const dragRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);
  const resizeRef = useRef<{ pointerX: number; pointerY: number; startW: number; startH: number } | null>(null);

  const clampX = useCallback(
    (value: number) => Math.min(Math.max(0, value), Math.max(0, bounds.width - 160)),
    [bounds.width],
  );
  const clampY = useCallback(
    (value: number) => Math.min(Math.max(0, value), Math.max(0, bounds.height - 40)),
    [bounds.height],
  );

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (dragRef.current && !win.maximized) {
        const dx = event.clientX - dragRef.current.pointerX;
        const dy = event.clientY - dragRef.current.pointerY;
        onMove(clampX(dragRef.current.startX + dx), clampY(dragRef.current.startY + dy));
      }
      if (resizeRef.current && !win.maximized) {
        const dx = event.clientX - resizeRef.current.pointerX;
        const dy = event.clientY - resizeRef.current.pointerY;
        onResize(
          Math.min(bounds.width, Math.max(MIN_WIDTH, resizeRef.current.startW + dx)),
          Math.min(bounds.height, Math.max(MIN_HEIGHT, resizeRef.current.startH + dy)),
        );
      }
    };
    const handleUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [clampX, clampY, onMove, onResize, win.maximized]);

  const style = win.maximized
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex: win.z }
    : {
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.height,
        zIndex: win.z,
      };

  return (
    <section
      className={`os-window${active ? " is-active" : ""}${win.maximized ? " is-maximized" : ""}`}
      style={{ ...style, display: hidden ? "none" : undefined }}
      onPointerDown={onFocus}
      role="dialog"
      aria-label={win.title}
    >
      <header
        className="os-window-bar"
        onPointerDown={(event) => {
          if (win.maximized) return;
          if ((event.target as HTMLElement).closest("button")) return;
          dragRef.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            startX: win.x,
            startY: win.y,
          };
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={() => onToggleMaximize()}
      >
        <span className="os-window-dot" style={{ background: win.accent ?? "#1677ff" }} />
        <div className="os-window-title">
          <span>{win.title}</span>
          {win.subtitle ? <small>{win.subtitle}</small> : null}
        </div>
        {toolbar ? <div className="os-window-toolbar">{toolbar}</div> : null}
        <div className="os-window-actions">
          <Tooltip title="最小化">
            <Button type="text" size="small" icon={<MinusOutlined />} onClick={onMinimize} />
          </Tooltip>
          <Tooltip title={win.maximized ? "还原" : "最大化"}>
            <Button
              type="text"
              size="small"
              icon={win.maximized ? <PushpinOutlined /> : <BorderOutlined />}
              onClick={onToggleMaximize}
            />
          </Tooltip>
          <Tooltip title="关闭">
            <Button type="text" size="small" danger icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </div>
      </header>
      <div className="os-window-body">{children}</div>
      {!win.maximized ? (
        <span
          className="os-window-resize"
          onPointerDown={(event) => {
            event.stopPropagation();
            resizeRef.current = {
              pointerX: event.clientX,
              pointerY: event.clientY,
              startW: win.width,
              startH: win.height,
            };
            document.body.style.userSelect = "none";
            document.body.style.cursor = "nwse-resize";
          }}
        />
      ) : null}
    </section>
  );
}
