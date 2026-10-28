import { useCallback, useEffect, useState } from "react";
import {
  Alert, App, Button, Card, Col, Collapse, Empty, Row, Space, Spin, Tag, Typography,
} from "antd";
import {
  CheckCircleOutlined, CloudDownloadOutlined, CloudSyncOutlined, ReloadOutlined,
  SafetyOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { sysadmin, type MirrorStatus } from "../../api";

interface Props {
  connectionId: string;
}

const FAMILY_LABEL: Record<string, string> = {
  ubuntu: "Ubuntu / Debian 系",
  debian: "Debian 系",
  rhel: "CentOS / RHEL 系",
  alpine: "Alpine",
  suse: "SUSE",
  unknown: "未知发行版",
};

export default function MirrorView({ connectionId }: Props) {
  const { message, modal } = App.useApp();
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sysadmin.mirrorStatus(connectionId);
      setStatus(result);
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

  const apply = useCallback(
    async (mirror: { id: string; name: string; baseUrl: string }) => {
      if (!status) return;
      setBusy(mirror.id);
      try {
        const result = await sysadmin.mirrorApply(connectionId, mirror.id);
        setStatus(result.status);
        modal.success({
          title: "软件源已切换",
          width: 640,
          content: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Typography.Text>
                已切换到 {mirror.name}，旧配置已备份为带 .taurissh 时间戳的文件。
              </Typography.Text>
              <pre className="sysadmin-code">{result.output || "已完成"}</pre>
            </Space>
          ),
          okText: "知道了",
        });
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [connectionId, message, modal, status],
  );

  const supported = Boolean(status && ["ubuntu", "debian", "rhel"].includes(status.family));
  const activePreset = status?.presets.find((preset) => preset.active);

  if (!status && loading) {
    return <div className="sysadmin-loading"><Spin size="large" tip="正在检测软件源..." /></div>;
  }

  return (
    <div className="sysadmin-page scroll-y">
      <div className="sysadmin-page-head">
        <div className="sysadmin-page-title">
          <span className="sysadmin-page-icon" style={{ background: "linear-gradient(135deg,#2563eb,#06b6d4)" }}>
            <CloudDownloadOutlined />
          </span>
          <div>
            <Typography.Title level={4}>软件源配置</Typography.Title>
            <Typography.Text type="secondary">
              将官方源替换为国内镜像，提升 apt / dnf / yum 的下载速度
            </Typography.Text>
          </div>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新检测</Button>
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {status && !status.canWrite ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前账号没有免密 sudo 权限，无法修改软件源。"
        />
      ) : null}
      {status && !supported ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="暂不支持当前发行版"
          description={`检测到 ${status.distroName || status.distroId || "未知系统"}，包管理器为 ${status.packageManager || "未知"}。`}
        />
      ) : null}

      {status ? (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={12}>
              <Card size="small" title="系统信息">
                <Space direction="vertical" size={4}>
                  <div><Typography.Text type="secondary">发行版：</Typography.Text>{status.distroName || "--"}</div>
                  <div><Typography.Text type="secondary">版本：</Typography.Text>{status.versionId || "--"} {status.codename ? `（${status.codename}）` : ""}</div>
                  <div><Typography.Text type="secondary">软件源类型：</Typography.Text>{FAMILY_LABEL[status.family] ?? status.family}</div>
                  <div><Typography.Text type="secondary">包管理器：</Typography.Text><Tag>{status.packageManager || "--"}</Tag></div>
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="当前镜像">
                <Space direction="vertical" size={4}>
                  <div>
                    {activePreset ? (
                      <Tag color="green" icon={<CheckCircleOutlined />}>{activePreset.name}</Tag>
                    ) : status.isMirror ? (
                      <Tag color="blue">{status.detectedMirror}</Tag>
                    ) : (
                      <Tag color="orange">官方源</Tag>
                    )}
                  </div>
                  <Typography.Text type="secondary">
                    {status.isMirror
                      ? `已检测到国内镜像：${status.detectedMirror}`
                      : "当前仍使用官方源，国内服务器建议切换镜像以提升速度。"}
                  </Typography.Text>
                  <Typography.Text type="secondary">切换前会自动备份 sources / repo 配置。</Typography.Text>
                </Space>
              </Card>
            </Col>
          </Row>

          <Card size="small" title="国内镜像预设" style={{ marginTop: 12 }}>
            <Row gutter={[12, 12]}>
              {status.presets.map((preset) => (
                <Col xs={24} md={12} xl={8} key={preset.id}>
                  <Card
                    size="small"
                    className={`mirror-card${preset.active ? " is-active" : ""}`}
                    title={preset.name}
                    extra={preset.active ? <Tag color="green">使用中</Tag> : null}
                  >
                    <Typography.Text code className="mirror-url">{preset.baseUrl}</Typography.Text>
                    <div style={{ marginTop: 12 }}>
                      <Button
                        type={preset.active ? "default" : "primary"}
                        icon={<CloudSyncOutlined />}
                        disabled={preset.active || !status.canWrite || !supported}
                        loading={busy === preset.id}
                        onClick={() =>
                          modal.confirm({
                            title: `切换到 ${preset.name}？`,
                            content: (
                              <Space direction="vertical">
                                <Typography.Text>基础地址：{preset.baseUrl}</Typography.Text>
                                <Typography.Text type="secondary">
                                  将备份当前配置，替换为镜像地址并执行 {status.packageManager === "apt-get" ? "apt-get update" : "刷新软件源缓存"}。
                                  操作可能需要几十秒。
                                </Typography.Text>
                              </Space>
                            ),
                            okText: "切换软件源",
                            cancelText: "取消",
                            onOk: () => apply(preset),
                          })
                        }
                      >
                        {preset.active ? "当前使用" : "切换到此镜像"}
                      </Button>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>

          <Card size="small" title="安全提示" style={{ marginTop: 12 }}>
            <Space direction="vertical">
              <Typography.Text><SafetyOutlined /> 镜像站仅改变下载地址，不改变软件包签名校验；请优先使用 HTTPS 镜像。</Typography.Text>
              <Typography.Text><ThunderboltOutlined /> 切换完成后建议执行一次系统更新，确认所有仓库均可访问。</Typography.Text>
            </Space>
          </Card>

          {status.currentSources ? (
            <Collapse
              ghost
              style={{ marginTop: 12 }}
              items={[{
                key: "sources",
                label: "查看当前软件源配置",
                children: <pre className="sysadmin-code">{status.currentSources}</pre>,
              }]}
            />
          ) : null}
        </>
      ) : (
        <Empty description="未获取到软件源信息" />
      )}
    </div>
  );
}
