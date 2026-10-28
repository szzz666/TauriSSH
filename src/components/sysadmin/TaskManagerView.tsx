import { useCallback, useMemo, useRef, useState, type Key } from "react";
import {
  Alert, App, Button, Card, Col, Input, Progress, Row, Space, Statistic,
  Switch, Table, Tabs, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BarChartOutlined, CheckCircleOutlined, CloseCircleOutlined, CopyOutlined, DashboardOutlined,
  DeleteOutlined, DesktopOutlined, HddOutlined, LineChartOutlined, ReloadOutlined, SearchOutlined,
  SettingOutlined, SwapOutlined, ThunderboltOutlined, WifiOutlined,
} from "@ant-design/icons";
import { sysadmin, type PerformanceSnapshot, type ProcessInfo } from "../../api";
import { useRuntime } from "../../desktop/runtime";
import { ServicesPanel } from "./ServicesView";
import { useContextMenu } from "../ContextMenu";
import {
  formatBytes, formatPercent, formatRate, formatUptime, useCompactTable, usePolling,
} from "./shared";

interface Props {
  connectionId: string;
}

interface RatePoint {
  time: number;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
}

function rateFrom(previous: { time: number; rx: number; tx: number } | null, snapshot: PerformanceSnapshot) {
  if (!previous) return { rx: 0, tx: 0 };
  const seconds = Math.max(0.2, (Date.now() - previous.time) / 1000);
  return {
    rx: Math.max(0, (snapshot.networkRx - previous.rx) / seconds),
    tx: Math.max(0, (snapshot.networkTx - previous.tx) / seconds),
  };
}

function Sparkline({ points, color, secondary }: { points: number[]; color: string; secondary?: number[] }) {
  const width = 560;
  const height = 120;
  const path = (values: number[]) => {
    if (values.length < 2) return "";
    return values
      .map((value, index) => {
        const x = (index * width) / Math.max(1, values.length - 1);
        const y = height - Math.min(100, Math.max(0, value)) * (height / 100);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="tm-sparkline">
      {[20, 40, 60, 80, 100].map((value) => (
        <line
          key={value}
          x1={0}
          y1={height - value * (height / 100)}
          x2={width}
          y2={height - value * (height / 100)}
          stroke="rgba(148,163,184,0.22)"
        />
      ))}
      {secondary?.length ? <polyline points={path(secondary)} fill="none" stroke="#52c41a" strokeWidth={2} /> : null}
      <polyline points={path(points)} fill="none" stroke={color} strokeWidth={2.4} />
    </svg>
  );
}

function ProcessesPanel({ connectionId }: { connectionId: string }) {
  const { message, modal } = App.useApp();
  const runMobile = useRuntime().isMobile;
  const [measureRef, narrow] = useCompactTable<HTMLDivElement>(620);
  const isMobile = runMobile || narrow;
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menu = useContextMenu();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sysadmin.processesList(connectionId);
      setProcesses(result.processes);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  usePolling(load, 3000, autoRefresh);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return processes;
    return processes.filter((item) =>
      `${item.name} ${item.command} ${item.user} ${item.pid}`.toLowerCase().includes(keyword),
    );
  }, [processes, query]);

  const selectedProcesses = useMemo(
    () => processes.filter((item) => selectedRowKeys.includes(item.pid)),
    [processes, selectedRowKeys],
  );

  const endTasks = useCallback(
    (items: ProcessInfo[], signal: "TERM" | "KILL") => {
      if (!items.length) return;
      const run = async () => {
        setBusy(true);
        let completed = 0;
        for (const item of items) {
          try {
            await sysadmin.processKill(connectionId, item.pid, signal);
            completed += 1;
          } catch (err) {
            message.error(`${item.name}（${item.pid}）：${(err as Error).message}`);
          }
        }
        setBusy(false);
        if (completed) message.success(`已结束 ${completed} 个进程`);
        setSelectedRowKeys([]);
        await load();
      };
      modal.confirm({
        title: signal === "KILL" ? `强制结束 ${items.length} 个进程？` : `结束 ${items.length} 个进程？`,
        content: (
          <Space direction="vertical">
            <Typography.Text>{items.map((item) => `${item.name} (${item.pid})`).join("、")}</Typography.Text>
            <Typography.Text type="secondary">
              {signal === "KILL" ? "强制结束不会给进程清理资源的机会，可能导致数据丢失。" : "系统会向进程发送 SIGTERM，允许其正常退出。"}
            </Typography.Text>
          </Space>
        ),
        okText: signal === "KILL" ? "强制结束" : "结束任务",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: run,
      });
    },
    [connectionId, load, message, modal],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        message.success("已复制");
      } catch {
        message.error("复制失败");
      }
    },
    [message],
  );

  // 窄屏下省略次要列，避免固定列宽把名称列挤成 0 宽
  const columns: ColumnsType<ProcessInfo> = [
    {
      title: "名称",
      dataIndex: "name",
      width: isMobile ? 172 : 195,
      ellipsis: true,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (name: string, process) => (
        <Space className="table-cell-stack">
          <DesktopOutlined className="muted" />
          <Space direction="vertical" size={0}>
            <Typography.Text strong ellipsis style={{ maxWidth: isMobile ? 120 : 150 }}>{name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>PID {process.pid} · {process.user}</Typography.Text>
          </Space>
        </Space>
      ),
    },
    ...(isMobile
      ? []
      : ([
          {
            title: "状态",
            dataIndex: "state",
            width: 90,
            render: (state: string) => <Tag color={state.startsWith("R") ? "green" : state.startsWith("Z") ? "red" : "default"}>{state || "--"}</Tag>,
          },
        ] as ColumnsType<ProcessInfo>)),
    {
      title: "CPU",
      dataIndex: "cpu",
      width: isMobile ? 108 : 132,
      ellipsis: true,
      sorter: (a, b) => a.cpu - b.cpu,
      defaultSortOrder: "descend",
      render: (value: number) => (
        <Space direction="vertical" size={0} style={{ width: "100%" }}>
          <Typography.Text style={{ fontSize: 12 }}>{formatPercent(value, 1)}</Typography.Text>
          <Progress percent={Math.min(100, value)} showInfo={false} size="small" strokeColor="#1677ff" />
        </Space>
      ),
    },
    ...(isMobile
      ? []
      : ([
          {
            title: "内存",
            dataIndex: "mem",
            width: 142,
            ellipsis: true,
            sorter: (a, b: ProcessInfo) => a.mem - b.mem,
            render: (value: number, process: ProcessInfo) => (
              <Space direction="vertical" size={0} style={{ width: "100%" }}>
                <Typography.Text style={{ fontSize: 12 }}>{formatPercent(value, 1)} · {formatBytes(process.rss)}</Typography.Text>
                <Progress percent={Math.min(100, value)} showInfo={false} size="small" strokeColor="#52c41a" />
              </Space>
            ),
          },
          {
            title: "命令行",
            dataIndex: "command",
            ellipsis: true,
            render: (value: string) => (
              <Typography.Text ellipsis title={value} className="mono" style={{ fontSize: 12 }}>
                {value || "--"}
              </Typography.Text>
            ),
          },
        ] as ColumnsType<ProcessInfo>)),
  ];

  return (
    <div className="tm-panel" ref={measureRef}>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Space wrap style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={isMobile ? "搜索进程、用户或 PID" : "搜索进程名、用户、PID 或命令行"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: isMobile ? 210 : 300 }}
          />
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={!selectedProcesses.length}
            loading={busy}
            onClick={() => endTasks(selectedProcesses, "TERM")}
          >
            结束任务
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
        <Space>
          <Typography.Text type="secondary">{filtered.length} / {processes.length} 个进程</Typography.Text>
          <Typography.Text type="secondary">自动刷新</Typography.Text>
          <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
        </Space>
      </Space>

      <Table<ProcessInfo>
        size="small"
        rowKey="pid"
        tableLayout="fixed"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={false}
        scroll={{ y: 360 }}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
          preserveSelectedRowKeys: true,
        }}
        onRow={(process) => ({
          onClick: () => setSelectedRowKeys([process.pid]),
          onContextMenu: (event) => {
            event.preventDefault();
            if (!selectedRowKeys.includes(process.pid)) setSelectedRowKeys([process.pid]);
            const items = [
              { key: "term", label: "结束任务", icon: <CloseCircleOutlined />, danger: true },
              { key: "kill", label: "强制结束", icon: <ThunderboltOutlined />, danger: true },
              { type: "divider" as const },
              { key: "copyPid", label: "复制 PID", icon: <CopyOutlined /> },
              { key: "copyCommand", label: "复制命令行", icon: <CopyOutlined /> },
            ];
            menu.open(event, items, (key) => {
              if (key === "term") endTasks([process], "TERM");
              if (key === "kill") endTasks([process], "KILL");
              if (key === "copyPid") void copy(String(process.pid));
              if (key === "copyCommand") void copy(process.command);
            });
          },
        })}
      />
      {menu.node}
    </div>
  );
}

function PerformancePanel({ connectionId }: { connectionId: string }) {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [history, setHistory] = useState<RatePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousNet = useRef<{ time: number; rx: number; tx: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sysadmin.performance(connectionId);
      const now = Date.now();
      const rate = rateFrom(previousNet.current, result);
      previousNet.current = { time: now, rx: result.networkRx, tx: result.networkTx };
      setSnapshot(result);
      setHistory((previous) => [...previous, {
        time: now,
        cpu: result.cpu,
        memory: result.memoryPercent,
        rx: rate.rx,
        tx: rate.tx,
      }].slice(-60));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  usePolling(load, 2000, true);

  const lastRate = history.length > 1
    ? { rx: history[history.length - 1].rx, tx: history[history.length - 1].tx }
    : { rx: 0, tx: 0 };

  return (
    <div className="tm-panel">
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Card
            size="small"
            title={<Space><DashboardOutlined /><span>CPU</span></Space>}
            extra={<Typography.Text type="secondary">{snapshot?.cpuModel || "--"} · {snapshot?.cores.length ?? 0} 核</Typography.Text>}
          >
            <div className="tm-big-percent">{formatPercent(snapshot?.cpu, 1)}</div>
            <Sparkline points={history.map((point) => point.cpu)} color="#1677ff" />
            <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
              {(snapshot?.cores ?? []).map((core) => (
                <Col xs={12} md={8} key={core.name}>
                  <div className="tm-core">
                    <span>{core.name}</span>
                    <span>{formatPercent(core.usage, 1)}</span>
                  </div>
                  <Progress percent={Math.min(100, core.usage)} showInfo={false} size="small" strokeColor="#1677ff" />
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="内存">
            <div className="tm-big-percent" style={{ color: "#52c41a" }}>{formatPercent(snapshot?.memoryPercent, 1)}</div>
            <Progress percent={snapshot?.memoryPercent ?? 0} strokeColor="#52c41a" showInfo={false} />
            <Typography.Text type="secondary">
              {formatBytes(snapshot?.memoryUsed)} / {formatBytes(snapshot?.memoryTotal)} · 可用 {formatBytes(snapshot?.memoryAvailable)}
            </Typography.Text>
            <div style={{ marginTop: 12 }}>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <span>交换分区</span>
                <span>{formatPercent(snapshot?.swapPercent, 1)}</span>
              </Space>
              <Progress percent={snapshot?.swapPercent ?? 0} strokeColor="#faad14" showInfo={false} />
              <Typography.Text type="secondary">
                {formatBytes(snapshot?.swapUsed)} / {formatBytes(snapshot?.swapTotal)}
              </Typography.Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title={<Space><HddOutlined /><span>磁盘</span></Space>}>
            <Statistic value={snapshot?.diskPercent ?? 0} suffix="%" precision={1} />
            <Progress percent={snapshot?.diskPercent ?? 0} strokeColor="#eb2f96" showInfo={false} />
            <Typography.Text type="secondary">
              {formatBytes(snapshot?.diskUsed)} / {formatBytes(snapshot?.diskTotal)} · 可用 {formatBytes(snapshot?.diskAvailable)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title={<Space><WifiOutlined /><span>网络</span></Space>}>
            <Space direction="vertical" size={4}>
              <Typography.Text>接收 <strong style={{ color: "#1677ff" }}>{formatRate(lastRate.rx)}</strong></Typography.Text>
              <Typography.Text>发送 <strong style={{ color: "#52c41a" }}>{formatRate(lastRate.tx)}</strong></Typography.Text>
              <Typography.Text type="secondary">累计 {formatBytes(snapshot?.networkRx)} / {formatBytes(snapshot?.networkTx)}</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title={<Space><SwapOutlined /><span>系统</span></Space>}>
            <Space direction="vertical" size={4}>
              <Typography.Text>主机名：{snapshot?.hostname || "--"}</Typography.Text>
              <Typography.Text>内核：{snapshot?.kernel || "--"}</Typography.Text>
              <Typography.Text>负载：{snapshot?.load || "--"}</Typography.Text>
              <Typography.Text>运行时间：{formatUptime(snapshot?.uptime)}</Typography.Text>
              <Typography.Text>进程数：{snapshot?.processCount ?? "--"}</Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
      <Card size="small" title="CPU / 内存趋势" style={{ marginTop: 12 }} extra={loading ? <Tag>采集中</Tag> : <Tag>最近 {history.length} 次采样</Tag>}>
        <Sparkline points={history.map((point) => point.cpu)} secondary={history.map((point) => point.memory)} color="#1677ff" />
        <Space size="large">
          <Typography.Text><span style={{ color: "#1677ff" }}>■</span> CPU</Typography.Text>
          <Typography.Text><span style={{ color: "#52c41a" }}>■</span> 内存</Typography.Text>
        </Space>
      </Card>
    </div>
  );
}

export default function TaskManagerView({ connectionId }: Props) {
  const items = [
    {
      key: "processes",
      label: <Space size={6}><DesktopOutlined />进程</Space>,
      children: <ProcessesPanel connectionId={connectionId} />,
    },
    {
      key: "performance",
      label: <Space size={6}><LineChartOutlined />性能</Space>,
      children: <PerformancePanel connectionId={connectionId} />,
    },
    {
      key: "services",
      label: <Space size={6}><SettingOutlined />服务</Space>,
      children: <ServicesPanel connectionId={connectionId} compact />,
    },
  ];

  return (
    <div className="sysadmin-page task-manager">
      <div className="sysadmin-page-head">
        <div className="sysadmin-page-title">
          <span className="sysadmin-page-icon" style={{ background: "linear-gradient(135deg,#059669,#34d399)" }}>
            <BarChartOutlined />
          </span>
          <div>
            <Typography.Title level={4}>任务管理器</Typography.Title>
            <Typography.Text type="secondary">
              进程、性能、服务与开机启动项，一站式查看和结束远程任务
            </Typography.Text>
          </div>
        </div>
        <Space>
          <Tag icon={<CheckCircleOutlined />} color="green">SSH 实时</Tag>
        </Space>
      </div>
      <Tabs className="tm-tabs" defaultActiveKey="processes" items={items} />
    </div>
  );
}
