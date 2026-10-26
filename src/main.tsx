import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp, Result, Typography, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { ThemeProvider, useTheme } from "./theme";
import "./styles/base.css";

/** 全局错误边界：渲染异常时展示可读信息，避免整屏空白。 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("TauriSSH 渲染异常:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="界面渲染失败"
          subTitle={this.state.error.message}
          extra={
            <Typography.Paragraph code style={{ maxWidth: 800, whiteSpace: "pre-wrap" }}>
              {this.state.error.stack}
            </Typography.Paragraph>
          }
        />
      );
    }
    return this.props.children;
  }
}

function Root() {
  const { resolved } = useTheme();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: resolved === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 10,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <AntApp>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}

// 不使用 StrictMode：其开发期双重挂载会让终端/SSH 通道重复建立与关闭
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <Root />
  </ThemeProvider>,
);
