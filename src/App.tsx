import { useCallback, useEffect, useState } from "react";
import { App as AntApp, Button, Dropdown, Empty, Layout, List, Space, Tooltip, Typography } from "antd";
import { ApiOutlined, CloudServerOutlined, DeleteOutlined, PlusOutlined, SunOutlined, MoonOutlined } from "@ant-design/icons";
import { ssh, type ConnectionInfo } from "./api";
import { useTheme } from "./theme";
import { formatHost, useStore, type SavedConnection } from "./store";
import ConnectionModal from "./components/ConnectionModal";
import DesktopShell from "./desktop/DesktopShell";

const { Header, Sider, Content } = Layout;

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

/** 应用入口：未连接时展示连接器，连接后进入桌面 / 手机主屏。 */
export default function App() {
  const { message, modal } = AntApp.useApp();
  const { mode, cycle } = useTheme();
  const settings = useStore((state) => state.settings);
  const setSettings = useStore((state) => state.setSettings);
  const connections = useStore((state) => state.connections);
  const removeConnection = useStore((state) => state.removeConnection);
  const record = useStore((state) => state.record);

  const [active, setActive] = useState<ConnectionInfo | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [editing, setEditing] = useState<SavedConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    void (async () => {
      try {
        const result = await ssh.list();
        if (result.connections.length > 0) {
          setActive(result.connections[0]);
          setConnected(true);
          return;
        }
      } catch {
        /* 首次启动无会话 */
      }
      // 联调自动连接：仅开发构建生效，public/dev-profile.json 提供连接参数
      if (import.meta.env.DEV) {
        try {
          const response = await fetch("/dev-profile.json", { cache: "no-store" });
          if (!response.ok) return;
          const profile = (await response.json()) as Parameters<typeof ssh.connect>[0];
          const created = await ssh.connect(profile);
          setActive(created.connection);
          setConnected(true);
        } catch {
          /* 无联调配置时忽略 */
        }
      }
    })();
  }, []);

  const onConnected = useCallback(
    (connectionId: string, label: string) => {
      void (async () => {
        try {
          const status = await ssh.status(connectionId);
          setActive(status.connection);
          setConnected(true);
          message.success(`已连接到 ${label}`);
        } catch (err) {
          message.error((err as Error).message);
        }
      })();
    },
    [message],
  );

  const disconnect = useCallback(() => {
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
  }, [active, message, modal, record, settings.confirm]);

  const reboot = useCallback(() => {
    if (!active) return;
    void (async () => {
      try {
        await ssh.reboot(active.id);
        record("REBOOT", formatHost(active.host, active.port));
        message.success("重启命令已下发");
        setConnected(false);
      } catch (err) {
        message.error((err as Error).message);
      }
    })();
  }, [active, message, record]);

  const openNewConnection = () => {
    setEditing(null);
    setConnectOpen(true);
  };

  if (active) {
    return (
      <>
        <DesktopShell
          connection={active}
          isMobile={isMobile}
          fontSize={settings.font}
          setFontSize={(font) => setSettings({ font })}
          connected={connected}
          setConnected={setConnected}
          onDisconnect={disconnect}
          onReboot={reboot}
          onNewConnection={openNewConnection}
          record={record}
          showWelcome={settings.showWelcome}
        />
        <ConnectionModal
          open={connectOpen}
          editing={editing}
          onClose={() => setConnectOpen(false)}
          onConnected={onConnected}
        />
      </>
    );
  }

  return (
    <Layout className="app-shell" style={{ background: "var(--app-bg)" }}>
      <Header className="app-header" style={{ height: "auto", lineHeight: "normal" }}>
        <div className="app-brand">
          <span className="os-brand-badge">T</span>
          <span className="brand-text">TauriSSH</span>
        </div>
        <div style={{ flex: 1 }} />
        <Space>
          <Tooltip title={`界面主题：${mode === "system" ? "自动" : mode === "light" ? "浅色" : "暗色"}`}>
            <Button
              type="text"
              onClick={cycle}
              icon={mode === "dark" ? <MoonOutlined /> : <SunOutlined />}
            />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openNewConnection}>
            新建连接
          </Button>
        </Space>
      </Header>

      <Layout className="app-body">
        {!isMobile ? (
          <Sider
            width={230}
            theme="light"
            style={{ borderRight: "1px solid var(--app-border)", background: "transparent", padding: 12 }}
          >
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
                  onClick={() => {
                    setEditing(item);
                    setConnectOpen(true);
                  }}
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
                    avatar={<CloudServerOutlined style={{ paddingTop: 6 }} />}
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
          </Sider>
        ) : null}

        <Content className="app-scroll" style={{ display: "grid", placeItems: "center" }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" style={{ maxWidth: 460 }}>
                <Typography.Title level={3} style={{ marginBottom: 0 }}>
                  安全远程工作台
                </Typography.Title>
                <Typography.Text type="secondary">
                  连接 Linux 主机后进入桌面工作区：终端、SFTP 文件管理、后台会话与资源监控都以窗口形式打开。
                </Typography.Text>
              </Space>
            }
          >
            <Space direction="vertical" size="middle" style={{ width: 300 }}>
              <Button type="primary" block size="large" icon={<PlusOutlined />} onClick={openNewConnection}>
                新建 SSH 连接
              </Button>
              {connections.length > 0 && isMobile ? (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: connections.map((item) => ({
                      key: item.id,
                      label: `${item.name || item.host} · ${item.username}`,
                    })),
                    onClick: ({ key }) => {
                      const saved = connections.find((item) => item.id === key);
                      if (saved) {
                        setEditing(saved);
                        setConnectOpen(true);
                      }
                    },
                  }}
                >
                  <Button block icon={<ApiOutlined />}>
                    使用已保存的连接
                  </Button>
                </Dropdown>
              ) : null}
            </Space>
          </Empty>
        </Content>
      </Layout>

      <ConnectionModal
        open={connectOpen}
        editing={editing}
        onClose={() => setConnectOpen(false)}
        onConnected={onConnected}
      />
    </Layout>
  );
}
