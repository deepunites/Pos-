import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Куда проксировать API. По умолчанию — локальный бэкенд разработки; сквозные
// тесты (e2e/) поднимают свой бэкенд на другом порту и передают его сюда.
const apiTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Офлайн-режим: сама касса (страница, скрипты, шрифты) хранится на
    // планшете, чтобы открываться и после перезагрузки без связи. Запросы к
    // API не кэшируются — без связи их подменяют каталог и очередь чеков на
    // планшете (src/services/offline*). Новая версия ставится в фоне и
    // включается со следующей перезагрузкой страницы — посреди продажи касса
    // сама не перезагружается. Регистрация — в main.tsx.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Qwik Касса",
        short_name: "Qwik Касса",
        description: "Касса Qwik POS",
        lang: "ru",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#2c3540",
        theme_color: "#2c3540",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Шрифты — только латиница и кириллица (с расширениями: узбекские ў, қ, ғ, ҳ, oʻ).
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}", "assets/*-{latin,cyrillic}-*.woff2"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/, /^\/healthz/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5174,
    allowedHosts: "all",
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/socket.io": {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
