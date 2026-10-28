import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, App, Button, Dropdown, Empty, Input, Modal, Segmented, Space, Spin, Switch,
  Table, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CaretRightOutlined, PlusOutlined, PoweroffOutlined, ReloadOutlined, SearchOutlined,
} from "@ant-design/icons";
import { sysadmin, type ServiceInfo } from "../../api";
import { useRuntime } from "../../desktop/runtime";
import { useCompactTable } from "./shared";

interface PanelProps {
  connectionId: string;
  compact?: boolean;
}

type FilterKey = "all" | "enabled" | "disabled" | "active";

const FILTERS: { label: string; value: FilterKey }[] = [
  { label: "全部", value: "all" },
  { label: "已启用", value: "enabled" },
  { label: "未启用", value: "disabled" },
  { label: "运行中", value: "active" },
];

function stateColor(service: ServiceInfo) {
  if (service.active) return "green";
  if (service.enabled) return "blue";
  return "default";
}

export function ServicesPanel({ connectionId, compact }: PanelProps) {
  const { message } = App.useApp();
  const runMobile = useRuntime().isMobile;
  const [measureRef, narrow] = useCompactTable<HTMLDivElement>(620);
  const isMobile = runMobile || narrow;
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    command: "",
    workingDirectory: "",
    user: "root",
    enable: true,
    start: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sysadmin.servicesList(connectionId);
      setServices(result.services);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const action = useCallback(
    async (service: ServiceInfo, verb: string) => {
      setBusy(`${service.unit}:${verb}`);
      try {
        const result = await sysadmin.serviceAction(connectionId, service.unit, verb);
        message.success(result.output?.trim() || `${service.unit} ${verb} 已执行`);
        await load();
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [connectionId, load, message],
  );

  const openCreate = useCallback(() => {
    setDraft({
      name: "",
      description: "",
      command: "",
      workingDirectory: "",
      user: "root",
      enable: true,
      start: false,
    });
    setCreateOpen(true);
  }, []);

  const createService = useCallback(async () => {
    const name = draft.name.trim().replace(/\.service$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      message.error("服务名称只能包含字母、数字、-、_、.，且必须以字母或数字开头");
      return;
    }
    if (!draft.command.trim()) {
      message.error("请填写启动命令");
      return;
    }
    if (draft.workingDirectory.trim() && !draft.workingDirectory.trim().startsWith("/")) {
      message.error("工作目录必须是绝对路径");
      return;
    }
    if (draft.user.trim() && !/^[A-Za-z0-9_.-]{1,64}$/.test(draft.user.trim())) {
      message.error("运行用户名称不合法");
      return;
    }
    setCreating(true);
    try {
      await sysadmin.serviceCreate(connectionId, {
        name,
        description: draft.description.trim(),
        command: draft.command.trim(),
        workingDirectory: draft.workingDirectory.trim(),
        user: draft.user.trim(),
        enable: draft.enable,
        start: draft.start,
      });
      message.success("服务已创建");
      setCreateOpen(false);
      if (filter !== "all" && filter !== "enabled") setFilter("all");
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [connectionId, draft, filter, load, message]);

  const stats = useMemo(() => ({
    total: services.length,
    enabled: services.filter((service) => service.enabled).length,
    active: services.filter((service) => service.active).length,
  }), [services]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return services.filter((service) => {
      if (filter === "enabled" && !service.enabled) return false;
      if (filter === "disabled" && service.enabled) return false;
      if (filter === "active" && !service.active) return false;
      if (!keyword) return true;
      return `${service.unit} ${service.description}`.toLowerCase().includes(keyword);
    });
  }, [filter, query, services]);

  const columns: ColumnsType<ServiceInfo> = [
    {
      title: "服务单元",
      dataIndex: "unit",
      width: isMobile ? 172 : 210,
      sorter: (a, b) => a.unit.localeCompare(b.unit),
      render: (unit: string, service) => (
        <Space direction="vertical" size={0} className="table-cell-stack">
          <Typography.Text strong ellipsis style={{ maxWidth: 185 }}>
            {unit.replace(/\.service$/, "")}
          </Typography.Text>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>{unit}</Typography.Text>
          <Space size={4}>
            <Tag color={stateColor(service)}>{service.active ? "active" : service.state || "inactive"}</Tag>
            {service.enabled ? <Tag color="blue">开机启动</Tag> : null}
          </Space>
        </Space>
      ),
    },
    ...(isMobile
      ? []
      : ([
          {
            title: "描述",
            dataIndex: "description",
            ellipsis: true,
            render: (value: string) => value || <span className="muted">--</span>,
          },
        ] as ColumnsType<ServiceInfo>)),
    {
      title: "开机启动",
      dataIndex: "enabled",
      width: isMobile ? 88 : 120,
      render: (enabled: boolean, service) => (
        <Switch
          size="small"
          checked={enabled}
          loading={busy === `${service.unit}:${enabled ? "disable" : "enable"}`}
          onChange={(checked) => void action(service, checked ? "enable" : "disable")}
        />
      ),
    },
    {
      title: "操作",
      width: isMobile ? 132 : 170,
      render: (_, service) => (
        <Space size={2}>
          {service.active ? (
            <Tooltip title="停止">
              <Button
                size="small"
                type="text"
                icon={<PoweroffOutlined />}
                loading={busy === `${service.unit}:stop`}
                onClick={() => void action(service, "stop")}
              />
            </Tooltip>
          ) : (
            <Tooltip title="启动">
              <Button
                size="small"
                type="text"
                icon={<CaretRightOutlined />}
                loading={busy === `${service.unit}:start`}
                onClick={() => void action(service, "start")}
              />
            </Tooltip>
          )}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "restart", label: "重启服务" },
                { key: "enable", label: "设置开机启动", disabled: service.enabled },
                { key: "disable", label: "取消开机启动", disabled: !service.enabled },
              ],
              onClick: ({ key }) => void action(service, key),
            }}
          >
            <Button size="small" type="text">更多</Button>
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div ref={measureRef} className={compact ? "service-panel is-compact" : "service-panel"}>
      <Space wrap style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索服务单元或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: 240 }}
          />
          <Segmented options={FILTERS} value={filter} onChange={(value) => setFilter(value as FilterKey)} />
        </Space>
        <Space>
          <Tag>共 {stats.total}</Tag>
          <Tag color="blue">开机启动 {stats.enabled}</Tag>
          <Tag color="green">运行中 {stats.active}</Tag>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建服务</Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      {loading && !services.length ? (
        <div className="sysadmin-loading"><Spin tip="正在读取 systemd 服务..." /></div>
      ) : filtered.length ? (
        <Table<ServiceInfo>
          size="small"
          rowKey="unit"
          tableLayout="fixed"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: compact ? 8 : 12, hideOnSinglePage: true, size: "small" }}
          scroll={{ y: compact ? 300 : 420 }}
        />
      ) : (
        <Empty description={query ? "没有匹配的服务" : "没有可显示的服务"} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      <Modal
        open={createOpen}
        title="新建自定义服务"
        width={580}
        okText="创建服务"
        cancelText="取消"
        confirmLoading={creating}
        onOk={() => void createService()}
        onCancel={() => setCreateOpen(false)}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            将在 /etc/systemd/system 创建 systemd 服务单元，适合把自定义程序配置为开机启动。
          </Typography.Text>
          <div>
            <Typography.Text strong>服务名称</Typography.Text>
            <Input
              value={draft.name}
              addonAfter=".service"
              placeholder="my-service"
              onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
            />
          </div>
          <div>
            <Typography.Text strong>描述</Typography.Text>
            <Input
              value={draft.description}
              placeholder="例如：My background worker"
              onChange={(event) => setDraft((previous) => ({ ...previous, description: event.target.value }))}
            />
          </div>
          <div>
            <Typography.Text strong>启动命令</Typography.Text>
            <Input.TextArea
              value={draft.command}
              rows={3}
              placeholder="例如：/opt/myapp/start.sh 或 /usr/bin/python3 /opt/myapp/main.py"
              onChange={(event) => setDraft((previous) => ({ ...previous, command: event.target.value }))}
            />
          </div>
          <Space style={{ width: "100%" }} size="middle">
            <div style={{ flex: 1 }}>
              <Typography.Text strong>工作目录（可选）</Typography.Text>
              <Input
                value={draft.workingDirectory}
                placeholder="/opt/myapp"
                onChange={(event) => setDraft((previous) => ({ ...previous, workingDirectory: event.target.value }))}
              />
            </div>
            <div style={{ width: 180 }}>
              <Typography.Text strong>运行用户</Typography.Text>
              <Input
                value={draft.user}
                placeholder="root"
                onChange={(event) => setDraft((previous) => ({ ...previous, user: event.target.value }))}
              />
            </div>
          </Space>
          <Space size="large">
            <Space size={8}>
              <Switch checked={draft.enable} onChange={(value) => setDraft((previous) => ({ ...previous, enable: value }))} />
              <Typography.Text>创建后设置开机启动</Typography.Text>
            </Space>
            <Space size={8}>
              <Switch checked={draft.start} onChange={(value) => setDraft((previous) => ({ ...previous, start: value }))} />
              <Typography.Text>创建后立即启动</Typography.Text>
            </Space>
          </Space>
        </Space>
      </Modal>
    </div>
  );
}
