import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { PublicShopPage } from './components/PublicShopPage.js';
import './index.css';

// V2 / F5: `/s/<slug>` is a shop's public window (no login); everything else is the cabinet.
const shopSlug = /^\/s\/([a-z0-9][a-z0-9-]{2,39})\/?$/.exec(window.location.pathname)?.[1] ?? null;
const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>{shopSlug ? <PublicShopPage slug={shopSlug} /> : <App />}</React.StrictMode>,
  );
}
