import { useCallback, useState } from "react";
import { App, Descriptions, Input, Progress, Radio, Space, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  CaretRightOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined,
  FileAddOutlined, FileZipOutlined, FolderAddOutlined, FolderOpenOutlined, InfoCircleOutlined,
  LinkOutlined, ReloadOutlined, ScissorOutlined, SettingOutlined, UploadOutlined,
} from "@ant-design/icons";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  files as filesApi, jobs as jobsApi, screen as screenApi, tools as toolsApi,
  type RemoteFile, type ScreenSession, type ToolStatus,
} from "../api";
import { useStore } from "../store";
import { useFileClipboard, type ClipboardEntry } from "../file-clipboard";
import { notifyDesktopChanged } from "../desktop/events";

type MenuItem = NonNullable<MenuProps["items"]>[number];
type MenuItems = NonNullable<MenuProps["items"]>;

const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|gz)$/i;

export interface FileActionProgress {
  title: string;
  detail: string;
  percent: number;
}

export interface EntryMenuOptions {
  desktop?: boolean;
}

export interface BackgroundMenuOptions {
  desktop?: boolean;
  onOpenTerminal?: (directory: string) => void;
  onSelectAll?: () => void;
  onArrange?: () => void;
}

interface FileActionsOptions {
  connectionId: string;
  onRefresh: () => void | Promise<void>;
  onOpenEditor: (path: string) => void;
  onOpenFiles: (path: string) => void;
  onOpenScreen: (session: ScreenSession) => void;
}

export function baseName(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function parentPath(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function joinPath(directory: string, name: string) {
  return directory === "/" ? `/${name}` : `${directory.replace(/\/+$/, "")}/${name}`;
}

export function targetPath(entry: RemoteFile) {
  return entry.type === "shortcut" ? entry.target || entry.path : entry.path;
}

export function targetKind(entry: RemoteFile): string {
  return entry.type === "shortcut" ? entry.targetType || "file" : entry.type;
}

export function isExecutable(entry: RemoteFile) {
  const permissions = entry.permissions || "";
  return targetKind(entry) === "file" && (permissions[3] === "x" || permissions[6] === "x" || permissions[9] === "x");
}

function fileIcon(entry: RemoteFile) {
  if (targetKind(entry) === "directory") return <FolderOpenOutlined style={{ color: "#f0b429" }} />;
  if (entry.type === "shortcut") return <LinkOutlined style={{ color: "#7c3aed" }} />;
  return <FileAddOutlined className="muted" />;
}

export function useFileActions(options: FileActionsOptions) {
  const { message, modal } = App.useApp();
  const settings = useStore((state) => state.settings);
  const record = useStore((state) => state.record);
  const clipboard = useFileClipboard((state) => state);
  const [progress, setProgress] = useState<FileActionProgress | null>(null);

  const afterChange = useCallback(async () => {
    notifyDesktopChanged();
    await options.onRefresh();
  }, [options]);

  const ensureTools = useCallback(
    async (required: string[]): Promise<ToolStatus | null> => {
      try {
        const status = await toolsApi.inspect(options.connectionId, required);
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
              setProgress({ title: "正在安装远程工具", detail: status.missing.join(", "), percent: 0 });
              try {
                const installed = await toolsApi.install(options.connectionId, status.missing);
                message.success("远程工具已就绪");
                resolve(installed);
              } catch (error) {
                message.error((error as Error).message);
                resolve(null);
              } finally {
                setProgress(null);
              }
            },
            onCancel: () => resolve(null),
          });
        });
      } catch (error) {
        message.error((error as Error).message);
        return null;
      }
    },
    [message, modal, options.connectionId],
  );

  const waitJob = useCallback(
    async (jobId: string, title: string) => {
      setProgress({ title, detail: "正在处理远程文件...", percent: 0 });
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
          setProgress({ title, detail: "正在处理远程文件...", percent: Math.max(0, Math.min(100, job.percent)) });
        } catch (error) {
          setProgress(null);
          message.error((error as Error).message);
          return false;
        }
      }
    },
    [message],
  );

  const promptName = useCallback(
    (title: string, initial: string, placeholder: string, description?: string) =>
      new Promise<string | null>((resolve) => {
        let value = initial;
        modal.confirm({
          title,
          content: (
            <Space direction="vertical" style={{ width: "100%" }}>
              {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
              <Input
                defaultValue={initial}
                placeholder={placeholder}
                autoFocus
                onChange={(event) => { value = event.target.value; }}
              />
            </Space>
          ),
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
            return undefined;
          },
          onCancel: () => resolve(null),
        });
      }),
    [message, modal],
  );

  const upload = useCallback(
    async (directory: string) => {
      const picked = await openDialog({ multiple: true, directory: false });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      setProgress({ title: "正在上传", detail: `${list.length} 个文件`, percent: 0 });
      try {
        await filesApi.upload(options.connectionId, list, directory);
        record("UPLOAD", `${list.length} 个文件 → ${directory}`);
        message.success("上传完成");
        await afterChange();
      } catch (error) {
        message.error((error as Error).message);
      } finally {
        setProgress(null);
      }
    },
    [afterChange, message, options.connectionId, record],
  );

  const download = useCallback(
    async (entries: RemoteFile[]) => {
      for (const entry of entries) {
        const source = targetPath(entry);
        if (targetKind(entry) === "directory") {
          const status = await ensureTools(["tar"]);
          if (!status) return;
          const target = await saveDialog({ defaultPath: baseName(source) + ".tar.gz" });
          if (!target) return;
          const temp = joinPath(parentPath(source), ".taurissh-download-" + Date.now() + ".tar.gz");
          try {
            const result = (await filesApi.operation(options.connectionId, {
              action: "compress",
              path: source,
              destination: temp,
              paths: [source],
            })) as { jobId: string };
            if (!(await waitJob(result.jobId, "正在打包目录"))) return;
            await filesApi.download(options.connectionId, target, temp);
            record("DOWNLOAD", source);
            message.success(`已下载 ${baseName(source)}.tar.gz`);
          } catch (error) {
            message.error((error as Error).message);
          } finally {
            void filesApi.operation(options.connectionId, { action: "delete", path: temp }).catch(() => {});
          }
          continue;
        }
        const target = await saveDialog({ defaultPath: baseName(source) || "download" });
        if (!target) return;
        try {
          await filesApi.download(options.connectionId, target, source);
          record("DOWNLOAD", source);
          message.success(`已下载 ${baseName(source)}`);
        } catch (error) {
          message.error((error as Error).message);
        }
      }
    },
    [ensureTools, message, options.connectionId, record, waitJob],
  );

  const compress = useCallback(
    async (entries: RemoteFile[]) => {
      if (!entries.length) return;
      const sources = entries.map(targetPath);
      const parent = parentPath(sources[0]);
      const single = entries.length === 1 ? entries[0] : null;
      const preferred = single ? baseName(targetPath(single)).replace(ARCHIVE_RE, "") : "archive";
      let name = preferred;
      let format = "tar.gz";
      const formats = single && targetKind(single) === "file"
        ? [
            { value: "tar.gz", label: "TAR.GZ（推荐）" },
            { value: "zip", label: "ZIP" },
            { value: "gz", label: "GZIP（单文件）" },
          ]
        : [
            { value: "tar.gz", label: "TAR.GZ（推荐）" },
            { value: "zip", label: "ZIP" },
          ];
      const confirmed = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: `压缩 ${entries.length} 个项目`,
          content: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Typography.Text type="secondary">保存位置：{parent}</Typography.Text>
              <Input defaultValue={preferred} onChange={(event) => { name = event.target.value; }} placeholder="基础名称" />
              <Radio.Group defaultValue={format} onChange={(event) => { format = event.target.value; }}>
                <Space direction="vertical">
                  {formats.map((item) => (
                    <Radio key={item.value} value={item.value}>{item.label}</Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Space>
          ),
          okText: "开始压缩",
          cancelText: "取消",
          onOk: () => {
            const trimmed = name.trim();
            if (!trimmed || trimmed.includes("/")) {
              message.error("请输入有效名称");
              return Promise.reject(new Error("invalid"));
            }
            resolve(true);
            return undefined;
          },
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
      const destination = joinPath(parent, `${name.replace(ARCHIVE_RE, "")}.${format}`);
      const tool = format === "zip" ? "zip" : format === "gz" ? "gzip" : "tar";
      const status = await ensureTools([tool]);
      if (!status) return;
      try {
        const result = (await filesApi.operation(options.connectionId, {
          action: "compress",
          path: sources[0],
          destination,
          paths: sources,
        })) as { jobId: string };
        if (await waitJob(result.jobId, "正在压缩")) {
          message.success("压缩完成");
          await afterChange();
        }
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [afterChange, ensureTools, message, modal, options.connectionId, waitJob],
  );

  const extract = useCallback(
    async (entry: RemoteFile) => {
      const source = targetPath(entry);
      const parent = parentPath(source);
      const base = baseName(source).replace(ARCHIVE_RE, "") || "解压内容";
      const name = await promptName("解压归档文件", base, "目标文件夹名称", source);
      if (!name) return;
      const destination = joinPath(parent, name);
      const tool = source.toLowerCase().endsWith(".zip") ? "unzip" : source.toLowerCase().endsWith(".gz") ? "gzip" : "tar";
      const status = await ensureTools([tool]);
      if (!status) return;
      try {
        const result = (await filesApi.operation(options.connectionId, {
          action: "extract",
          path: source,
          destination,
        })) as { jobId: string };
        if (await waitJob(result.jobId, "正在解压")) {
          message.success("解压完成");
          await afterChange();
        }
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [afterChange, ensureTools, message, options.connectionId, promptName, waitJob],
  );

  const createEntry = useCallback(
    async (directory: string, kind: "file" | "directory") => {
      const name = await promptName(
        kind === "directory" ? "新建文件夹" : "新建文件",
        kind === "directory" ? "新建文件夹" : "untitled.txt",
        kind === "directory" ? "文件夹名称" : "文件名",
        `创建位置：${directory}`,
      );
      if (!name) return;
      try {
        await filesApi.operation(options.connectionId, {
          action: kind === "directory" ? "mkdir" : "create",
          path: joinPath(directory, name),
          content: "",
        });
        record(kind === "directory" ? "FILE MKDIR" : "FILE CREATE", joinPath(directory, name));
        await afterChange();
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [afterChange, message, options.connectionId, promptName, record],
  );

  const rename = useCallback(
    async (entry: RemoteFile) => {
      const name = await promptName("重命名", entry.name, "新名称", entry.type === "shortcut" ? entry.target : entry.path);
      if (!name || name === entry.name) return;
      try {
        if (entry.type === "shortcut") {
          const directory = parentPath(entry.path);
          const content = await filesApi.read(options.connectionId, entry.path);
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(content.content) as Record<string, unknown>;
          } catch {
            payload = {};
          }
          payload.name = name;
          const destination = joinPath(directory, `${name}.webssh-link`);
          await filesApi.write(options.connectionId, destination, JSON.stringify(payload));
          await filesApi.operation(options.connectionId, { action: "delete", path: entry.path });
          record("FILE RENAME", `${entry.path} → ${destination}`);
        } else {
          const destination = joinPath(parentPath(entry.path), name);
          await filesApi.operation(options.connectionId, { action: "rename", path: entry.path, destination });
          record("FILE RENAME", `${entry.path} → ${destination}`);
        }
        await afterChange();
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [afterChange, message, options.connectionId, promptName, record],
  );

  const remove = useCallback(
    async (entries: RemoteFile[]) => {
      if (!entries.length) return;
      const run = async () => {
        for (const entry of entries) {
          try {
            await filesApi.operation(options.connectionId, { action: "delete", path: entry.path });
            record("FILE DELETE", entry.path);
          } catch (error) {
            message.error(`${entry.name}：${(error as Error).message}`);
          }
        }
        await afterChange();
      };
      if (!settings.confirm) {
        await run();
        return;
      }
      modal.confirm({
        title: `删除 ${entries.length} 个项目？`,
        content: entries.map((item) => item.name).join("、"),
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: run,
      });
    },
    [afterChange, message, modal, options.connectionId, record, settings.confirm],
  );

  const chmod = useCallback(
    async (entries: RemoteFile[]) => {
      if (!entries.length) return;
      const entry = entries[0];
      const numeric = (entry.permissions || "")
        .slice(1)
        .match(/.{3}/g)
        ?.map((chunk) => {
          let value = 0;
          if (chunk[0] === "r") value += 4;
          if (chunk[1] === "w") value += 2;
          if (chunk[2] === "x" || chunk[2] === "s" || chunk[2] === "t") value += 1;
          return value;
        })
        .join("") || "644";
      let mode = numeric;
      await new Promise<void>((resolve) => {
        modal.confirm({
          title: entries.length > 1 ? `设置 ${entries.length} 个项目的权限` : `修改权限 · ${entry.name}`,
          content: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                {entries.length > 1 ? "所选项目将统一应用相同权限" : targetPath(entry)}
              </Typography.Text>
              <Input defaultValue={mode} maxLength={4} onChange={(event) => { mode = event.target.value; }} placeholder="例如 644 或 0755" />
            </Space>
          ),
          okText: "应用",
          cancelText: "取消",
          onOk: async () => {
            if (!/^[0-7]{3,4}$/.test(mode)) {
              message.error("请输入 3 或 4 位八进制权限，例如 644 或 0755");
              return Promise.reject(new Error("invalid"));
            }
            for (const item of entries) {
              try {
                await filesApi.operation(options.connectionId, {
                  action: "chmod",
                  path: targetPath(item),
                  mode,
                });
              } catch (error) {
                message.error(`${item.name}：${(error as Error).message}`);
              }
            }
            message.success("权限已更新");
            await afterChange();
            resolve();
          },
          onCancel: () => resolve(),
        });
      });
    },
    [afterChange, message, modal, options.connectionId],
  );

  const sendToDesktop = useCallback(
    async (entries: RemoteFile[]) => {
      let completed = 0;
      for (const entry of entries) {
        if (entry.type === "shortcut") continue;
        try {
          await filesApi.operation(options.connectionId, {
            action: "desktop-shortcut",
            path: targetPath(entry),
            kind: targetKind(entry) === "directory" ? "directory" : "file",
            name: entry.name,
          });
          completed += 1;
        } catch (error) {
          message.error((error as Error).message);
        }
      }
      if (completed) {
        message.success(`已发送 ${completed} 个项目到桌面`);
        await afterChange();
      }
    },
    [afterChange, message, options.connectionId],
  );

  const setClipboard = useCallback(
    (entries: RemoteFile[], mode: "copy" | "cut") => {
      const items: ClipboardEntry[] = entries.map((entry) => ({
        path: entry.path,
        fileName: baseName(entry.path),
        name: entry.name,
        type: entry.type,
      }));
      useFileClipboard.setState({ connectionId: options.connectionId, mode, entries: items });
      message.success(mode === "copy" ? `已复制 ${items.length} 个项目` : `已剪切 ${items.length} 个项目`);
    },
    [clipboard, message, options.connectionId],
  );

  const paste = useCallback(
    async (directory: string) => {
      const state = useFileClipboard.getState();
      if (!state.connectionId || state.connectionId !== options.connectionId || !state.entries.length) return;
      let completed = 0;
      for (const entry of state.entries) {
        let destination = joinPath(directory, entry.fileName);
        if (destination === entry.path) {
          const dot = entry.fileName.lastIndexOf(".");
          const duplicated = dot > 0
            ? `${entry.fileName.slice(0, dot)} - 副本${entry.fileName.slice(dot)}`
            : `${entry.fileName} - 副本`;
          destination = joinPath(directory, duplicated);
        }
        try {
          await filesApi.operation(options.connectionId, {
            action: state.mode === "cut" ? "move" : "copy",
            path: entry.path,
            destination,
          });
          record(state.mode === "cut" ? "FILE MOVE" : "FILE COPY", `${entry.path} → ${destination}`);
          completed += 1;
        } catch (error) {
          message.error(`${entry.name}：${(error as Error).message}`);
        }
      }
      if (state.mode === "cut") {
        useFileClipboard.setState({ mode: null, entries: [], connectionId: null });
      }
      if (completed) {
        message.success(`已粘贴 ${completed} 个项目`);
        await afterChange();
      }
    },
    [afterChange, message, options.connectionId, record],
  );

  const runScreen = useCallback(
    async (entry: RemoteFile) => {
      const status = await ensureTools(["screen"]);
      if (!status) return;
      try {
        const session = await screenApi.create(options.connectionId, {
          path: targetPath(entry),
          autoExit: settings.screenAutoExit,
        });
        record("FILE RUN", targetPath(entry));
        options.onOpenScreen(session);
        message.success(`已在 Screen 中运行 ${entry.name}`);
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [ensureTools, message, options, record, settings.screenAutoExit],
  );

  const open = useCallback(
    (entry: RemoteFile) => {
      const kind = targetKind(entry);
      if (kind === "directory") {
        options.onOpenFiles(targetPath(entry));
      } else if (isExecutable(entry)) {
        void runScreen(entry);
      } else {
        options.onOpenEditor(targetPath(entry));
      }
    },
    [options, runScreen],
  );

  const copyText = useCallback(
    async (text: string, success: string) => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(success);
      } catch {
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
        message.success(success);
      }
    },
    [message],
  );

  const properties = useCallback(
    (entry: RemoteFile) => {
      const items = [
        { key: "name", label: "名称", children: entry.name },
        { key: "kind", label: "类型", children: entry.type === "shortcut" ? `快捷方式（${targetKind(entry) === "directory" ? "目录" : "文件"}）` : entry.type },
        { key: "path", label: "位置", children: entry.type === "shortcut" ? targetPath(entry) : entry.path },
        { key: "size", label: "大小", children: `${entry.size} B` },
        { key: "permissions", label: "权限", children: entry.permissions },
        { key: "owner", label: "所有者", children: `${entry.owner} / ${entry.group}` },
        { key: "modified", label: "修改时间", children: entry.modified ? new Date(entry.modified * 1000).toLocaleString() : "--" },
        ...(entry.type === "shortcut" ? [{ key: "link", label: "快捷方式文件", children: entry.path }] : []),
      ];
      modal.info({
        title: entry.name,
        width: 560,
        content: <Descriptions column={1} size="small" items={items} />,
        okText: "关闭",
      });
    },
    [modal],
  );

  const entryMenuItems = useCallback(
    (entries: RemoteFile[], menuOptions: EntryMenuOptions = {}): MenuItems => {
      if (!entries.length) return [];
      const single = entries.length === 1 ? entries[0] : null;
      const kind = single ? targetKind(single) : "";
      const executable = Boolean(single && isExecutable(single));
      const archive = Boolean(single && kind !== "directory" && ARCHIVE_RE.test(targetPath(single).toLowerCase()));
      const items: MenuItem[] = [];
      if (kind === "directory") {
        items.push({ key: "open", label: "打开", icon: <FolderOpenOutlined /> });
      } else if (executable) {
        items.push({ key: "run", label: "使用 Screen 运行", icon: <CaretRightOutlined /> });
        items.push({ key: "edit", label: "编辑", icon: <EditOutlined /> });
      } else {
        items.push({ key: "edit", label: entries.length > 1 ? `编辑（仅 ${single?.name ?? ""}）` : "编辑", icon: <EditOutlined /> });
        if (single) items.push({ key: "run", label: "使用 Screen 运行", icon: <CaretRightOutlined /> });
      }
      items.push({
        key: "upload",
        label: single && kind === "directory" ? "上传文件" : "上传到所在文件夹",
        icon: <UploadOutlined />,
      });
      items.push({ key: "download", label: entries.length > 1 ? `下载 ${entries.length} 个项目` : "下载", icon: <DownloadOutlined /> });
      items.push({ key: "compress", label: entries.length > 1 ? `压缩 ${entries.length} 个项目` : "压缩归档", icon: <FileZipOutlined /> });
      if (archive) items.push({ key: "extract", label: "解压到文件夹", icon: <FolderOpenOutlined /> });
      items.push({ type: "divider" });
      items.push({ key: "copy", label: entries.length > 1 ? `复制 ${entries.length} 个项目` : "复制", icon: <CopyOutlined /> });
      items.push({ key: "cut", label: entries.length > 1 ? `剪切 ${entries.length} 个项目` : "剪切", icon: <ScissorOutlined /> });
      items.push({ key: "rename", label: "重命名", icon: <EditOutlined />, disabled: entries.length !== 1 });
      items.push({ type: "divider" });
      items.push({ key: "chmod", label: entries.length > 1 ? `权限管理（${entries.length} 项）` : "权限管理", icon: <SettingOutlined /> });
      if (!menuOptions.desktop) {
        items.push({ key: "desktop", label: entries.length > 1 ? `发送 ${entries.length} 项到桌面` : "发送到桌面", icon: <FolderAddOutlined /> });
      }
      items.push({ key: "copyPath", label: "复制路径", icon: <LinkOutlined />, disabled: entries.length !== 1 });
      items.push({ key: "properties", label: "属性", icon: <InfoCircleOutlined />, disabled: entries.length !== 1 });
      items.push({ key: "refresh", label: "刷新", icon: <ReloadOutlined /> });
      items.push({ type: "divider" });
      items.push({ key: "delete", label: entries.length > 1 ? `删除 ${entries.length} 个项目` : "删除", icon: <DeleteOutlined />, danger: true });
      return items;
    },
    [],
  );

  const handleEntryAction = useCallback(
    async (key: string, entries: RemoteFile[], menuOptions: EntryMenuOptions = {}) => {
      if (!entries.length) return;
      const entry = entries[0];
      switch (key) {
        case "open":
          open(entry);
          break;
        case "edit":
          options.onOpenEditor(targetPath(entry));
          break;
        case "run":
          await runScreen(entry);
          break;
        case "upload": {
          const directory = targetKind(entry) === "directory" ? targetPath(entry) : parentPath(targetPath(entry));
          await upload(directory);
          break;
        }
        case "download":
          await download(entries);
          break;
        case "compress":
          await compress(entries);
          break;
        case "extract":
          await extract(entry);
          break;
        case "copy":
          setClipboard(entries, "copy");
          break;
        case "cut":
          setClipboard(entries, "cut");
          break;
        case "rename":
          await rename(entry);
          break;
        case "chmod":
          await chmod(entries);
          break;
        case "desktop":
          await sendToDesktop(entries);
          break;
        case "copyPath":
          await copyText(targetPath(entry), "路径已复制");
          break;
        case "properties":
          properties(entry);
          break;
        case "refresh":
          await options.onRefresh();
          break;
        case "delete":
          await remove(entries);
          break;
        default:
          break;
      }
      void menuOptions;
    },
    [chmod, compress, copyText, download, extract, open, options, properties, remove, rename, runScreen, sendToDesktop, setClipboard, upload],
  );

  const backgroundMenuItems = useCallback(
    (directory: string, menuOptions: BackgroundMenuOptions = {}): MenuItems => {
      const items: MenuItem[] = [
        { key: "upload", label: "上传文件", icon: <UploadOutlined /> },
        { key: "paste", label: "粘贴", icon: <CopyOutlined />, disabled: !clipboard.entries.length || clipboard.connectionId !== options.connectionId },
        { key: "refresh", label: "刷新", icon: <ReloadOutlined /> },
        { key: "openTerminal", label: "打开终端", icon: <CaretRightOutlined />, disabled: !menuOptions.onOpenTerminal },
        { type: "divider" },
        { key: "newFile", label: "新建文件", icon: <FileAddOutlined /> },
        { key: "newFolder", label: "新建文件夹", icon: <FolderAddOutlined /> },
      ];
      if (menuOptions.onSelectAll) {
        items.push({ type: "divider" });
        items.push({ key: "selectAll", label: "全选", icon: <FolderOpenOutlined /> });
      }
      if (menuOptions.onArrange) {
        items.push({ key: "arrange", label: "自动排列", icon: <ReloadOutlined /> });
      }
      void directory;
      return items;
    },
    [clipboard.connectionId, clipboard.entries.length, options.connectionId],
  );

  const handleBackgroundAction = useCallback(
    async (key: string, directory: string, menuOptions: BackgroundMenuOptions = {}) => {
      switch (key) {
        case "upload":
          await upload(directory);
          break;
        case "paste":
          await paste(directory);
          break;
        case "refresh":
          await options.onRefresh();
          break;
        case "openTerminal":
          menuOptions.onOpenTerminal?.(directory);
          break;
        case "newFile":
          await createEntry(directory, "file");
          break;
        case "newFolder":
          await createEntry(directory, "directory");
          break;
        case "selectAll":
          menuOptions.onSelectAll?.();
          break;
        case "arrange":
          menuOptions.onArrange?.();
          break;
        default:
          break;
      }
    },
    [createEntry, options, paste, upload],
  );

  return {
    progress,
    entryMenuItems,
    backgroundMenuItems,
    handleEntryAction,
    handleBackgroundAction,
    targetPath,
    targetKind,
    isExecutable,
    fileIcon,
    ensureTools,
  };
}

export function FileActionProgress({ progress }: { progress: FileActionProgress | null }) {
  if (!progress) return null;
  return (
    <div className="file-action-progress">
      <div className="file-action-progress-head">
        <strong>{progress.title}</strong>
        <span>{progress.percent}%</span>
      </div>
      <Progress percent={progress.percent} showInfo={false} size="small" />
      <small>{progress.detail}</small>
    </div>
  );
}
