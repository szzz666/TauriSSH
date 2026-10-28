import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Dropdown, Empty, Input, Space, Spin, Table, Tag, Tooltip, Typography,
} from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowUpOutlined, BlockOutlined, CaretRightOutlined, CopyOutlined, DeleteOutlined,
  DownloadOutlined, EditOutlined, FileAddOutlined, FileZipOutlined, FolderAddOutlined,
  MoreOutlined, ReloadOutlined, ScissorOutlined, UploadOutlined,
} from "@ant-design/icons";
import { files as filesApi, type RemoteFile } from "../api";
import { useRuntime } from "../desktop/runtime";
import { useFileClipboard } from "../file-clipboard";
import { useFileActions, FileActionProgress } from "./file-actions";
import { useContextMenu } from "./ContextMenu";
import { useCompactTable, useElementHeight } from "./sysadmin/shared";

interface Props {
  connectionId: string;
  initialPath?: string;
}

const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|gz)$/i;

function formatSize(size: number, kind: string) {
  if (kind === "directory") return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? String(value) + " B" : value.toFixed(value < 10 ? 1 : 0) + " " + units[index];
}

function formatTime(seconds: number) {
  if (!seconds) return "--";
  return new Date(seconds * 1000).toLocaleString();
}

/** 文件管理：SFTP 浏览、上传/下载、编辑、压缩解压、权限、桌面快捷方式与完整右键菜单。 */
export default function FileManager({ connectionId, initialPath }: Props) {
  const runtime = useRuntime();
  const [path, setPath] = useState(initialPath || "/");
  const [pathInput, setPathInput] = useState(initialPath || "/");
  const [items, setItems] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [tableRef, tableHeight] = useElementHeight<HTMLDivElement>(46);
  const [measureRef, compact] = useCompactTable<HTMLDivElement>(640);
  const isMobile = runtime.isMobile || compact;
  const clipboard = useFileClipboard((state) => state);
  const menu = useContextMenu();

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
  }, [initialPath, load]);

  const actions = useFileActions({
    connectionId,
    onRefresh: () => load(path),
    onOpenEditor: (target) => {
      runtime.openApp("editor", { payload: { path: target } });
    },
    onOpenFiles: (target) => {
      void load(target);
    },
    onOpenScreen: (session) => {
      runtime.openApp("terminal", {
        payload: { screenName: session.name },
        title: "终端 · " + session.label,
      });
    },
  });

  const selectedEntries = useMemo(
    () => items.filter((item) => selected.includes(item.path)),
    [items, selected],
  );

  const canPaste = clipboard.connectionId === connectionId && clipboard.entries.length > 0;
  const selectedArchive = selectedEntries.find((entry) => ARCHIVE_RE.test(actions.targetPath(entry).toLowerCase()));

  const openEntry = useCallback(
    (entry: RemoteFile) => {
      void actions.handleEntryAction("open", [entry]);
    },
    [actions],
  );

  const showEntryMenu = useCallback(
    (event: React.MouseEvent, entry: RemoteFile) => {
      event.preventDefault();
      event.stopPropagation();
      const entries = selected.includes(entry.path) ? selectedEntries : [entry];
      if (!selected.includes(entry.path)) setSelected([entry.path]);
      const menuItems = actions.entryMenuItems(entries, { desktop: false });
      menu.open(event, menuItems, (key) => {
        void actions.handleEntryAction(key, entries, { desktop: false });
      });
    },
    [actions, menu, selected, selectedEntries],
  );

  const showBackgroundMenu = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("tbody tr")) return;
      event.preventDefault();
      const menuItems = actions.backgroundMenuItems(path, {
        desktop: false,
        onSelectAll: () => setSelected(items.map((item) => item.path)),
        onOpenTerminal: () => runtime.openApp("terminal", { title: "终端" }),
      });
      menu.open(event, menuItems, (key) => {
        void actions.handleBackgroundAction(key, path, {
          desktop: false,
          onSelectAll: () => setSelected(items.map((item) => item.path)),
          onOpenTerminal: () => runtime.openApp("terminal", { title: "终端" }),
        });
      });
    },
    [actions, items, menu, path, runtime],
  );

  const moreItems: MenuProps["items"] = [
    { key: "copy", label: "复制", icon: <CopyOutlined />, disabled: !selectedEntries.length },
    { key: "cut", label: "剪切", icon: <ScissorOutlined />, disabled: !selectedEntries.length },
    { key: "paste", label: "粘贴", disabled: !canPaste },
    { type: "divider" },
    { key: "chmod", label: "权限管理", disabled: selectedEntries.length === 0 },
    { key: "desktop", label: "发送到桌面", disabled: !selectedEntries.length },
    { key: "properties", label: "属性", disabled: selectedEntries.length !== 1 },
    { key: "copyPath", label: "复制路径", disabled: selectedEntries.length !== 1 },
    { type: "divider" },
    { key: "delete", label: "删除", danger: true, disabled: !selectedEntries.length },
  ];

  const columns: ColumnsType<RemoteFile> = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_, entry) => (
        <Space className="file-name-cell">
          {actions.fileIcon(entry)}
          <Typography.Link
            ellipsis
            title={entry.name}
            onClick={(event) => {
              event.stopPropagation();
              openEntry(entry);
            }}
          >
            {entry.name}
          </Typography.Link>
          {entry.type === "shortcut" ? <Tag>快捷方式</Tag> : null}
        </Space>
      ),
    },
    // 窄屏下固定列宽会把名称列挤成 0 宽，这里按需裁剪次要列
    ...(isMobile
      ? []
      : ([
          {
            title: "权限",
            dataIndex: "permissions",
            width: 110,
            ellipsis: true,
            render: (value: string) => <span className="mono">{value}</span>,
          },
          { title: "所有者", dataIndex: "owner", width: 90, ellipsis: true },
        ] as ColumnsType<RemoteFile>)),
    { title: "大小", dataIndex: "size", width: isMobile ? 76 : 90, render: (_, entry) => formatSize(entry.size, actions.targetKind(entry)) },
    ...(isMobile
      ? []
      : ([
          { title: "修改时间", dataIndex: "modified", width: 165, ellipsis: true, render: (value: number) => formatTime(value) },
        ] as ColumnsType<RemoteFile>)),
    {
      title: "操作",
      width: isMobile ? 132 : 170,
      render: (_, entry) => (
        <Space size={4}>
          <Tooltip title={actions.targetKind(entry) === "directory" ? "打开" : "打开 / 编辑"}>
            <Button size="small" type="text" icon={<CaretRightOutlined />} onClick={() => openEntry(entry)} />
          </Tooltip>
          <Tooltip title="下载">
            <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => void actions.handleEntryAction("download", [entry])} />
          </Tooltip>
          <Tooltip title="重命名">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => void actions.handleEntryAction("rename", [entry])} />
          </Tooltip>
          <Tooltip title="删除">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void actions.handleEntryAction("delete", [entry])} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div ref={measureRef} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Space wrap style={{ padding: "4px 0 8px" }}>
        <Button
          icon={<ArrowUpOutlined />}
          onClick={() => void load(path.split("/").slice(0, -1).join("/") || "/")}
        >
          上级
        </Button>
        <Input
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onPressEnter={() => void load(pathInput)}
          style={{ width: isMobile ? 190 : 280 }}
          placeholder="/root"
        />
        <Button onClick={() => void load(pathInput)}>跳转</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load(path)} />
        <Button
          icon={<BlockOutlined />}
          onClick={() => {
            runtime.openApp("files", { payload: { path }, newWindow: true, title: "文件管理 · " + path });
          }}
        >
          新窗口
        </Button>
        <Button icon={<FolderAddOutlined />} onClick={() => void actions.handleBackgroundAction("newFolder", path)}>
          目录
        </Button>
        <Button icon={<FileAddOutlined />} onClick={() => void actions.handleBackgroundAction("newFile", path)}>
          文件
        </Button>
        <Button icon={<UploadOutlined />} onClick={() => void actions.handleBackgroundAction("upload", path)}>
          上传
        </Button>
        <Button icon={<DownloadOutlined />} disabled={!selectedEntries.length} onClick={() => void actions.handleEntryAction("download", selectedEntries)}>
          下载
        </Button>
        <Button icon={<FileZipOutlined />} disabled={!selectedEntries.length} onClick={() => void actions.handleEntryAction("compress", selectedEntries)}>
          压缩
        </Button>
        <Button
          icon={<ScissorOutlined />}
          disabled={!selectedArchive}
          onClick={() => selectedArchive && void actions.handleEntryAction("extract", [selectedArchive])}
        >
          解压
        </Button>
        <Dropdown
          menu={{
            items: moreItems,
            onClick: ({ key }) => {
              if (key === "paste") {
                void actions.handleBackgroundAction("paste", path);
                return;
              }
              void actions.handleEntryAction(key, key === "chmod" ? (selectedEntries.length ? selectedEntries : items.slice(0, 0)) : selectedEntries);
            },
          }}
        >
          <Button icon={<MoreOutlined />}>更多</Button>
        </Dropdown>
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 10 }} /> : null}

      <div
        ref={tableRef}
        style={{ flex: 1, minHeight: 0 }}
        onContextMenu={showBackgroundMenu}
      >
        <Table<RemoteFile>
          size="small"
          rowKey="path"
          tableLayout="fixed"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={false}
          scroll={{ y: tableHeight }}
          locale={{ emptyText: loading ? <Spin /> : <Empty description="目录为空，右键可新建文件或上传" /> }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
          }}
          onRow={(entry) => ({
            onDoubleClick: () => openEntry(entry),
            onContextMenu: (event) => showEntryMenu(event, entry),
          })}
        />
      </div>
      <div className="muted" style={{ fontSize: 12, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
        <span>{items.length} 个项目{selected.length ? `，已选择 ${selected.length} 个` : ""} · SFTP 安全通道</span>
        <span>{canPaste ? `剪贴板：${clipboard.entries.length} 项（${clipboard.mode === "cut" ? "剪切" : "复制"}）` : "右键打开完整操作菜单"}</span>
      </div>
      <FileActionProgress progress={actions.progress} />
      {menu.node}
    </div>
  );
}
