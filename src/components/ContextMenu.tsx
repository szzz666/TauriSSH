import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Menu } from "antd";
import type { MenuProps } from "antd";

export type ContextMenuItem = NonNullable<MenuProps["items"]>[number];

export interface ContextMenuRequest {
  x: number;
  y: number;
  items: MenuProps["items"];
  onSelect?: (key: string) => void;
}

interface EventLike {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * 通用右键菜单：任意位置弹出，自动避开视口边缘，支持 Ant Design 子菜单。
 * 用法：const menu = useContextMenu(); ... menu.open(event, items, onSelect); 渲染 menu.node。
 */
export function useContextMenu() {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);

  const open = useCallback(
    (event: ReactMouseEvent | EventLike, items: MenuProps["items"], onSelect?: (key: string) => void) => {
      event.preventDefault();
      event.stopPropagation();
      if (!items || items.length === 0) return;
      setRequest({ x: event.clientX, y: event.clientY, items, onSelect });
    },
    [],
  );

  const close = useCallback(() => setRequest(null), []);

  const node = request ? (
    <ContextMenuLayer
      request={request}
      onClose={close}
      onSelect={(key) => {
        request.onSelect?.(key);
        close();
      }}
    />
  ) : null;

  return { open, close, node, visible: request !== null };
}

function ContextMenuLayer({
  request,
  onClose,
  onSelect,
}: {
  request: ContextMenuRequest;
  onClose: () => void;
  onSelect: (key: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: request.x, y: request.y });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    setPosition({
      x: Math.min(Math.max(8, request.x), maxX),
      y: Math.min(Math.max(8, request.y), maxY),
    });
  }, [request.x, request.y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onViewportChange = () => onClose();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="ctx-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={panelRef}
        className="ctx-panel"
        style={{ left: position.x, top: position.y }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Menu
          mode="vertical"
          selectable={false}
          items={request.items}
          onClick={({ key }) => onSelect(key)}
        />
      </div>
    </div>,
    document.body,
  );
}
