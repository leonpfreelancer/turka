# Țurca

Онлайн-игра в цурку (чижик) до 4 игроков. Cloudflare Worker + Durable Object (комнаты по коду), клиент — один HTML на canvas.

- `src/index.html` — игра (меню, лобби, поле, тренировка)
- `src/worker.js` — отдаёт страницу, комнаты `/ws/<КОД>`, сервер сам считает дальность удара
- Деплой: `npx wrangler deploy`, локально: `npx wrangler dev`

Настройки физики — в начале обоих файлов (`TOSS_SPEED`, `POWER`, `GRAVITY` …), держать одинаковыми.
