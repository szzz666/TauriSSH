import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, App, Button, Dropdown, Empty, Input, Space, Spin, Table, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowUpOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FileAddOutlined,
  FileZipOutlined, FolderAddOutlined, FolderOpenOutlined, ReloadOutlined, ScissorOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { files as filesApi, jobs as jobsApi, type RemoteFile, type ToolStatus, tools as toolsApi } from "../api";
import { useStore } from "../store";

interface Props {
  connectionId: string;
  initialPath?: string;
}

function formatSize(size: number, kind: string) {
  if (kind === "directory") return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

function formatTime(seconds: number) {
  if (!seconds) return "--";
  return new Date(seconds * 1000).toLocaleString();
}

const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|gz)$/i;

/** 文件管理：SFTP 浏览、上传/下载、编辑、压缩解压、权限与桌面快捷方式。 */
export default function FileManager({ connectionId, initialPath }: Props) {
  const { message, modal } = App.useApp();
  const [path, setPath] = useState(initialPath || "/");
  const [pathInput, setPathInput] = useState(initialPath || "/");
  const [items, setItems] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ title: string; percent: number; detail: string } | null>(null);
  const clipboard = useRef<{ mode: "copy" | "cut"; entries: RemoteFile[] } | null>(null);
  const record = useStore((state) => state.record);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await filesApi.list(connectionId, target);
        setItems(result.files);
        setPath(result.path);
        setPathInput(result.path);
        setSelected([]);
      } catch (err) {
        setError((err as Error).message);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [connectionId],
  );

  useEffect(() => {
    void load(initialPath || "/");
  }, [load, initialPath]);

  const selectedEntries = useMemo(() => items.filter((item) => selected.includes(item.path)), [items, selected]);

  const ensureTools = async (required: string[]): Promise<ToolStatus | null> => {
    try {
      const status = await toolsApi.inspect(connectionId, required);
      if (status.missing.length === 0) return status;
      if (!status.canInstall) {
        message.error(`远程服务器缺少 ${status.missing.join("、")}，且未检测到支持的包管理器`);
        return null;
      }
      return await new Promise<ToolStatus | null>((resolve) => {
        modal.confirm({
          title: `安装 ${status.missing.join(" / ")}？`,
          content: (
            <div>
              <p>远程服务器缺少所需命令，将执行：</p>
              <Typography.Paragraph code copyable>
                {status.installCommand}
              </Typography.Paragraph>
            </div>
          ),
          okText: "确认安装",
          cancelText: "取消",
          onOk: async () => {
            setProgress({ title: "正在安装远程工具", percent: 0, detail: status.missing.join(", ") });
            try {
              const installed = await toolsApi.install(connectionId, status.missing);
              message.success("远程工具已就绪");
              resolve(installed);
            } catch (err) {
              message.error((err as Error).message);
              resolve(null);
            } finally {
              setProgress(null);
            }
          },
          onCancel: () => resolve(null),
        });
      });
    } catch (err) {
      message.error((err as Error).message);
      return null;
    }
  };

  const waitJob = async (jobId: string, title: string) => {
    setProgress({ title, percent: 0, detail: "正在处理远程文件..." });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const job = await jobsApi.get(jobId);
        if (job.status === "completed") {
          setProgress(null);
          return true;
        }
        if (job.status === "failed") {
          setProgress(null);
          message.error(job.error || "文件操作失败");
          return false;
        }
      } catch (err) {
        setProgress(null);
        message.error((err as Error).message);
        return false;
      }
    }
  };

  const handleUpload = async () => {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setProgress({ title: "正在上传", percent: 0, detail: list.length + " 个文件" });
    try {
      await filesApi.upload(connectionId, list, path);
      record("UPLOAD", `${list.length} 个文件 → ${path}`);
      message.success("上传完成");
      await load(path);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const handleDownload = async (entries: RemoteFile[]) => {
    for (const entry of entries) {
      if (entry.type === "directory") {
        const status = await ensureTools(["tar"]);
        if (!status) return;
      }
      const target = await saveDialog({ defaultPath: entry.name });
      if (!target) return;
      try {
        await filesApi.download(connectionId, target, entry.path);
        record("DOWNLOAD", entry.path);
        message.success(`已下载 ${entry.name}`);
      } catch (err) {
        message.error((err as Error).message);
      }
    }
  };

  const handleCompress = async (entries: RemoteFile[]) => {
    const base = entries.length === 1 ? entries[0].name.replace(ARCHIVE_RE, "") : "archive";
    const formats = entries.length === 1 && entries[0].type !== "directory"
      ? [
          { label: "TAR.GZ（推荐）", value: "tar.gz" },
          { label: "ZIP", value: "zip" },
          { label: "GZIP（单文件）", value: "gz" },
        ]
      : [
          { label: "TAR.GZ（推荐）", value: "tar.gz" },
          { label: "ZIP", value: "zip" },
        ];
    let name = base;
    let format = "tar.gz";
    const confirmed = await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: `压缩 ${entries.length} 个项目`,
        content: (
          <div>
            <Input defaultValue={base} onChange={(event) => { name = event.target.value; }} placeholder="基础名称" />
            <Space direction="vertical" style={{ marginTop: 12, width: "100%" }}>
              {formats.map((item) => (
                <Button
                  key={item.value}
                  block
                  type={item.value === format ? "primary" : "default"}
                  onClick={(event) => {
                    format = item.value;
                    event.currentTarget.parentElement
                      ?.querySelectorAll("button")
                      .forEach((btn) => btn.classList.remove("ant-btn-primary"));
                    event.currentTarget.classList.add("ant-btn-primary");
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </Space>
          </div>
        ),
        okText: "开始压缩",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    const destination = `${path === "/" ? "" : path}/${name || base}.${format}`;
    const status = await ensureTools([format === "zip" ? "zip" : format === "gz" ? "gzip" : "tar"]);
    if (!status) return;
    try {
      const result = (await filesApi.operation(connectionId, {
        action: "compress",
        path: entries[0].path,
        destination,
        paths: entries.map((item) => item.path),
      })) as { jobId: string };
      if (await waitJob(result.jobId, "正在压缩")) {
        message.success("压缩完成");
        await load(path);
      }
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleExtract = async (entry: RemoteFile) => {
    const status = await ensureTools([entry.name.endsWith(".zip") ? "unzip" : entry.name.endsWith(".gz") ? "gzip" : "tar"]);
    if (!status) return;
    const base = entry.name.replace(ARCHIVE_RE, "") || "解压内容";
    const destination = `${path === "/" ? "" : path}/${base}`;
    try {
      const result = (await filesApi.operation(connectionId, {
        action: "extract",
        path: entry.path,
        destination,
      })) as { jobId: string };
      if (await waitJob(result.jobId, "正在解压")) {
        message.success("解压完成");
        await load(path);
      }
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const promptName = async (title: string, initial: string, placeholder: string) => {
    let value = initial;
    return new Promise<string | null>((resolve) => {
      modal.confirm({
        title,
        content: <Input defaultValue={initial} onChange={(event) => { value = event.target.value; }} placeholder={placeholder} />,
        okText: "确定",
        cancelText: "取消",
        onOk: () => {
          const trimmed = value.trim();
          if (!trimmed) {
            message.error("请输入有效内容");
            return Promise.reject(new Error("invalid"));
          }
          if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
            message.error("名称不能包含 /，也不能是 . 或 ..");
            return Promise.reject(new Error("invalid"));
          }
          resolve(trimmed);
        },
        onCancel: () => resolve(null),
      });
    });
  };

  const handleMkdir = async () => {
    const name = await promptName("新建文件夹", "新建文件夹", "文件夹名称");
    if (!name) return;
    try {
      await filesApi.operation(connectionId, { action: "mkdir", path: `${path}/${name}` });
      record("FILE MKDIR", `${path}/${name}`);
      await load(path);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleCreateFile = async () => {
    const name = await promptName("新建文件", "untitled.txt", "文件名");
    if (!name) return;
    try {
      await filesApi.operation(connectionId, { action: "create", path: `${path}/${name}`, content: "" });
      record("FILE CREATE", `${path}/${name}`);
      await load(path);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleRename = async (entry: RemoteFile) => {
    const name = await promptName("重命名", entry.name, "新名称");
    if (!name || name === entry.name) return;
    const destination = `${path === "/" ? "" : path}/${name}`;
    try {
      await filesApi.operation(connectionId, { action: "rename", path: entry.path, destination });
      record("FILE RENAME", `${entry.path} → ${destination}`);
      await load(path);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (entries: RemoteFile[]) => {
    modal.confirm({
      title: `删除 ${entries.length} 个项目？`,
      content: entries.map((item) => item.name).join("、"),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        for (const entry of entries) {
          try {
            await filesApi.operation(connectionId, { action: "delete", path: entry.path });
            record("FILE DELETE", entry.path);
          } catch (err) {
            message.error(`${entry.name}：${(err as Error).message}`);
          }
        }
        await load(path);
      },
    });
  };

  const handlePaste = async () => {
    const clip = clipboard.current;
    if (!clip) return;
    for (const entry of clip.entries) {
      const target = `${path === "/" ? "" : path}/${entry.name}`;
      try {
        if (clip.mode === "copy") {
          await filesApi.operation(connectionId, { action: "copy", path: entry.path, destination: target });
          record("FILE COPY", `${entry.path} → ${target}`);
        } else {
          await filesApi.operation(connectionId, { action: "move", path: entry.path, destination: target });
          record("FILE MOVE", `${entry.path} → ${target}`);
        }
      } catch (err) {
        message.error(`${entry.name}：${(err as Error).message}`);
      }
    }
    if (clip.mode === "cut") clipboard.current = null;
    await load(path);
  };

  const handleChmod = async (entry: RemoteFile) => {
    let mode = entry.permissions.slice(1).replace(/-/g, "0");
    const numeric = entry.permissions
      .slice(1)
      .replace(/[^rwx-]/g, "")
      .match(/.{3}/g)
      ?.map((chunk) => {
        let value = 0;
        if (chunk[0] === "r") value += 4;
        if (chunk[1] === "w") value += 2;
        if (chunk[2] === "x" || chunk[2] === "s" || chunk[2] === "t") value += 1;
        return value;
      })
      .join("");
    if (numeric) mode = numeric;
    return new Promise<void>((resolve) => {
      modal.confirm({
        title: `修改权限 · ${entry.name}`,
        content: (
          <Input
            defaultValue={mode}
            maxLength={4}
            onChange={(event) => { mode = event.target.value; }}
            placeholder="例如 644 或 0755"
          />
        ),
        okText: "应用",
        cancelText: "取消",
        onOk: async () => {
          if (!/^[0-7]{3,4}$/.test(mode)) {
            message.error("请输入 3 或 4 位八进制权限，例如 644 或 0755");
            return Promise.reject(new Error("invalid"));
          }
          try {
            await filesApi.operation(connectionId, { action: "chmod", path: entry.path, mode });
            message.success("权限已更新");
            await load(path);
          } catch (err) {
            message.error((err as Error).message);
          }
          resolve();
        },
        onCancel: () => resolve(),
      });
    });
  };

  const handleShortcut = async (entries: RemoteFile[]) => {
    for (const entry of entries) {
      try {
        await filesApi.operation(connectionId, {
          action: "desktop-shortcut",
          path: entry.path,
          type: entry.type === "directory" ? "directory" : "file",
          name: entry.name,
        });
      } catch (err) {
        message.error((err as Error).message);
      }
    }
    message.success("已发送到远程桌面");
  };

  const columns: ColumnsType<RemoteFile> = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_, record_) => (
        <Space>
          {record_.type === "directory" ? <FolderOpenOutlined style={{ color: "#f0b429" }} /> : <FileAddOutlined className="muted" />}
          <Typography.Link
            onClick={() => {
              if (record_.type === "directory") void load(record_.path);
            }}
          >
            {record_.name}
          </Typography.Link>
        </Space>
      ),
    },
    { title: "权限", dataIndex: "permissions", width: 120, responsive: ["md"], render: (v) => <span className="mono">{v}</span> },
    { title: "所有者", dataIndex: "owner", width: 90, responsive: ["lg"] },
    { title: "大小", dataIndex: "size", width: 100, responsive: ["sm"], render: (_, r) => formatSize(r.size, r.type) },
    { title: "修改时间", dataIndex: "modified", width: 180, responsive: ["md"], render: (v) => formatTime(v as number) },
    {
      title: "操作",
      width: 150,
      render: (_, record_) => (
        <Space size={4}>
          <Tooltip title="下载">
            <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => void handleDownload([record_])} />
          </Tooltip>
          <Tooltip title="重命名">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => void handleRename(record_)} />
          </Tooltip>
          <Tooltip title="删除">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void handleDelete([record_])} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Space wrap style={{ padding: "8px 0" }}>
        <Button icon={<ArrowUpOutlined />} onClick={() => void load(path.split("/").slice(0, -1).join("/") || "/")}>
          上级
        </Button>
        <Input
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onPressEnter={() => void load(pathInput)}
          style={{ width: 260 }}
          placeholder="/root"
        />
        <Button onClick={() => void load(pathInput)}>跳转</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load(path)} />
        <Button icon={<FolderAddOutlined />} onClick={() => void handleMkdir()}>
          目录
        </Button>
        <Button icon={<FileAddOutlined />} onClick={() => void handleCreateFile()}>
          文件
        </Button>
        <Button icon={<UploadOutlined />} onClick={() => void handleUpload()}>
          上传
        </Button>
        <Button icon={<DownloadOutlined />} disabled={!selected.length} onClick={() => void handleDownload(selectedEntries)}>
          下载
        </Button>
        <Button icon={<FileZipOutlined />} disabled={!selected.length} onClick={() => void handleCompress(selectedEntries)}>
          压缩
        </Button>
        <Button
          icon={<ScissorOutlined />}
          disabled={!selected.some((p) => ARCHIVE_RE.test(p))}
          onClick={() => {
            const entry = selectedEntries.find((item) => ARCHIVE_RE.test(item.name));
            if (entry) void handleExtract(entry);
          }}
        >
          解压
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: "copy", label: "复制", icon: <CopyOutlined />, disabled: !selected.length },
              { key: "cut", label: "剪切", icon: <ScissorOutlined />, disabled: !selected.length },
              { key: "paste", label: "粘贴", disabled: !clipboard.current },
              { key: "chmod", label: "权限管理", disabled: selected.length !== 1 },
              { key: "desktop", label: "发送到桌面", disabled: !selected.length },
              { type: "divider" },
              { key: "delete", label: "删除", danger: true, disabled: !selected.length },
            ],
            onClick: ({ key }) => {
              if (key === "copy" || key === "cut") {
                clipboard.current = { mode: key === "copy" ? "copy" : "cut", entries: selectedEntries };
                message.success(key === "copy" ? "已复制到剪贴板" : "已剪切到剪贴板");
              } else if (key === "paste") {
                void handlePaste();
              } else if (key === "chmod") {
                void handleChmod(selectedEntries[0]);
              } else if (key === "desktop") {
                void handleShortcut(selectedEntries);
              } else if (key === "delete") {
                void handleDelete(selectedEntries);
              }
            },
          }}
        >
          <Button>更多操作</Button>
        </Dropdown>
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {progress ? (
        <Alert
          type="info"
          showIcon
          message={progress.title}
          description={progress.detail}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div style={{ flex: 1, minHeight: 0 }}>
        <Table<RemoteFile>
          size="small"
          rowKey="path"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={false}
          scroll={{ y: "calc(100vh - 460px)" }}
          locale={{ emptyText: loading ? <Spin /> : <Empty description="目录为空" /> }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
          }}
          onRow={(record_) => ({
            onDoubleClick: () => {
              if (record_.type === "directory") void load(record_.path);
            },
          })}
        />
      </div>
      <div className="muted" style={{ fontSize: 12, paddingTop: 8 }}>
        {items.length} 个项目{selected.length ? `，已选择 ${selected.length} 个` : ""} · SFTP 安全通道
      </div>
    </div>
  );
}
