import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveCapture from '/src/pages/LiveCapture.jsx';
import '/src/index.css';
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter><LiveCapture /></BrowserRouter></QueryClientProvider>);
