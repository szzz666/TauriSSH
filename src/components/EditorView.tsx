import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Space, Spin, Typography, message } from "antd";
import { files as filesApi } from "../api";
import { useStore } from "../store";

interface Props {
  connectionId: string;
  path: string;
  onSaved?: () => void;
}

/** 远程文本编辑器：≤2 MiB、UTF-8，Ctrl/Cmd+S 保存。 */
export default function EditorView({ connectionId, path, onSaved }: Props) {
  const [content, setContent] = useState("");
  const [clean, setClean] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const record = useStore((state) => state.record);
  const dirty = content !== clean;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await filesApi.read(connectionId, path);
      setContent(result.content);
      setClean(result.content);
      record("FILE OPEN", path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId, path, record]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await filesApi.write(connectionId, path, content);
      setClean(content);
      record("FILE WRITE", path);
      message.success("已保存");
      onSaved?.();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [connectionId, path, content, record, onSaved]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, save]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 8 }}>
      <Space wrap>
        <Typography.Text className="mono" ellipsis style={{ maxWidth: 420 }}>
          {path}
        </Typography.Text>
        <Button onClick={() => void load()} loading={loading}>
          重新加载
        </Button>
        <Button type="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          保存
        </Button>
        <Typography.Text type={dirty ? "warning" : "secondary"}>
          {dirty ? "未保存 · UTF-8" : "已保存 · UTF-8"}
        </Typography.Text>
      </Space>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <Spin style={{ marginTop: 48, width: "100%" }} />
        ) : (
          <Input.TextArea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            className="mono"
            style={{ height: "100%", resize: "none" }}
          />
        )}
      </div>
    </div>
  );
}
