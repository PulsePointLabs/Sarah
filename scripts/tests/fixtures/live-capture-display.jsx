import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveCapture from '/src/pages/LiveCapture.jsx';
import '/src/index.css';
const fixtureListeners = new Map();
window.EventSource = class {
  addEventListener(type, listener) { fixtureListeners.set(type, listener); }
  close() { fixtureListeners.clear(); }
};
window.emitTelemetryFixture = (type, data) => fixtureListeners.get(type)?.({ data: JSON.stringify(data) });
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter><LiveCapture /></BrowserRouter></QueryClientProvider>);
