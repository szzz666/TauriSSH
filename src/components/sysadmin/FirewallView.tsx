import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, App, Button, Card, Col, Collapse, Descriptions, Empty, Input, Row, Select, Space,
  Spin, Table, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, ReloadOutlined,
  SafetyCertificateOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { sysadmin, type FirewallRule, type FirewallStatus } from "../../api";
import { useCompactTable } from "./shared";

interface Props {
  connectionId: string;
  sshPort?: number;
}

type RuleRow = FirewallRule & { key: string };

const BACKEND_LABEL: Record<string, string> = {
  ufw: "UFW（Ubuntu / Debian）",
  firewalld: "firewalld（CentOS / RHEL）",
  none: "未检测到防火墙",
};

function normalizeIncoming(value: string) {
  return (value || "").replace(/\(.*\)/, "").trim();
}

export default function FirewallView({ connectionId, sshPort = 22 }: Props) {
  const { message, modal } = App.useApp();
  const [measureRef, narrow] = useCompactTable<HTMLDivElement>(620);
  const [status, setStatus] = useState<FirewallStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState("deny");
  const [spec, setSpec] = useState("22/tcp");
  const [action, setAction] = useState<"allow" | "deny" | "limit">("allow");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sysadmin.firewallStatus(connectionId);
      setStatus(result);
      const incomingValue = normalizeIncoming(result.defaultIncoming).toLowerCase();
      setPolicy(incomingValue === "allow" || incomingValue === "accept" ? "allow" : incomingValue === "reject" ? "reject" : "deny");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, request: Parameters<typeof sysadmin.firewallAction>[1]) => {
      setBusy(label);
      try {
        const result = await sysadmin.firewallAction(connectionId, request);
        setStatus(result.status);
        message.success(result.output || "防火墙已更新");
        setError(null);
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [connectionId, message],
  );

  const rules = useMemo<RuleRow[]>(() => {
    if (!status) return [];
    if (status.rules.length) {
      return status.rules.map((rule, index) => ({ ...rule, key: `${rule.to}-${rule.action}-${rule.from}-${index}` }));
    }
    return [
      ...status.services.map((service, index) => ({
        key: `service-${service}-${index}`,
        to: service,
        action: "ALLOW IN",
        from: "Anywhere",
        v6: false,
      })),
      ...status.ports.map((port, index) => ({
        key: `port-${port}-${index}`,
        to: port,
        action: "ALLOW IN",
        from: "Anywhere",
        v6: false,
      })),
    ];
  }, [status]);

  const isFirewalld = status?.backend === "firewalld";
  const canWrite = Boolean(status?.canWrite);
  const incoming = normalizeIncoming(status?.defaultIncoming ?? "");
  const incomingLower = incoming.toLowerCase();
  const incomingSafe = ["deny", "reject", "drop"].includes(incomingLower) || (isFirewalld && !incoming);

  const quick = [
    { label: "SSH", spec: "22/tcp", key: "ssh" },
    ...(sshPort !== 22 ? [{ label: "当前 SSH", spec: sshPort + "/tcp", key: "ssh-current" }] : []),
    { label: "HTTP", spec: "80/tcp", key: "http" },
    { label: "HTTPS", spec: "443/tcp", key: "https" },
  ];

  const hasRule = (item: string) =>
    rules.some((rule) => rule.to === item || rule.to.startsWith(`${item.split("/")[0]}/`));

  const columns: ColumnsType<RuleRow> = [
    {
      title: "目标",
      dataIndex: "to",
      ellipsis: true,
      render: (value: string) => <Typography.Text code ellipsis>{value}</Typography.Text>,
    },
    {
      title: "动作",
      dataIndex: "action",
      width: narrow ? 108 : 130,
      render: (value: string) => (
        <Tag color={value.includes("DENY") || value.includes("REJECT") ? "red" : value.includes("LIMIT") ? "orange" : "green"}>
          {value}
        </Tag>
      ),
    },
    ...(narrow
      ? []
      : ([
          { title: "来源", dataIndex: "from", width: 180, ellipsis: true },
          {
            title: "IPv6",
            dataIndex: "v6",
            width: 80,
            render: (value: boolean) => (value ? <Tag>v6</Tag> : <span className="muted">-</span>),
          },
        ] as ColumnsType<RuleRow>)),
    {
      title: "",
      width: 60,
      render: (_, row) => (
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={!canWrite}
          onClick={() =>
            modal.confirm({
              title: `删除规则 ${row.to}？`,
              content: "该规则会立即从防火墙中移除。",
              okText: "删除",
              okButtonProps: { danger: true },
              cancelText: "取消",
              onOk: () =>
                run("delete", {
                  action: "delete",
                  spec: row.to,
                  ruleAction: row.action,
                  backend: status?.backend,
                }),
            })
          }
        />
      ),
    },
  ];

  if (!status && loading) {
    return <div className="sysadmin-loading"><Spin size="large" tip="正在读取防火墙状态..." /></div>;
  }

  return (
    <div className="sysadmin-page scroll-y" ref={measureRef}>
      <div className="sysadmin-page-head">
        <div className="sysadmin-page-title">
          <span className="sysadmin-page-icon" style={{ background: "linear-gradient(135deg,#dc2626,#f97316)" }}>
            <SafetyCertificateOutlined />
          </span>
          <div>
            <Typography.Title level={4}>防火墙策略</Typography.Title>
            <Typography.Text type="secondary">
              默认拒绝所有入站，仅放行 SSH、HTTP、HTTPS 等必要端口
            </Typography.Text>
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
          {status && status.installed ? (
            status.active ? (
              <Button danger loading={busy === "disable"} disabled={!canWrite} onClick={() =>
                modal.confirm({
                  title: "关闭防火墙？",
                  content: "关闭后所有入站端口都会暴露，建议仅在调试时临时关闭。",
                  okText: "关闭防火墙",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: () => run("disable", { action: "disable", backend: status.backend }),
                })
              }>关闭防火墙</Button>
            ) : (
              <Button
                type="primary"
                loading={busy === "enable"}
                disabled={!canWrite || !status.installed}
                onClick={() =>
                  modal.confirm({
                    title: "启用防火墙？",
                    content: (
                      <Space direction="vertical">
                        <Typography.Text>
                          启用后默认拒绝所有入站，只会放行当前已有规则中的端口。请先确认 SSH 端口已放行。
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          当前 SSH 端口：{sshPort}/tcp。如果没有对应放行规则，启用后可能立即断开连接。
                        </Typography.Text>
                      </Space>
                    ),
                    okText: "确认启用",
                    cancelText: "取消",
                    onOk: () => run("enable", { action: "enable", backend: status.backend }),
                  })
                }
              >
                启用防火墙
              </Button>
            )
          ) : (
            <Button type="primary" icon={<ThunderboltOutlined />} loading={busy === "install"} onClick={() => run("install", { action: "install", backend: status?.backend })}>
              安装防火墙
            </Button>
          )}
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {!canWrite ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前账号没有免密 sudo 权限，只能查看防火墙状态，无法修改规则。"
        />
      ) : null}
      {status && !status.installed ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="未检测到 UFW 或 firewalld"
          description="Ubuntu/Debian 默认使用 UFW，CentOS/RHEL 默认使用 firewalld。点击右上角安装对应防火墙。"
        />
      ) : null}
      {status && !status.active && status.installed ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="防火墙当前未启用"
          description="启用后默认拒绝所有入站，再按需放行端口。请先确认 SSH 已放行，避免断开远程连接。"
        />
      ) : null}
      {status && status.active && !incomingSafe ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`当前默认入站策略为 ${incoming || "未知"}，不符合“默认拒绝入站”原则`}
          description="建议把默认入站策略设置为 deny（UFW）或 DROP（firewalld），再逐条放行所需端口。"
        />
      ) : null}

      {status ? (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={12}>
              <Card size="small" title="状态" extra={<Tag color={status.active ? "green" : "default"}>{status.active ? "运行中" : "未启用"}</Tag>}>
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    { key: "backend", label: "防火墙", children: BACKEND_LABEL[status.backend] ?? status.backend },
                    { key: "incoming", label: "默认入站", children: <Tag color={incomingSafe ? "green" : "orange"}>{status.defaultIncoming || "--"}</Tag> },
                    { key: "outgoing", label: "默认出站", children: status.defaultOutgoing || "--" },
                    { key: "routed", label: "默认转发", children: status.defaultRouted || "--" },
                    ...(status.zone ? [{ key: "zone", label: "默认区域", children: status.zone }] : []),
                  ]}
                />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="默认入站策略">
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Space wrap>
                    <Select
                      value={policy}
                      style={{ width: 160 }}
                      onChange={setPolicy}
                      options={[
                        { value: "deny", label: "拒绝 deny / DROP" },
                        { value: "reject", label: "拒绝并回复 reject / REJECT" },
                        { value: "allow", label: "允许 allow / ACCEPT" },
                      ]}
                      disabled={!canWrite}
                    />
                    <Button
                      type="primary"
                      disabled={!canWrite || !status.installed}
                      loading={busy === "set-defaults"}
                      onClick={() =>
                        modal.confirm({
                          title: "修改默认入站策略？",
                          content: policy === "allow" ? "允许所有入站会显著降低安全性。" : "修改后立即生效，请确保 SSH 已放行。",
                          okText: "应用",
                          cancelText: "取消",
                          onOk: () => run("set-defaults", { action: "set-defaults", policy, backend: status.backend }),
                        })
                      }
                    >
                      应用策略
                    </Button>
                  </Space>
                  <Typography.Text type="secondary">
                    核心原则：默认拒绝入站，仅按需放行 SSH、HTTP、HTTPS 等端口。{isFirewalld ? " firewalld 的 deny / limit 规则暂不在此页面提供。" : ""}
                  </Typography.Text>
                </Space>
              </Card>
            </Col>
          </Row>

          <Card size="small" title="快捷放行" style={{ marginTop: 12 }}>
            <Space wrap>
              {quick.map((item) => (
                <Button
                  key={item.key}
                  icon={<CheckCircleOutlined />}
                  disabled={!canWrite || !status.installed || hasRule(item.spec)}
                  loading={busy === `quick-${item.key}`}
                  onClick={() => run(`quick-${item.key}`, { action: "allow", spec: item.spec, backend: status.backend })}
                >
                  {hasRule(item.spec) ? `${item.label} 已放行` : `放行 ${item.label}（${item.spec}）`}
                </Button>
              ))}
              <Typography.Text type="secondary">放行后仍需确认 SSH 端口，避免把自己锁在服务器外。</Typography.Text>
            </Space>
          </Card>

          <Card size="small" title="添加规则" style={{ marginTop: 12 }}>
            <Space wrap>
              <Select
                value={action}
                onChange={setAction}
                style={{ width: 140 }}
                options={[
                  { value: "allow", label: "放行 allow" },
                  ...(isFirewalld ? [] : [
                    { value: "deny", label: "拒绝 deny" },
                    { value: "limit", label: "限速 limit" },
                  ]),
                ]}
                disabled={!canWrite}
              />
              <Input
                value={spec}
                onChange={(event) => setSpec(event.target.value)}
                placeholder="例如 22/tcp、80,443/tcp 或 ssh"
                style={{ width: 260 }}
                disabled={!canWrite}
              />
              <Button
                type="primary"
                loading={busy === "allow-rule"}
                disabled={!canWrite || !status.installed}
                onClick={() => run("allow-rule", { action, spec, backend: status.backend })}
              >
                添加规则
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              支持端口、端口段、逗号分隔端口与服务名。UFW 还支持 deny / limit；firewalld 建议采用默认拒绝 + 仅放行策略。
            </Typography.Paragraph>
          </Card>

          <Card
            size="small"
            title={`当前规则（${rules.length}）`}
            style={{ marginTop: 12 }}
            extra={<Tag color={status.active ? "green" : "red"}>{status.active ? <CheckCircleOutlined /> : <CloseCircleOutlined />} {status.active ? "已启用" : "已停用"}</Tag>}
          >
            {rules.length ? (
              <Table<RuleRow>
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={rules}
                pagination={false}
                tableLayout="fixed"
              />
            ) : (
              <Empty description="暂无规则，默认策略正在生效" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>

          {status.raw ? (
            <Collapse
              ghost
              style={{ marginTop: 12 }}
              items={[{
                key: "raw",
                label: "查看原始防火墙输出",
                children: <pre className="sysadmin-code">{status.raw}</pre>,
              }]}
            />
          ) : null}
        </>
      ) : (
        <Empty description="未获取到防火墙状态" />
      )}
    </div>
  );
}
