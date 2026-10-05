# Деплой Qwik на Railway со своим доменом

Проект — это **четыре сервиса из репозитория и база** в одном Railway-проекте:

| Сервис     | Папка (Root Directory) | Что это                       | Публичный адрес           |
|------------|------------------------|-------------------------------|---------------------------|
| `Postgres` | — (Railway Database)   | PostgreSQL 16                 | не нужен                  |
| `backend`  | `backend`              | API                           | не нужен                  |
| `admin`    | `frontend-admin`       | панель управления             | `admin.qwik.uz`           |
| `terminal` | `pos-terminal`         | POS-терминал (касса)          | `pos.qwik.uz`             |
| `landing`  | `landing`              | сайт-визитка                  | `qwik.uz` и `www.qwik.uz` |

Backend наружу не открывается: admin и terminal обращаются к нему через
приватную сеть Railway, со стороны браузера это запросы на свой же домен.

---

## 1. Репозиторий

Railway деплоит по коммиту в GitHub. Залей корень проекта в свой репозиторий:

```bash
cd /home/deep/projects/pos/qwik
git init
git add .
git commit -m "Qwik POS"
git branch -M main
git remote add origin https://github.com/<аккаунт>/<репозиторий>.git
git push -u origin main
```

`.gitignore` уже настроен: `node_modules`, `dist`, `.env` и локальные базы
(`dev.db`, `test.db`) в репозиторий не попадут.

---

## 2. Четыре сервиса из одного репозитория

В Railway: **New Project → Deploy from GitHub repo**, выбрать репозиторий.
Затем добавить ещё три сервиса из того же репозитория (`+ New → GitHub Repo`,
тот же репозиторий) и каждому в **Settings → Source → Root Directory** указать
свою папку из таблицы выше. Railway сам найдёт `Dockerfile` в каждой папке.

Переименуй сервисы в `backend`, `admin`, `terminal`, `landing` — именем
сервиса определяется его внутренний адрес.

---

## 3. Backend: база и переменные

### База (PostgreSQL)

В проекте: **+ New → Database → Add PostgreSQL**. Railway создаст сервис
`Postgres` с томом и переменной `DATABASE_URL`; backend ссылается на неё —
см. ниже. Резервные копии — в сервисе `Postgres` → **Backups**.

> До октября 2026 база была файлом SQLite на томе `/data` сервиса backend.
> Если у тебя ещё так — сначала раздел **«Переезд с SQLite на Postgres»** ниже.

### Variables

```
PORT=3000
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}?connection_limit=10&pool_timeout=20&options=-c%20TimeZone%3DUTC
JWT_SECRET=<сгенерировать>
JWT_REFRESH_SECRET=<сгенерировать>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PENDING_ORDER_TTL_MINUTES=30
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
CORS_ORIGIN=https://admin.qwik.uz,https://pos.qwik.uz
LOG_LEVEL=info
```

`connection_limit` / `pool_timeout` — пул соединений Prisma на один экземпляр
backend. `TimeZone=UTC` — Prisma хранит время в UTC, и значения по умолчанию,
которые считает сама база, должны быть в том же поясе; backend при старте
проверяет это и пишет предупреждение в лог, если нет.

Секреты сгенерируй сам, по одному на каждую переменную — **не бери значения
из локального `.env`**. `JWT_SECRET` и `JWT_REFRESH_SECRET` должны различаться,
иначе backend не стартует:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Схема базы применяется сама при старте контейнера (`prisma migrate deploy`).
Миграции лежат в `backend/prisma/migrations` — это обычные SQL-файлы, данные
они не стирают. Старые миграции SQLite — в `backend/prisma/cutover/`, на
Postgres они не применяются.

`PENDING_ORDER_TTL_MINUTES` — через сколько минут неоплаченный заказ
автоматически отменяется и возвращает зарезервированный остаток на склад.

**База штрихкодов.** При старте backend в фоне загружает в базу поставляемый
каталог (`backend/catalog/catalog.jsonl.gz`, ~137 тыс. позиций, несколько
секунд; следующие старты ничего не делают). В логах —
«Barcode catalogue loaded» (первая загрузка) или «Barcode catalogue already
loaded» (уже есть), затем «Barcode sources reachable» с флагами
`openFoodFacts` и `nationalCatalogue` — достучался ли сервер до Open Food Facts и до
национального каталога Узбекистана (`tasnif.soliq.uz`) со своего адреса. Зарубежные
адреса каталог не пускает (с Railway — таймаут), поэтому `nationalCatalogue: false`
здесь штатно: каталог спрашивают браузеры магазинов (из Узбекистана), а сервер после
двух неудач перестаёт спрашивать на 30 минут. Необязательные переменные:
`CATALOG_LIVE_LOOKUP=off` — не ходить за неизвестными кодами в сеть вовсе;
`OFF_BASE_URL`, `TASNIF_BASE_URL` — другие серверы вместо них.

---

## Переезд с SQLite на Postgres (один раз)

Нужен, только если backend ещё работает на файле `/data/qwik.db`. Новая версия
backend с SQLite не стартует: `DATABASE_URL` обязан быть `postgresql://…`.

Перенос делает `dist/tools/sqlite-to-postgres.js` внутри образа backend. Он
снимает копию файла (`VACUUM INTO`), проверяет её, копирует все таблицы с
теми же id и временем и сверяет каждую таблицу по числу строк и SHA-256. На
базе с полным каталогом штрихкодов (137 тыс. строк) это занимает около
15 секунд. Исходный файл не меняется — это и есть путь отката.

**Простой: 10–15 минут** — касса в это время не работает. Выбери окно, когда
точки закрыты, и предупреди их.

### За день до переезда

1. Сервис `Postgres` уже создан (раздел 3), ветка с переездом прошла CI.
2. Сделай резервную копию тома `/data` сервиса backend (бэкап тома в Railway
   или скачай файл `qwik.db` через `railway ssh`).

### В окно переезда

1. **Останови кассы**: в сервисе backend → **Settings → Deploy → Custom Start
   Command** поставь

   ```
   sh -c "npx prisma migrate deploy && sleep infinity"
   ```

   Так новый контейнер создаст схему в Postgres, но **не запустит API**.
   Если API стартовал бы на пустой базе, точка успела бы зарегистрироваться
   заново или продать что-то в пустую базу, и перенос в непустую базу
   отказался бы работать.
2. Там же в **Variables** замени `DATABASE_URL` на значение из раздела 3.
   Volume `/data` **не отключай** — на нём файл, который будем переносить.
3. Задеплой ветку с переездом (merge в main). Дождись в логах «All migrations
   have been successfully applied».
4. Открой консоль контейнера backend (Railway CLI: `railway ssh`, выбрать
   сервис backend). Пробный прогон — ничего не пишет:

   ```bash
   node dist/tools/sqlite-to-postgres.js --sqlite /data/qwik.db --dry-run
   ```

   Если он нашёл проблемы (повторы номеров заказов, две открытые смены у
   одного кассира, «висячие» ссылки) — **не продолжай**: верни
   `DATABASE_URL` и старый деплой (см. «Откат») и разберись с данными.
5. Перенос:

   ```bash
   node dist/tools/sqlite-to-postgres.js --sqlite /data/qwik.db
   ```

   Должно закончиться строкой «Перенос завершён, все таблицы совпадают.» и
   кодом выхода 0. Рядом с базой появится снимок `/data/qwik.db.pre-postgres.db`.
6. **Включи кассы**: убери Custom Start Command и перезапусти backend. В
   логах — «Database connected» и **никаких** строк «Database locale does
   not fold Cyrillic» / «TimeZone is not UTC».
7. Проверь руками: вход в панель и на кассу, поиск товара по-русски и по
   артикулу строчными, одна тестовая продажа и её отмена.

Volume `/data` оставь подключённым неделю — пока не убедишься, что всё в
порядке. Потом его можно удалить.

### Откат

До шага 6 — просто верни прежний `DATABASE_URL=file:/data/qwik.db` и
задеплой предыдущий коммит: файл SQLite не тронут, касса вернётся как была.

После шага 6 кассы уже пишут в Postgres, и откат на SQLite потеряет всё
проданное с этого момента. Поэтому решай в первый час и только если что-то
сломано по-крупному.

Если перенос упал посередине (обрыв, таймаут), запусти его ещё раз с
`--truncate`: он очистит таблицы Postgres и скопирует всё заново. Снимок
предыдущей попытки удали или укажи другой путь через `--snapshot`.

---

## 4. Admin и Terminal: переменные

Обоим сервисам нужна одна переменная — внутренний адрес backend
(имя сервиса + порт):

```
BACKEND_URL=backend.railway.internal:3000
```

Проверить имя можно в сервисе `backend` → **Settings → Networking → Private
Networking**. Порт, на котором слушает контейнер, Railway подставляет сам —
в образах это учтено (`listen ${PORT}`).

---

## 5. Landing: переменные

```
ADMIN_URL=https://admin.qwik.uz
POS_URL=https://pos.qwik.uz
CONTACT_EMAIL=hello@qwik.uz
```

Ссылки подставляются в страницу при старте контейнера — пересобирать образ
при смене домена не нужно.

---

## 6. Свой домен

Для каждого публичного сервиса: **Settings → Networking → Custom Domain**.

| Сервис     | Домен                     |
|------------|---------------------------|
| `landing`  | `qwik.uz` и `www.qwik.uz` |
| `admin`    | `admin.qwik.uz`           |
| `terminal` | `pos.qwik.uz`             |

Railway покажет, какую DNS-запись добавить у регистратора:

- поддомены (`www`, `admin`, `pos`) — **CNAME** на выданный Railway адрес
  вида `xxxx.up.railway.app`. Это основной рабочий путь;
- корень `qwik.uz` без поддомена — CNAME на корень по стандарту DNS ставить
  нельзя. У регистраторов в зоне `.uz` обычно нет ALIAS/ANAME, поэтому два
  варианта:
  1. **Через Cloudflare** (бесплатно): переключить NS-серверы домена на
     Cloudflare и добавить там CNAME `qwik.uz → xxxx.up.railway.app` с
     включённым прокси — Cloudflare сам развернёт его в адрес (CNAME
     flattening). Тогда и корень, и `www` работают одинаково.
  2. **Редирект у регистратора**: оставить сайт на `www.qwik.uz`, а на корне
     включить web-forwarding (перенаправление) на `https://www.qwik.uz`.
     Такая услуга есть у большинства `.uz`-регистраторов.

### Записи, которые нужно добавить

| Тип   | Имя (host) | Значение                       |
|-------|------------|--------------------------------|
| CNAME | `www`      | адрес сервиса `landing` из Railway  |
| CNAME | `admin`    | адрес сервиса `admin` из Railway    |
| CNAME | `pos`      | адрес сервиса `terminal` из Railway |
| —     | `@` (корень) | Cloudflare CNAME flattening или редирект на `https://www.qwik.uz` |

Точные значения Railway показывает в карточке каждого Custom Domain — они
разные для каждого сервиса.

DNS расходится от нескольких минут до пары часов; TLS-сертификат Railway
выпустит сам, как только увидит запись. Статус — там же, в Custom Domain.

После появления доменов вернись в переменные и подставь реальные значения:
`CORS_ORIGIN` (backend), `ADMIN_URL` / `POS_URL` (landing).

---

## 7. Первый запуск

1. Открой `https://admin.qwik.uz` → **«Зарегистрироваться»**.
2. Заполни: название заведения, имя, email, пароль (от 8 символов) —
   создастся заведение и аккаунт администратора.
3. В **Настройках** выбери валюту и часовой пояс — от них зависят и цены,
   и отчёты «за сегодня».
4. Заведи категории и товары, поставь наценку категориям. Если наценка 0%,
   цена продажи задаётся вручную — так и задумано, иначе приход приравнял бы
   её к себестоимости.
5. В **Сотрудниках** добавь кассира (роль `cashier`, можно PIN) — он входит
   на `https://pos.qwik.uz`.

Demo-данные (`npm run db:seed`) на проде запускать **не нужно**: они создают
«Demo Restaurant» с общеизвестными паролями.

---

## 8. Проверка после деплоя

```bash
curl -I https://qwik.uz
curl -I https://admin.qwik.uz
curl -I https://pos.qwik.uz
```

Состояние склада и цен можно проверить прямо на проде:

```bash
railway run --service backend npm run check-inventory
```

Скрипт покажет товары с ценой ниже себестоимости, приходы без движений
склада и зависшие резервы.

---

## 9. Уведомления об ошибках и бэкапы

**Уведомления.** Сервер шлёт владельцу ошибки кода, сбои базы и ответы 5xx — свои и присланные кассой и админкой (`POST /api/client-errors`), — плюс «сервер запущен» после каждой выкатки или падения. Одинаковые ошибки склеиваются (повторы за 15 минут — счётчиком), в Telegram — не больше 20 сообщений в час. Обычные отказы («Недостаточно товара», «Неверный PIN») не шлются. Переменные — только у сервиса **backend**:

| Переменная | Откуда |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` → токен вида `123456:ABC…` |
| `TELEGRAM_CHAT_ID` | напишите боту любое сообщение, откройте `https://api.telegram.org/bot<токен>/getUpdates` — число в `"chat":{"id":…}` |
| `SENTRY_DSN` | sentry.io → проект (платформа Node.js) → Settings → Client Keys (DSN) |

Нет переменных — уведомлений нет, всё остальное работает. Сразу после сохранения переменных Railway перезапустит backend, и в Telegram придёт «🟢 Qwik · сервер запущен» — значит, всё подключено.

**Бэкапы.** Postgres — со встроенными бэкапами Railway (PITR): восстановление на любую минуту плюс ежедневные и еженедельные копии (`railway postgres pitr status|schedule list|backup list -s Postgres`). Восстановление — в новый сервис, рабочая база не трогается: `railway postgres pitr restore -s Postgres --at "2026-10-06 03:00"`, затем переключить `DATABASE_URL` backend на него.

## Частые проблемы

- **502 на admin/terminal** — неверный `BACKEND_URL` или backend ещё не
  поднялся. Проверь Private Networking и логи backend.
- **Домен не подтверждается** — DNS-запись ещё не разошлась либо у
  регистратора включён прокси, подменяющий CNAME. Проверь `dig CNAME admin.qwik.uz`.
- **Сканер не узнаёт товары по общей базе** — в логах backend нет строки
  «Barcode catalogue loaded / already loaded» (файл `catalog/` не попал в
  образ или загрузка упала — см. строку «Barcode catalogue import failed»).
- **backend не стартует, «DATABASE_URL должен быть postgresql://…»** — в
  переменных остался старый `file:/data/qwik.db`. Сначала перенос данных,
  см. «Переезд с SQLite на Postgres».
- **«Can't reach database server»** — сервис `Postgres` не создан или
  `DATABASE_URL` не ссылается на `${{Postgres.DATABASE_URL}}`.
- **CORS-ошибки в консоли** — в обычной работе их быть не должно (admin и
  terminal ходят к API через свой nginx). Если появились — добавь домен в
  `CORS_ORIGIN` backend.
- **В логах «Database locale does not fold Cyrillic»** — база создана с
  локалью C: поиск «молоко» не найдёт «Молоко». У Railway Postgres по
  умолчанию en_US.UTF-8; если база своя — пересоздай её с UTF-8-локалью.

---

## Обновление кода

```bash
git add . && git commit -m "..." && git push
```

Railway пересоберёт затронутые сервисы сам. Миграции применятся при старте
backend.
