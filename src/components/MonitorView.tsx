import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { ssh, type Metrics } from "../api";

interface Props {
  connectionId: string;
}

function formatBytes(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let result = value;
  let index = 0;
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024;
    index += 1;
  }
  return `${index <= 1 ? Math.round(result) : result.toFixed(result < 10 ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds?: number) {
  if (!seconds) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
}

/** 资源监控：1 秒轮询远端指标，保留最近 20 个采样点绘制趋势。 */
export default function MonitorView({ connectionId }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<{ cpu: number; memory: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ssh.metrics(connectionId);
      setMetrics(result);
      setError(null);
      setTrend((prev) => {
        const next = [...prev, { cpu: Number(result.cpu ?? 0), memory: Number(result.memory ?? 0) }];
        return next.slice(-20);
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void run();
    const timer = setInterval(() => void run(), 5000);
    return () => clearInterval(timer);
  }, [run]);

  const renderTrend = (key: "cpu" | "memory") => {
    if (trend.length < 2) return "";
    return trend
      .map((point, index) => {
        const x = (index * 700) / (trend.length - 1);
        const y = 220 - Math.min(100, point[key]) * 1.9;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  return (
    <div className="scroll-y" style={{ height: "100%", paddingRight: 4 }}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void run()} loading={loading}>
          刷新
        </Button>
        <Typography.Text type="secondary">
          {metrics?.collectedAt ? new Date(metrics.collectedAt).toLocaleTimeString() : "等待数据"}
        </Typography.Text>
      </Space>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      <Row gutter={[12, 12]}>
        <Col xs={12} lg={12}>
          <Card size="small" className="metric-card" title="处理器">
            <Progress percent={Number(metrics?.cpu ?? 0)} strokeColor="#1677ff" />
            <Typography.Text type="secondary">{metrics?.cpuCores ?? "-"} 核 · {metrics?.cpuModel ?? "-"}</Typography.Text>
          </Card>
        </Col>
        <Col xs={12} lg={12}>
          <Card size="small" className="metric-card" title="内存">
            <Progress percent={Number(metrics?.memory ?? 0)} strokeColor="#52c41a" />
            <Typography.Text type="secondary">
              {formatBytes(metrics?.memoryUsed)} / {formatBytes(metrics?.memoryTotal)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} lg={12}>
          <Card size="small" className="metric-card" title="交换分区">
            <Progress percent={Number(metrics?.swap ?? 0)} strokeColor="#faad14" />
            <Typography.Text type="secondary">
              {formatBytes(metrics?.swapUsed)} / {formatBytes(metrics?.swapTotal)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} lg={12}>
          <Card size="small" className="metric-card" title="根目录磁盘">
            <Progress percent={Number(metrics?.disk ?? 0)} strokeColor="#eb2f96" />
            <Typography.Text type="secondary">
              {formatBytes(metrics?.diskUsed)} / {formatBytes(metrics?.diskTotal)}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="资源趋势" extra={<Typography.Text type="secondary">最近 20 次采样</Typography.Text>} style={{ marginTop: 12 }}>
        <svg viewBox="0 0 700 220" preserveAspectRatio="none" style={{ width: "100%", height: 180 }}>
          {[20, 60, 100, 140, 180, 220].map((y) => (
            <line key={y} x1="0" y1={y} x2="700" y2={y} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
          ))}
          <polyline points={renderTrend("cpu")} fill="none" stroke="#1677ff" strokeWidth="2" />
          <polyline points={renderTrend("memory")} fill="none" stroke="#52c41a" strokeWidth="2" />
        </svg>
        <Space size="large">
          <Typography.Text><span style={{ color: "#1677ff" }}>■</span> CPU</Typography.Text>
          <Typography.Text><span style={{ color: "#52c41a" }}>■</span> Memory</Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="系统状态" style={{ marginTop: 12 }}>
        <Row gutter={[12, 12]}>
          <Col xs={12} md={8}><Statistic title="主机名" value={metrics?.hostname ?? "--"} /></Col>
          <Col xs={12} md={8}><Statistic title="系统" value={metrics?.kernel ?? "--"} /></Col>
          <Col xs={12} md={8}><Statistic title="系统负载" value={metrics?.load ?? "--"} /></Col>
          <Col xs={12} md={8}><Statistic title="运行时间" value={formatUptime(metrics?.uptime)} /></Col>
          <Col xs={12} md={8}><Statistic title="进程数" value={metrics?.processes ?? "--"} /></Col>
          <Col xs={12} md={8}><Statistic title="累计接收 / 发送" value={`${formatBytes(metrics?.download)} / ${formatBytes(metrics?.upload)}`} /></Col>
        </Row>
      </Card>
    </div>
  );
}
