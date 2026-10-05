import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import App from "./App";
import "./index.css";
import { installErrorReporting } from "./services/errorReport";

// Ошибки админки — владельцу в Telegram и Sentry через сервер (services/errorReport.ts).
if (import.meta.env.PROD) installErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              // Цвета — из токенов темы, чтобы уведомления не выпадали из оформления (D-1).
              background: "var(--toast-bg)",
              color: "var(--toast-fg)",
              borderRadius: "6px",
              fontSize: "14px",
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
