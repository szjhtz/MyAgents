import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { ConfigProvider } from './config/ConfigProvider';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { initFrontendLogger } from './utils/frontendLogger';
import { installMacFunctionKeyGuard } from './utils/macFunctionKeyGuard';

import './index.css';

// Initialize frontend logger to capture React console logs
initFrontendLogger();

// Block macOS WKWebView's NSEvent function-key tofu leak globally —
// see utils/macFunctionKeyGuard.ts. Must run before React mounts so the
// document-level capture handler is attached when the first input fires.
installMacFunctionKeyGuard();

// Block native "Reload / Inspect Element" context menu in production.
// Keep native menu for: input fields, text selection, contenteditable, links, images, media.
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'IMG'
      || tag === 'VIDEO' || tag === 'AUDIO' || el.isContentEditable) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

const root = createRoot(document.getElementById('root')!);
// Note: React.StrictMode removed to prevent double-rendering of SSE effects in development
// StrictMode causes useEffect to run twice, which duplicates SSE events and thinking blocks
root.render(
  <AppErrorBoundary>
    <ConfigProvider>
      <ToastProvider>
        <ImagePreviewProvider>
          <App />
        </ImagePreviewProvider>
      </ToastProvider>
    </ConfigProvider>
  </AppErrorBoundary>
);
