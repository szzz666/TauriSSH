import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, App, Button, Card, Col, Descriptions, Empty, Row, Select, Space, Spin, Table,
  Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, FieldTimeOutlined,
  GlobalOutlined, ReloadOutlined, SyncOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { sysadmin, type TimeSyncStatus, type TimezoneStatus } from "../../api";

interface Props {
  connectionId: string;
}

type TrackingRow = { key: string; name: string; value: string };

/** 系统时间：chrony / NTP 同步、时间服务与 timedatectl 时区集中在同一个窗口。 */
export default function SystemTimeView({ connectionId }: Props) {
  const { message, modal } = App.useApp();
  const [status, setStatus] = useState<TimeSyncStatus | null>(null);
  const [zone, setZone] = useState<TimezoneStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState("Asia/Shanghai");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [timeResult, zoneResult] = await Promise.all([
        sysadmin.timeStatus(connectionId),
        sysadmin.timezoneStatus(connectionId),
      ]);
      setStatus(timeResult);
      setZone(zoneResult);
      setSelectedZone((current) => current || zoneResult.timezone || "Asia/Shanghai");
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

  const run = useCallback(
    async (label: string, action: string, servers: string[] = []) => {
      setBusy(label);
      try {
        const result = await sysadmin.timeAction(connectionId, action, servers);
        setStatus(result.status);
        message.success(result.output?.trim() || "时间同步配置已更新");
        setError(null);
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [connectionId, message],
  );

  const applyZone = useCallback(
    async (target: string) => {
      setBusy("timezone");
      try {
        const result = await sysadmin.timezoneSet(connectionId, target);
        setZone(result.status);
        setSelectedZone(target);
        message.success(`时区已设置为 ${target}`);
        setError(null);
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [connectionId, message],
  );

  const confirmZone = useCallback(
    (target: string) => {
      if (!zone || target === zone.timezone) return;
      modal.confirm({
        title: `将时区设置为 ${target}？`,
        content: "设置后系统日志、定时任务与 date 输出都会使用新时区，系统时钟的绝对时间不变。",
        okText: "设置为该时区",
        cancelText: "取消",
        onOk: () => applyZone(target),
      });
    },
    [applyZone, modal, zone],
  );

  const editServers = useCallback(() => {
    if (!status) return;
    let servers = status.servers.length ? [...status.servers] : ["ntp.aliyun.com", "time.tencent.com"];
    modal.confirm({
      title: "配置 NTP 服务器",
      width: 560,
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            每行一个地址，将写入 chrony 配置并重启服务。推荐使用阿里云、腾讯云等国内 NTP。
          </Typography.Text>
          <Select
            mode="tags"
            defaultValue={servers}
            style={{ width: "100%" }}
            placeholder="输入域名后回车，例如 ntp.aliyun.com"
            tokenSeparators={[",", " "]}
            onChange={(value) => { servers = value; }}
          />
        </Space>
      ),
      okText: "保存并重启",
      cancelText: "取消",
      onOk: () => {
        if (!servers.length) {
          message.error("至少保留一个 NTP 服务器");
          return Promise.reject(new Error("invalid"));
        }
        return run("servers", "set-servers", servers);
      },
    });
  }, [message, modal, run, status]);

  const trackingRows: TrackingRow[] = (status?.tracking ?? []).map(([name, value], index) => ({
    key: `${name}-${index}`,
    name,
    value,
  }));

  const trackingColumns: ColumnsType<TrackingRow> = [
    { title: "项目", dataIndex: "name", width: 200, ellipsis: true },
    { title: "值", dataIndex: "value", ellipsis: true, render: (value: string) => <span className="mono">{value}</span> },
  ];

  const zoneOptions = useMemo(
    () => (zone?.zones ?? []).map((item) => ({ value: item, label: item })),
    [zone?.zones],
  );

  const canWrite = Boolean(status?.canWrite || zone?.canWrite);
  const currentZone = zone?.timezone || status?.timezone || "";
  const localTime = zone?.localTime || status?.now || "--";

  if (!status && !zone && loading) {
    return <div className="sysadmin-loading"><Spin size="large" tip="正在读取系统时间..." /></div>;
  }

  return (
    <div className="sysadmin-page scroll-y">
      <div className="sysadmin-page-head">
        <div className="sysadmin-page-title">
          <span className="sysadmin-page-icon" style={{ background: "linear-gradient(135deg,#0f766e,#22c55e)" }}>
            <SyncOutlined />
          </span>
          <div>
            <Typography.Title level={4}>系统时间</Typography.Title>
            <Typography.Text type="secondary">
              chrony 自动校准时钟，timedatectl 统一时区（推荐 Asia/Shanghai）
            </Typography.Text>
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={busy === "makestep"}
            disabled={!status?.chronyInstalled}
            onClick={() => run("makestep", "makestep")}
          >
            立即校准
          </Button>
          <Button
            type="primary"
            icon={<ClockCircleOutlined />}
            loading={busy === "timezone"}
            disabled={!zone?.canWrite || currentZone === "Asia/Shanghai"}
            onClick={() => applyZone("Asia/Shanghai")}
          >
            设为北京时间
          </Button>
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {status && status.ntpdActive ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="检测到 ntpd 正在运行"
          description="chrony 与 ntpd 同时运行会争抢时钟控制权。建议停用 ntpd，仅保留 chronyd。"
        />
      ) : null}
      {status && !status.chronyInstalled ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="未检测到 chrony"
          description="现代 Linux 发行版推荐使用 chrony。安装后启用服务即可自动保持时间同步。"
          action={
            <Button size="small" type="primary" loading={busy === "install"} onClick={() => run("install", "install")}>
              安装 chrony
            </Button>
          }
        />
      ) : null}
      {!canWrite ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前账号没有免密 sudo 权限，只能查看系统时间与时区。"
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title="时钟状态"
            extra={
              <Tag
                color={status?.ntpSynchronized ? "green" : "orange"}
                icon={status?.ntpSynchronized ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
              >
                {status?.ntpSynchronized ? "已同步" : "未同步"}
              </Tag>
            }
          >
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: "now", label: "本地时间", children: <span className="mono">{localTime}</span> },
                { key: "utc", label: "UTC 时间", children: <span className="mono">{zone?.universalTime || "--"}</span> },
                {
                  key: "tz",
                  label: "时区",
                  children: <Tag color={currentZone === "Asia/Shanghai" ? "green" : "blue"}>{currentZone || "--"}</Tag>,
                },
                { key: "svc", label: "时间服务", children: status?.service || "chronyd" },
                {
                  key: "active",
                  label: "服务状态",
                  children: <Tag color={status?.serviceActive ? "green" : "default"}>{status?.serviceActive ? "运行中" : "未运行"}</Tag>,
                },
                {
                  key: "enabled",
                  label: "开机启动",
                  children: <Tag color={status?.serviceEnabled ? "green" : "default"}>{status?.serviceEnabled ? "已启用" : "未启用"}</Tag>,
                },
                { key: "chrony", label: "chrony", children: status?.chronyInstalled ? "已安装" : "未安装" },
                { key: "rtc", label: "RTC 使用本地时间", children: zone?.rtcInLocalTz ? "是" : "否" },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="时间服务">
            <Space wrap>
              {!status?.serviceActive ? (
                <Button
                  type="primary"
                  loading={busy === "enable"}
                  disabled={!canWrite || !status?.chronyInstalled}
                  onClick={() => run("enable", "enable")}
                >
                  启用并启动
                </Button>
              ) : (
                <>
                  <Button loading={busy === "restart"} disabled={!canWrite} onClick={() => run("restart", "restart")}>
                    重启服务
                  </Button>
                  <Button
                    danger
                    loading={busy === "disable"}
                    disabled={!canWrite}
                    onClick={() =>
                      modal.confirm({
                        title: "停用 chrony？",
                        content: "停用后系统时钟将不再自动校准。",
                        okText: "停用",
                        okButtonProps: { danger: true },
                        cancelText: "取消",
                        onOk: () => run("disable", "disable"),
                      })
                    }
                  >
                    停用服务
                  </Button>
                </>
              )}
              {!status?.serviceEnabled && status?.serviceActive ? (
                <Button
                  loading={busy === "enable"}
                  disabled={!canWrite || !status?.chronyInstalled}
                  onClick={() => run("enable", "enable")}
                >
                  设置开机启动
                </Button>
              ) : null}
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              chronyd 读取 /etc/chrony/chrony.conf，通过 pool / server 指令与 NTP 服务器保持同步。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="修改时区">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Select
                showSearch
                value={selectedZone}
                options={zoneOptions}
                onChange={setSelectedZone}
                style={{ width: "100%" }}
                placeholder="搜索并选择时区，例如 Asia/Shanghai"
                filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                virtual
              />
              <Button
                type="primary"
                loading={busy === "timezone"}
                disabled={!zone?.canWrite || selectedZone === currentZone}
                onClick={() => confirmZone(selectedZone)}
              >
                应用时区
              </Button>
              <Typography.Text type="secondary">
                timedatectl set-timezone 同时更新 /etc/localtime 与 /etc/timezone。
              </Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="常用时区">
            <Space wrap>
              {(zone?.commonZones ?? []).map((item) => (
                <Button
                  key={item}
                  size="small"
                  type={item === currentZone ? "primary" : "default"}
                  disabled={!zone?.canWrite || item === currentZone}
                  onClick={() => confirmZone(item)}
                >
                  {item}
                  {item === "Asia/Shanghai" ? "（北京时间）" : ""}
                </Button>
              ))}
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              中国大陆服务器建议统一使用 Asia/Shanghai，让日志、cron 与 systemd timer 的时间与本地一致。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={`NTP 服务器（${status?.servers.length ?? 0}）`}
        extra={<Button size="small" disabled={!status?.chronyInstalled} onClick={editServers}>编辑服务器</Button>}
      >
        {status?.servers.length ? (
          <Space wrap>
            {status.servers.map((server) => <Tag key={server} color="blue">{server}</Tag>)}
          </Space>
        ) : (
          <Typography.Text type="secondary">尚未配置 NTP 服务器（可能使用发行版默认配置）。</Typography.Text>
        )}
      </Card>

      <Card size="small" title="chronyc tracking">
        {trackingRows.length ? (
          <Table<TrackingRow>
            size="small"
            rowKey="key"
            tableLayout="fixed"
            columns={trackingColumns}
            dataSource={trackingRows}
            pagination={false}
            scroll={{ y: 220 }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 tracking 数据（chronyd 可能未运行）" />
        )}
      </Card>

      <Card size="small" title="维护提示">
        <Space direction="vertical">
          <Typography.Text><FieldTimeOutlined /> 时钟偏差较大时，执行“立即校准”可强制步进校正。</Typography.Text>
          <Typography.Text><ClockCircleOutlined /> 国内服务器优先使用 ntp.aliyun.com、time.tencent.com 等低延迟源。</Typography.Text>
          <Typography.Text><GlobalOutlined /> 时区只影响展示与调度，不改变系统时钟的绝对时间。</Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
