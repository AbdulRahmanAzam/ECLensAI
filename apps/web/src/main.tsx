import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ToastProvider } from './components/ui/Toast';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './providers/AuthProvider';
import { GuidedDemoProvider } from './providers/GuidedDemoProvider';
import { SettingsProvider } from './providers/SettingsProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <ToastProvider>
            <AuthProvider>
              <GuidedDemoProvider>
                <App />
              </GuidedDemoProvider>
            </AuthProvider>
          </ToastProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
