import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import App from "./App";
import { watchConnection } from "./services/connection";
// Шрифты — из сборки, а не с Google Fonts: без связи касса выглядит так же.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "./index.css";
import { watchAppUpdate } from "./services/appUpdate";
import { installErrorReporting } from "./services/errorReport";

watchConnection();

// Офлайн-режим: service worker хранит саму кассу на планшете (vite.config.ts).
// Новую версию касса ищет сама и включает её в паузе между продажами
// (services/appUpdate.ts).
if (import.meta.env.PROD) watchAppUpdate();
// Ошибки кассы — владельцу в Telegram и Sentry через сервер (services/errorReport.ts).
if (import.meta.env.PROD) installErrorReporting();

// Apply the saved theme before the first paint, synchronously, so the app
// never flashes dark before switching to a saved light preference.
try {
  const raw = localStorage.getItem("pos-theme");
  const theme = raw ? JSON.parse(raw)?.state?.theme : null;
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
} catch {
  document.documentElement.setAttribute("data-theme", "dark");
}

// networkMode "always": без сети React Query по умолчанию ставит запросы и
// оплату на паузу, и офлайн-режим (каталог и чеки на планшете) не включился
// бы вовсе. Что делать без связи, касса решает сама.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      networkMode: "always",
    },
    mutations: {
      networkMode: "always",
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 2000,
          style: {
            background: "var(--toast-bg)",
            color: "var(--toast-fg)",
            borderRadius: "6px",
            fontSize: "16px",
            padding: "12px 24px",
            maxWidth: "560px",
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
);
