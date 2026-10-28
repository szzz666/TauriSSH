const EVENT_NAME = "taurissh:desktop-changed";

/** 通知所有已打开的桌面/文件视图刷新远程目录。 */
export function notifyDesktopChanged() {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function onDesktopChanged(listener: () => void) {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
