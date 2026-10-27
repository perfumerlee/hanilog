import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './ui/App';
import { authLinkErrorMessage } from './lib/auth-redirect';
import './ui/styles.css';

const authLinkMessage = authLinkErrorMessage(window.location.href);
if (authLinkMessage) {
  try {
    window.sessionStorage.setItem('hanilog.auth-link-message', authLinkMessage);
  } catch {
    // Keep startup resilient when browser storage is disabled.
  }
  if (!window.location.hash.startsWith('#/')) {
    const safeUrl = new URL(window.location.href);
    safeUrl.hash = '';
    window.history.replaceState({}, document.title, `${safeUrl.pathname}${safeUrl.search}`);
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
