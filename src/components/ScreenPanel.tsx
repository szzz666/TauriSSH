import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Input, List, Space, Switch, Tag, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { screen, type ScreenSession } from "../api";
import { useStore } from "../store";

interface Props {
  connectionId: string;
  onOpen: (session: ScreenSession) => void;
}

/** GNU Screen 后台会话管理：4 秒轮询列表，支持新建、挂载、退出。 */
export default function ScreenPanel({ connectionId, onOpen }: Props) {
  const { message, modal } = App.useApp();
  const [sessions, setSessions] = useState<ScreenSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const screenAutoExit = useStore((state) => state.settings.screenAutoExit);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await screen.list(connectionId);
      setSessions(result.sessions);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const create = () => {
    let label = "";
    let path = "";
    let autoExit = screenAutoExit;
    setCreating(true);
    modal.confirm({
      title: "新建 Screen 会话",
      width: 480,
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input placeholder="会话名称（可选）" onChange={(event) => { label = event.target.value; }} />
          <Input placeholder="运行文件路径（可选，绝对路径）" onChange={(event) => { path = event.target.value; }} />
          <Space>
            <Switch defaultChecked={autoExit} onChange={(value) => { autoExit = value; }} />
            <Typography.Text type="secondary">程序结束后自动退出会话</Typography.Text>
          </Space>
        </Space>
      ),
      okText: "创建",
      cancelText: "取消",
      onOk: async () => {
        try {
          await screen.create(connectionId, {
            label: label.trim(),
            path: path.trim(),
            autoExit,
          });
          message.success("Screen 会话已创建");
          await load();
        } catch (err) {
          message.error((err as Error).message);
          return Promise.reject(err);
        } finally {
          setCreating(false);
        }
        return undefined;
      },
      onCancel: () => setCreating(false),
    });
  };

  const kill = (session: ScreenSession) => {
    modal.confirm({
      title: `退出会话 ${session.label}？`,
      content: "该操作会终止远程 Screen 会话及其中的程序。",
      okText: "退出会话",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await screen.create(connectionId, { action: "kill", name: session.name });
          message.success("会话已退出");
          await load();
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={create} loading={creating}>
          新建 Screen
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </Space>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {sessions.length === 0 ? (
          <Empty description="暂无后台会话" />
        ) : (
          <List
            dataSource={sessions}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" onClick={() => onOpen(item)}>
                    打开
                  </Button>,
                  <Button key="kill" type="link" danger onClick={() => kill(item)}>
                    退出
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      {item.label}
                      <Tag color="blue">{item.name}</Tag>
                    </Space>
                  }
                  description={item.path || "独立 Screen 终端"}
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );
}
