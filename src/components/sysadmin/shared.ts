import { useEffect, useRef, useState } from "react";

export function formatBytes(value?: number | null, fractionDigits?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let result = Math.abs(value);
  let index = 0;
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024;
    index += 1;
  }
  const sign = value < 0 ? "-" : "";
  if (index === 0) return `${sign}${Math.round(result)} B`;
  const digits = fractionDigits ?? (result < 10 ? 1 : 0);
  return `${sign}${result.toFixed(digits)} ${units[index]}`;
}

export function formatUptime(seconds?: number | null) {
  if (!seconds || seconds < 0) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

export function formatPercent(value?: number | null, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  return `${value.toFixed(digits)}%`;
}

export function formatRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond, bytesPerSecond < 10 * 1024 ? 1 : 0)}/s`;
}

/** 轮询执行异步任务：挂载即执行一次，组件卸载自动停止，避免请求堆叠。 */
export function usePolling(run: () => void | Promise<void>, intervalMs: number, enabled = true) {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        await runRef.current();
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);
}

/** 测量容器尺寸，供表格设置 scroll.y 与按可用宽度裁剪列。 */
export function useElementBox<T extends HTMLElement>(offset = 0) {
  const [element, setElement] = useState<T | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
    return () => observer.disconnect();
  }, [element]);

  return [setElement, { width: box.width, height: Math.max(140, box.height - offset) }] as const;
}

/** 测量容器高度，供 Ant Design 虚拟滚动表格设置 scroll.y。 */
export function useElementHeight<T extends HTMLElement>(offset = 0) {
  const [setElement, box] = useElementBox<T>(offset);
  return [setElement, box.height] as const;
}

/**
 * 按容器实际宽度判定是否使用紧凑表格。
 * 固定列宽的总和会超过窄窗口宽度，此时必须裁掉次要列，否则名称列会被挤成 0 宽。
 */
export function useCompactTable<T extends HTMLElement>(threshold = 700) {
  const [setElement, box] = useElementBox<T>(0);
  return [setElement, box.width > 0 && box.width < threshold] as const;
}
