import { Card, Input, Segmented, Space, Switch, Typography } from "antd";
import { useStore } from "../store";

/** 工作台偏好设置面板（桌面窗口与移动端主屏共用）。 */
export default function SettingsPanel() {
  const settings = useStore((state) => state.settings);
  const setSettings = useStore((state) => state.setSettings);

  return (
    <div className="scroll-y" style={{ height: "100%", paddingRight: 4 }}>
      <Card size="small" title="工作台偏好">
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space style={{ justifyContent: "space-between", width: "100%" }}>
            <div>
              <div>界面主题</div>
              <Typography.Text type="secondary">切换浅色或深色显示</Typography.Text>
            </div>
            <Segmented
              value={settings.theme}
              onChange={(value) => setSettings({ theme: value as "system" | "light" | "dark" })}
              options={[
                { label: "跟随系统", value: "system" },
                { label: "浅色", value: "light" },
                { label: "深色", value: "dark" },
              ]}
            />
          </Space>
          <Space style={{ justifyContent: "space-between", width: "100%" }}>
            <div>
              <div>终端字号</div>
              <Typography.Text type="secondary">基础终端显示字号（11 - 22）</Typography.Text>
            </div>
            <Space>
              <Input
                type="number"
                min={11}
                max={22}
                value={settings.font}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (value >= 11 && value <= 22) setSettings({ font: value });
                }}
                style={{ width: 80 }}
              />
              <span className="muted">{settings.font}px</span>
            </Space>
          </Space>
          {[
            { key: "showWelcome", label: "连接后自动打开终端", hint: "建立连接后直接进入终端窗口" },
            { key: "autoOpenTerminal", label: "记住窗口位置", hint: "下次打开应用时恢复上次布局" },
            { key: "reconnect", label: "自动重连", hint: "终端意外断开后自动尝试恢复" },
            { key: "screenAutoExit", label: "程序结束自动退出 Screen", hint: "关闭后程序结束会保留 Screen 并进入 shell" },
            { key: "confirm", label: "危险操作确认", hint: "删除、移动和断开前再次确认" },
            { key: "saveCredential", label: "保存连接密码", hint: "密码与私钥以明文保存在本机存储中" },
          ].map((item) => (
            <Space key={item.key} style={{ justifyContent: "space-between", width: "100%" }}>
              <div>
                <div>{item.label}</div>
                <Typography.Text type="secondary">{item.hint}</Typography.Text>
              </div>
              <Switch
                checked={Boolean(settings[item.key as keyof typeof settings])}
                onChange={(value) => setSettings({ [item.key]: value } as never)}
              />
            </Space>
          ))}
        </Space>
      </Card>
    </div>
  );
}
