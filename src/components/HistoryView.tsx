import { useMemo, useState } from "react";
import { Button, Empty, Input, List, Space, Tag, Typography, App } from "antd";
import { ClearOutlined, CopyOutlined, DownloadOutlined } from "@ant-design/icons";
import { historyLabel, useStore } from "../store";

/** 会话记录：本地保留最近 150 条，支持筛选、复制与 CSV 导出。 */
export default function HistoryView() {
  const { message, modal } = App.useApp();
  const history = useStore((state) => state.history);
  const clearHistory = useStore((state) => state.clearHistory);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const list = [...history].reverse();
    if (!keyword) return list;
    return list.filter((item) => `${item.type} ${item.value}`.toLowerCase().includes(keyword));
  }, [history, filter]);

  const copyAll = async () => {
    const text = filtered
      .map((item) => `${new Date(item.time).toLocaleString()}\t${historyLabel(item.type)}\t${item.value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  const exportCsv = () => {
    const rows = [["time", "type", "value"].join(",")];
    for (const item of filtered) {
      rows.push([item.time, item.type, item.value].map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","));
    }
    const blob = new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `taurissh-history-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <Space wrap>
        <Input
          placeholder="筛选命令、文件或任务..."
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          style={{ width: 240 }}
          allowClear
        />
        <Button icon={<CopyOutlined />} onClick={() => void copyAll()}>
          复制
        </Button>
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>
          导出 CSV
        </Button>
        <Button
          danger
          icon={<ClearOutlined />}
          onClick={() =>
            modal.confirm({
              title: "清空操作记录？",
              content: "该操作不可撤销。",
              okText: "清空",
              okButtonProps: { danger: true },
              cancelText: "取消",
              onOk: () => clearHistory(),
            })
          }
        >
          清空
        </Button>
      </Space>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {filtered.length === 0 ? (
          <Empty description="暂无匹配的操作记录" />
        ) : (
          <List
            size="small"
            dataSource={filtered}
            renderItem={(item) => (
              <List.Item>
                <Space wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(item.time).toLocaleString()}
                  </Typography.Text>
                  <Tag color="blue">{historyLabel(item.type)}</Tag>
                  <Typography.Text code className="mono">
                    {item.value}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );
}
