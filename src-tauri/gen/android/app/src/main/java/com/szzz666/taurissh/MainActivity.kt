package com.szzz666.taurissh

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 返回键处理：先把返回事件交给 WebView 页面（关闭弹窗 / 窗口），
 * 页面没有消费时才交给系统，避免误退出应用。
 *
 * 安全区处理：Android WebView 不会给 env(safe-area-inset-*) 返回值，
 * 这里直接把状态栏 / 导航栏 / 输入法的高度换算成容器内边距，
 * 避免顶栏被状态栏遮挡、底部按钮被导航栏压住。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    applyWindowInsets()

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val webView = findWebView(findViewById(android.R.id.content))
          if (webView == null) {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
            return
          }
          webView.evaluateJavascript(
            """
            (function () {
              var evt = new CustomEvent('taurissh-back', { cancelable: true });
              return window.dispatchEvent(evt) ? '0' : '1';
            })();
            """.trimIndent(),
          ) { result ->
            if (result != "\"1\"") {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      },
    )
  }

  /** 把系统栏与输入法占位换算成 WebView 容器内边距。 */
  private fun applyWindowInsets() {
    val root = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      val bottom = maxOf(bars.bottom, ime.bottom)
      view.setPadding(bars.left, bars.top, bars.right, bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(root)
  }

  private fun findWebView(view: View?): WebView? {
    if (view == null) return null
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(index))
        if (found != null) {
          return found
        }
      }
    }
    return null
  }
}
