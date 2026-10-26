package com.szzz666.taurissh

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

/**
 * 返回键处理：先把返回事件交给 WebView 页面（关闭弹窗 / 窗口），
 * 页面没有消费时才交给系统，避免误退出应用。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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

  private fun findWebView(view: View?): WebView? {
    if (view == null) return null
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }
}
