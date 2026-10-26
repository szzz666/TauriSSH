import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Radio, Space, Tag, Typography, message,
} from "antd";
import { ssh } from "../api";
import type { ConnectionProfile, Fingerprint } from "../api";
import { useStore, type SavedConnection } from "../store";

interface Props {
  open: boolean;
  editing?: SavedConnection | null;
  onClose: () => void;
  onConnected: (connectionId: string, label: string) => void;
}

interface FormValues {
  host: string;
  port: number;
  username: string;
  name?: string;
  authMethod: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  save?: boolean;
}

function toProfile(values: FormValues): ConnectionProfile {
  return {
    host: values.host.trim().replace(/^\[|\]$/g, ""),
    port: Number(values.port) || 22,
    username: values.username.trim(),
    authMethod: values.authMethod,
    password: values.password ?? "",
    privateKey: values.privateKey ?? "",
    passphrase: values.passphrase ?? "",
    name: values.name ?? "",
  };
}

/** 新建/编辑连接：测试 → 指纹确认 → 建连，与旧版 WebSSH 两步式流程一致。 */
export default function ConnectionModal({ open, editing, onClose, onConnected }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [fingerprint, setFingerprint] = useState<Fingerprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authMethod = Form.useWatch("authMethod", form) ?? "password";
  const settings = useStore((state) => state.settings);
  const upsertConnection = useStore((state) => state.upsertConnection);
  const record = useStore((state) => state.record);

  const initialValues = useMemo<Partial<FormValues>>(
    () =>
      editing
        ? { ...editing, save: editing.save }
        : {
            host: "",
            port: 22,
            username: "root",
            authMethod: "password" as const,
            save: settings.saveCredential,
          },
    [editing, settings.saveCredential],
  );

  useEffect(() => {
    if (open) {
      setError(null);
      setFingerprint(null);
      form.setFieldsValue(initialValues as FormValues);
    }
  }, [open, initialValues, form]);

  // Android 返回键：先关指纹确认，再关表单
  useEffect(() => {
    const handler = (event: Event) => {
      if (!open) return;
      event.preventDefault();
      if (fingerprint) setFingerprint(null);
      else onClose();
    };
    window.addEventListener("taurissh-back", handler);
    return () => window.removeEventListener("taurissh-back", handler);
  }, [fingerprint, onClose, open]);

  const persist = (values: FormValues, connectedLabel: string) => {
    if (values.save === false) return;
    const profile = toProfile(values);
    upsertConnection({
      id: editing?.id,
      name: values.name?.trim() || "",
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      password: settings.saveCredential ? profile.password ?? "" : "",
      privateKey: settings.saveCredential ? profile.privateKey ?? "" : "",
      passphrase: settings.saveCredential ? profile.passphrase ?? "" : "",
      save: true,
    });
    record("CONNECT", connectedLabel);
  };

  const handleTest = async () => {
    try {
      const values = await form.validateFields();
      setError(null);
      setTesting(true);
      const result = await ssh.test(toProfile(values));
      message.success(`认证成功，指纹为 ${result.fingerprint.value}`);
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const connectWith = async (values: FormValues) => {
    setConnecting(true);
    setError(null);
    try {
      const profile = toProfile(values);
      const result = await ssh.connect(profile);
      persist(values, result.connection.label);
      message.success("SSH 连接已建立");
      setFingerprint(null);
      onConnected(result.connection.id, result.connection.label);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setError(null);
      setTesting(true);
      const checked = await ssh.test(toProfile(values));
      setTesting(false);
      setFingerprint(checked.fingerprint);
      form.setFieldsValue(values);
    } catch (err) {
      setTesting(false);
      if ((err as { errorFields?: unknown }).errorFields) return;
      setError((err as Error).message);
    }
  };

  return (
    <>
      <Modal
        open={open && !fingerprint}
        title={editing ? "编辑 SSH 连接" : "新建 SSH 连接"}
        onCancel={onClose}
        destroyOnHidden
        maskClosable={false}
        width={560}
        centered={false}
        style={{ top: 16, maxHeight: "calc(100dvh - 32px)", paddingBottom: 16 }}
        styles={{ body: { maxHeight: "calc(100dvh - 160px)", overflowY: "auto" } }}
        footer={[
          <Button key="test" onClick={handleTest} loading={testing} disabled={connecting}>
            测试连接
          </Button>,
          <Button key="cancel" onClick={onClose} disabled={connecting}>
            取消
          </Button>,
          <Button key="ok" type="primary" onClick={handleSubmit} loading={connecting || testing}>
            建立连接
          </Button>,
        ]}
      >
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
        <Form form={form} layout="vertical" initialValues={initialValues} requiredMark>
          <Form.Item label="主机地址" name="host" rules={[{ required: true, message: "请输入主机地址" }]}>
            <Input placeholder="192.168.1.10、2001:db8::1 或 server.example.com" autoComplete="off" />
          </Form.Item>
          <Space size="middle" style={{ display: "flex" }}>
            <Form.Item label="端口" name="port" rules={[{ required: true, message: "请输入端口" }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={65535} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]} style={{ flex: 2 }}>
              <Input placeholder="root" autoComplete="username" />
            </Form.Item>
          </Space>
          <Form.Item label="连接名称" name="name">
            <Input placeholder="例如：生产环境 A" />
          </Form.Item>
          <Form.Item label="认证方式" name="authMethod">
            <Radio.Group optionType="button" buttonStyle="solid">
              <Radio.Button value="password">密码</Radio.Button>
              <Radio.Button value="key">私钥</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {authMethod === "password" ? (
            <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password placeholder="输入 SSH 登录密码" autoComplete="current-password" />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                label="私钥"
                name="privateKey"
                rules={[{ required: true, message: "请粘贴私钥内容" }]}
              >
                <Input.TextArea rows={5} spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </Form.Item>
              <Form.Item label="私钥口令" name="passphrase">
                <Input.Password placeholder="可选" autoComplete="off" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <Modal
        open={Boolean(fingerprint)}
        title="确认主机指纹"
        okText="信任并连接"
        cancelText="取消"
        maskClosable={false}
        confirmLoading={connecting}
        onCancel={() => setFingerprint(null)}
        onOk={async () => {
          const values = form.getFieldsValue(true) as FormValues;
          await connectWith(values);
        }}
      >
        <Typography.Paragraph type="secondary">
          首次连接前请核对主机指纹，确认无误后再继续。指纹不匹配可能意味着中间人攻击。
        </Typography.Paragraph>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="主机">
            {fingerprint ? `${fingerprint.host}:${fingerprint.port}` : "-"}
          </Descriptions.Item>
          <Descriptions.Item label="算法">{fingerprint?.algorithm ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="指纹">
            <Typography.Text code copyable>
              {fingerprint?.value ?? "-"}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Tag color="orange" style={{ marginTop: 12 }}>
          指纹仅本次信任，不会写入 known_hosts
        </Tag>
      </Modal>
    </>
  );
}
