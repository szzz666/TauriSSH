import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { terminal as terminalApi } from "../api";
import { terminalThemes, useTheme } from "../theme";

export interface TerminalHandle {
  focus: () => void;
  fit: () => void;
  write: (text: string) => void;
  clear: () => void;
  fontSize: () => number;
  setFontSize: (size: number) => void;
}

interface TerminalViewProps {
  termId: string;
  connectionId: string | null;
  screenName?: string;
  fontSize: number;
  onReady?: () => void;
  onClosed?: () => void;
  onError?: (message: string) => void;
  readOnly?: boolean;
}

/** 与 Rust 侧 sanitize_event_name 保持一致：Tauri 事件名只允许字母数字与 -/:_。 */
export function sanitizeEventName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9\-/:\_]/g, "_");
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** xterm 终端视图：Rust 侧通过事件推送 base64 字节流，避免 UTF-8 多字节被截断。 */
const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView(props, ref) {
  const { termId, connectionId, screenName, fontSize, onReady, onClosed, onError, readOnly } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { resolved } = useTheme();
  const closedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fit: () => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term && connectionId) void terminalApi.resize(termId, term.cols, term.rows);
      } catch {
        /* 容器尚未布局时忽略 */
      }
    },
    write: (text: string) => termRef.current?.writeln(text),
    clear: () => termRef.current?.clear(),
    fontSize: () => termRef.current?.options.fontSize ?? fontSize,
    setFontSize: (size: number) => {
      if (!termRef.current) return;
      termRef.current.options.fontSize = size;
      try {
        fitRef.current?.fit();
      } catch {
        /* 忽略 */
      }
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !connectionId) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Consolas, "SFMono-Regular", "Liberation Mono", monospace',
      fontSize,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: terminalThemes[resolved],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    closedRef.current = false;

    const offData = term.onData((data) => {
      if (readOnly) return;
      void terminalApi.input(termId, data).catch(() => {
        /* 连接已断开时忽略 */
      });
    });

    let unlisten: UnlistenFn | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const bootstrap = async () => {
      // 必须先注册监听再打开终端，否则会丢掉 shell 提示符等首批输出
      unlisten = await listen<{ kind: string; data?: string | null; code?: string | null }>(
        `terminal-${sanitizeEventName(termId)}`,
        (event) => {
          const payload = event.payload;
          if (payload.kind === "output" && payload.data) {
            term.write(decodeBase64(payload.data));
          } else if (payload.kind === "status" && payload.data === "closed") {
            term.writeln("\r\n\x1b[33m[会话已结束]\x1b[0m");
            closedRef.current = true;
            onClosed?.();
          }
        },
      );

      try {
        const opening = screenName
          ? terminalApi.attachScreen(connectionId, termId, screenName)
          : terminalApi.open(connectionId, termId, undefined, term.cols, term.rows);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("打开终端超时（10 秒）")), 10_000),
        );
        await Promise.race([opening, timeout]);
        onReady?.();
      } catch (error) {
        onError?.((error as Error).message);
        term.writeln(`\r\n\x1b[31m连接失败：${(error as Error).message}\x1b[0m`);
        return;
      }

      try {
        fit.fit();
        void terminalApi.resize(termId, term.cols, term.rows);
      } catch {
        /* 忽略 */
      }
      term.focus();
    };

    void bootstrap();

    resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        void terminalApi.resize(termId, term.cols, term.rows);
      } catch {
        /* 忽略 */
      }
    });
    resizeObserver.observe(host);

    return () => {
      offData.dispose();
      unlisten?.();
      resizeObserver?.disconnect();
      void terminalApi.close(termId).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, connectionId, screenName]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalThemes[resolved];
  }, [resolved]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* 忽略 */
    }
  }, [fontSize]);

  return <div ref={hostRef} className="terminal-host" />;
});

export default TerminalView;
