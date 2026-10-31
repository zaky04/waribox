package com.waribox.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// Copie versionnée de gen/android/app/src/main/java/com/waribox/app/MainActivity.kt
// (gen/ est ignoré par git : voir CLAUDE.md, « Mode focus »). À recopier là-bas
// après toute régénération de gen/ par `tauri android init`.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Pont appelé par l'appli web (features/focus) pour le mode focus : cache les
  // barres système (statut + navigation) ; un balayage depuis le bord les fait
  // réapparaître un instant, comme n'importe quelle appli plein écran.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(FocusBridge(), "WariBoxNative")
  }

  private fun applyImmersive(enabled: Boolean) {
    runOnUiThread {
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      if (enabled) {
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  inner class FocusBridge {
    @JavascriptInterface
    fun setImmersive(enabled: Boolean) {
      applyImmersive(enabled)
    }
  }
}
