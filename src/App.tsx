import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp, Avatar, Button, Card, Dropdown, Empty, Input, Layout, List,
  Menu, Segmented, Space, Switch, Tag, Tooltip, Typography,
} from "antd";
import {
  ApiOutlined, CloudServerOutlined, CodeOutlined, DashboardOutlined,
  DeleteOutlined, DisconnectOutlined, FolderOpenOutlined, HistoryOutlined,
  MenuOutlined, PlusOutlined, PoweroffOutlined, ReloadOutlined, SettingOutlined, SunOutlined, MoonOutlined,
} from "@ant-design/icons";
import { ssh, type ConnectionInfo, type ScreenSession } from "./api";
import { useTheme } from "./theme";
import { formatHost, useStore, type SavedConnection } from "./store";
import ConnectionModal from "./components/ConnectionModal";
import TerminalView, { type TerminalHandle } from "./components/TerminalView";
import FileManager from "./components/FileManager";
import EditorView from "./components/EditorView";
import MonitorView from "./components/MonitorView";
import ScreenPanel from "./components/ScreenPanel";
import HistoryView from "./components/HistoryView";

const { Header, Sider, Content } = Layout;

/**
 * 弹窗返回键保护：打开弹窗时压入一条历史记录，
 * 使 Android 返回键先关闭弹窗而不是直接退出应用。
 */
function useOverlayBackGuard(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    let handled = false;
    window.history.pushState({ taurisshOverlay: true }, "");
    const onPop = () => {
      handled = true;
      close();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!handled) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** 移动端判定：窄屏或触屏粗指针，与样式断点保持一致。 */
function useIsMobile() {
  const query = "(max-width: 767px), (hover: none) and (pointer: coarse) and (max-width: 1024px)";
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);
  return matches;
}

type ViewKey = "terminal" | "files" | "screen" | "monitor" | "history" | "settings";

const VIEW_META: Record<ViewKey, { label: string; icon: React.ReactNode }> = {
  terminal: { label: "终端", icon: <CodeOutlined /> },
  files: { label: "文件", icon: <FolderOpenOutlined /> },
  screen: { label: "后台", icon: <DashboardOutlined /> },
  monitor: { label: "监控", icon: <CloudServerOutlined /> },
  history: { label: "记录", icon: <HistoryOutlined /> },
  settings: { label: "设置", icon: <SettingOutlined /> },
};

export default function App() {
  const { message, modal } = AntApp.useApp();
  const { mode, cycle } = useTheme();
  const settings = useStore((state) => state.settings);
  const setSettings = useStore((state) => state.setSettings);
  const connections = useStore((state) => state.connections);
  const removeConnection = useStore((state) => state.removeConnection);
  const record = useStore((state) => state.record);

  const [active, setActive] = useState<ConnectionInfo | null>(null);
  const [view, setView] = useState<ViewKey>("terminal");
  const [connectOpen, setConnectOpen] = useState(false);
  const [editing, setEditing] = useState<SavedConnection | null>(null);
  const [fontSize, setFontSize] = useState(settings.font);
  const [screenWindows, setScreenWindows] = useState<ScreenSession[]>([]);
  const [activeScreen, setActiveScreen] = useState<string | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [filesPath, setFilesPath] = useState("/");
  const [connected, setConnected] = useState(false);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const termId = useMemo(() => `term-${crypto.randomUUID()}`, [active, activeScreen]);

  const isMobile = useIsMobile();
  useOverlayBackGuard(connectOpen, () => {
    setConnectOpen(false);
    setEditing(null);
  });

  useEffect(() => {
    void (async () => {
      try {
        const result = await ssh.list();
        if (result.connections.length > 0) {
          setActive(result.connections[0]);
          setConnected(true);
        }
      } catch {
        /* 首次启动无会话 */
      }
    })();
  }, []);

  const connect = async (saved: SavedConnection) => {
    setConnectOpen(true);
    setEditing(saved);
  };

  const onConnected = useCallback(
    (connectionId: string, label: string) => {
      void (async () => {
        try {
          const status = await ssh.status(connectionId);
          setActive(status.connection);
          setConnected(true);
          setView("terminal");
          message.success(`已连接到 ${label}`);
        } catch (err) {
          message.error((err as Error).message);
        }
      })();
    },
    [message],
  );

  const disconnect = () => {
    if (!active) return;
    const run = async () => {
      try {
        await ssh.disconnect(active.id);
      } catch {
        /* 忽略断开失败 */
      }
      record("DISCONNECT", formatHost(active.host, active.port));
      setActive(null);
      setConnected(false);
      setScreenWindows([]);
      setActiveScreen(null);
      setEditorPath(null);
      message.info("已断开连接");
    };
    if (settings.confirm) {
      modal.confirm({
        title: "断开当前连接？",
        content: "所有终端与文件操作将立即结束。",
        okText: "断开",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: run,
      });
    } else {
      void run();
    }
  };

  const reboot = () => {
    if (!active) return;
    modal.confirm({
      title: "重启远程服务器？",
      content: "服务器将立即重启，当前连接会中断。",
      okText: "重启",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await ssh.reboot(active.id);
          record("REBOOT", formatHost(active.host, active.port));
          message.success("重启命令已下发");
          setConnected(false);
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  const openScreen = (session: ScreenSession) => {
    setScreenWindows((prev) => (prev.some((item) => item.name === session.name) ? prev : [...prev, session]));
    setActiveScreen(session.name);
    setView("terminal");
  };

  const content = (() => {
    if (view === "history") return <HistoryView />;
    if (view === "settings") {
      return (
        <div className="scroll-y" style={{ maxWidth: 640 }}>
          <Card size="small" title="工作台偏好">
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <div>
                  <div>界面主题</div>
                  <Typography.Text type="secondary">切换浅色或深色显示</Typography.Text>
                </div>
                <Segmented
                  value={settings.theme}
                  onChange={(value) => setSettings({ theme: value as "system" | "light" | "dark" })}
                  options={[
                    { label: "跟随系统", value: "system" },
                    { label: "浅色", value: "light" },
                    { label: "深色", value: "dark" },
                  ]}
                />
              </Space>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <div>
                  <div>终端字号</div>
                  <Typography.Text type="secondary">基础终端显示字号（11 - 22）</Typography.Text>
                </div>
                <Space>
                  <Input
                    type="number"
                    min={11}
                    max={22}
                    value={fontSize}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (value >= 11 && value <= 22) {
                        setFontSize(value);
                        setSettings({ font: value });
                      }
                    }}
                    style={{ width: 80 }}
                  />
                  <span className="muted">{fontSize}px</span>
                </Space>
              </Space>
              {[
                { key: "showWelcome", label: "启动时显示欢迎页", hint: "打开应用时展示工作台简介" },
                { key: "autoOpenTerminal", label: "连接后自动打开终端", hint: "建立连接后直接进入终端视图" },
                { key: "reconnect", label: "自动重连", hint: "终端意外断开后自动尝试恢复" },
                { key: "screenAutoExit", label: "程序结束自动退出 Screen", hint: "关闭后程序结束会保留 Screen 并进入 shell" },
                { key: "confirm", label: "危险操作确认", hint: "删除、移动和断开前再次确认" },
                { key: "saveCredential", label: "保存连接密码", hint: "密码与私钥以明文保存在本机存储中" },
              ].map((item) => (
                <Space key={item.key} style={{ justifyContent: "space-between", width: "100%" }}>
                  <div>
                    <div>{item.label}</div>
                    <Typography.Text type="secondary">{item.hint}</Typography.Text>
                  </div>
                  <Switch
                    checked={Boolean(settings[item.key as keyof typeof settings])}
                    onChange={(value) => setSettings({ [item.key]: value } as never)}
                  />
                </Space>
              ))}
            </Space>
          </Card>
        </div>
      );
    }

    if (!active) {
      return (
        <div className="scroll-y">
          <Empty
            description={
              <Space direction="vertical">
                <Typography.Title level={4} style={{ marginBottom: 0 }}>
                  安全远程工作台
                </Typography.Title>
                <Typography.Text type="secondary">
                  连接 Linux 主机，在桌面与手机上使用终端、SFTP 文件管理和系统监控。
                </Typography.Text>
              </Space>
            }
          >
            <Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setConnectOpen(true); }}>
                新建 SSH 连接
              </Button>
              <Button onClick={() => setView("settings")}>工作台设置</Button>
            </Space>
          </Empty>
        </div>
      );
    }

    if (view === "terminal") {
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {screenWindows.length > 0 ? (
            <div style={{ padding: "8px 12px 0" }}>
              <Segmented
                value={activeScreen ?? "__main__"}
                onChange={(value) => setActiveScreen(value === "__main__" ? null : String(value))}
                options={[
                  { label: "主终端", value: "__main__" },
                  ...screenWindows.map((item) => ({ label: item.label, value: item.name })),
                ]}
              />
            </div>
          ) : null}
          <div style={{ padding: "8px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Tag color={connected ? "green" : "default"}>{connected ? "已连接" : "未连接"}</Tag>
            <Tag>{active.label}</Tag>
            <Button size="small" onClick={() => terminalRef.current?.clear()}>清屏</Button>
            <Button size="small" onClick={() => void navigator.clipboard.writeText("")}>复制</Button>
            <Button size="small" onClick={() => { const next = Math.max(11, fontSize - 1); setFontSize(next); setSettings({ font: next }); }}>小</Button>
            <Button size="small" onClick={() => { const next = Math.min(22, fontSize + 1); setFontSize(next); setSettings({ font: next }); }}>大</Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => setConnected(true)}>重连</Button>
          </div>
          <div className="terminal-pane">
            <TerminalView
              key={termId}
              ref={terminalRef}
              termId={termId}
              connectionId={active.id}
              screenName={activeScreen ?? undefined}
              fontSize={fontSize}
              onReady={() => setConnected(true)}
              onClosed={() => setConnected(false)}
              onError={(msg) => message.error(msg)}
            />
          </div>
        </div>
      );
    }

    if (view === "files") {
      return editorPath ? (
        <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
          <Button onClick={() => setEditorPath(null)}>返回文件列表</Button>
          <div style={{ flex: 1, minHeight: 0 }}>
            <EditorView connectionId={active.id} path={editorPath} onSaved={() => setFilesPath(filesPath)} />
          </div>
        </div>
      ) : (
        <FileManager
          key={active.id}
          connectionId={active.id}
          initialPath={filesPath}
        />
      );
    }

    if (view === "screen") {
      return <ScreenPanel connectionId={active.id} onOpen={openScreen} />;
    }

    if (view === "monitor") {
      return <MonitorView connectionId={active.id} />;
    }

    return null;
  })();

  const connectionMenu = (
    <Menu
      items={
        connections.length === 0
          ? [{ key: "empty", label: "暂无保存的连接", disabled: true }]
          : connections.map((item) => ({
              key: item.id,
              label: (
                <Space>
                  <CloudServerOutlined />
                  <span>{item.name || `${item.username}@${formatHost(item.host, item.port)}`}</span>
                </Space>
              ),
            }))
      }
      onClick={({ key }) => {
        const saved = connections.find((item) => item.id === key);
        if (saved) void connect(saved);
      }}
    />
  );

  return (
    <AntApp>
      <Layout className="app-shell">
        <Header className="app-header" style={{ height: "auto", lineHeight: "normal" }}>
          <div className="app-brand">
            <Avatar shape="square" size={30} style={{ background: "#1677ff" }}>
              T
            </Avatar>
            <span className="brand-text">TauriSSH</span>
          </div>
          <div style={{ flex: 1 }} />
          <Space>
            {active ? (
              <Tag color="green" className="desktop-only">
                {active.label} · {formatHost(active.host, active.port)}
              </Tag>
            ) : null}
            <Tooltip title={`界面主题：${mode === "system" ? "自动" : mode === "light" ? "浅色" : "暗色"}`}>
              <Button type="text" onClick={cycle} icon={mode === "dark" ? <MoonOutlined /> : <SunOutlined />} />
            </Tooltip>
            <Dropdown menu={{ items: [] }} dropdownRender={() => connectionMenu}>
              <Button icon={<ApiOutlined />} className="desktop-only">
                连接
              </Button>
            </Dropdown>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setConnectOpen(true);
              }}
            >
              新建
            </Button>
            {active ? (
              <Dropdown
                menu={{
                  items: [
                    { key: "disconnect", label: "断开连接", icon: <DisconnectOutlined /> },
                    { key: "reboot", label: "重启服务器", icon: <PoweroffOutlined />, danger: true },
                  ],
                  onClick: ({ key }) => {
                    if (key === "disconnect") disconnect();
                    if (key === "reboot") reboot();
                  },
                }}
              >
                <Button icon={<MenuOutlined />} />
              </Dropdown>
            ) : null}
          </Space>
        </Header>

        <Layout className="app-body">
          {!isMobile ? (
            <Sider width={190} theme="light" style={{ borderRight: "1px solid var(--app-border)", background: "transparent" }}>
              <Menu
                mode="inline"
                selectedKeys={[view]}
                style={{ borderInlineEnd: "none", background: "transparent" }}
                items={(Object.keys(VIEW_META) as ViewKey[]).map((key) => ({
                  key,
                  icon: VIEW_META[key].icon,
                  label: VIEW_META[key].label,
                  disabled: !active && key !== "settings" && key !== "history",
                }))}
                onClick={({ key }) => setView(key as ViewKey)}
              />
              <div style={{ padding: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已保存连接
                </Typography.Text>
                <List
                  size="small"
                  dataSource={connections}
                  locale={{ emptyText: "暂无保存的连接" }}
                  renderItem={(item) => (
                    <List.Item
                      style={{ paddingInline: 0, cursor: "pointer" }}
                      onClick={() => void connect(item)}
                      actions={[
                        <Tooltip title="删除" key="del">
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeConnection(item.id);
                              message.success("连接配置已删除");
                            }}
                          />
                        </Tooltip>,
                      ]}
                    >
                      <List.Item.Meta
                        title={<Typography.Text ellipsis>{item.name || item.host}</Typography.Text>}
                        description={
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {item.username}@{formatHost(item.host, item.port)}
                          </Typography.Text>
                        }
                      />
                    </List.Item>
                  )}
                />
              </div>
            </Sider>
          ) : null}

          <Layout className="app-main">
            <Content className="app-scroll" style={{ display: "flex", flexDirection: "column" }}>
              {content}
            </Content>
            <div className="mobile-tabbar">
              <Segmented
                block
                value={view}
                onChange={(value) => setView(value as ViewKey)}
                options={(Object.keys(VIEW_META) as ViewKey[]).map((key) => ({
                  value: key,
                  label: (
                    <Space direction="vertical" size={0} style={{ padding: "4px 2px" }}>
                      {VIEW_META[key].icon}
                      <span style={{ fontSize: 10 }}>{VIEW_META[key].label}</span>
                    </Space>
                  ),
                }))}
              />
            </div>
          </Layout>
        </Layout>

        <ConnectionModal
          open={connectOpen}
          editing={editing}
          onClose={() => setConnectOpen(false)}
          onConnected={onConnected}
        />
      </Layout>
    </AntApp>
  );
}
