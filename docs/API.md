# Qwik POS API

REST API сервера кассы Qwik: товары и база штрихкодов, продажи и оплаты, смены, склад, приходы, техкарты, сотрудники и отчёты. Этим API пользуются касса (`pos-terminal`) и панель управления (`frontend-admin`); всё, что они умеют, можно сделать и своей программой.

- Адрес: `https://pos.qwik.uz/api` (тот же сервер отвечает на `https://admin.qwik.uz/api`), локально — `http://localhost:3000/api`.
- Формат: JSON, кодировка UTF-8.
- Маршруты — `backend/src/api/*.routes.ts`, схемы запросов — `backend/src/modules/*/*.schema.ts`. Меняете маршрут или схему — поправьте и этот файл.

## Быстрый старт

```bash
# 1. Вход по почте и паролю
curl -s https://pos.qwik.uz/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"manager@shop.uz","password":"••••••••"}'
# → {"success":true,"data":{"user":{…},"accessToken":"eyJ…","refreshToken":"eyJ…"}}

# 2. Товар по штрихкоду (или короткому коду)
curl -s 'https://pos.qwik.uz/api/products/lookup?code=4780000000113' \
  -H "Authorization: Bearer $TOKEN"

# 3. Продажа целиком: заказ + оплата одной операцией
curl -s https://pos.qwik.uz/api/orders/checkout \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: sale-2026-10-03-0001' \
  -d '{"type":"takeaway","cashShiftId":"<id открытой смены>",
       "items":[{"productId":"<id товара>","quantity":2}],
       "expectedTotal":27000,"payment":{"method":"cash"}}'
```

## Как устроено

### Формат ответа

Все ответы — JSON в одной обёртке. Успех: `success: true` и данные в `data`. Ошибка: `success: false` и текст в `error` — по-русски, его можно показывать человеку как есть.

```jsonc
{ "success": true,  "data": { … }, "message": "необязательно" }
{ "success": true,  "data": [ … ], "pagination": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 } }
{ "success": false, "error": "Товар не найден" }
```

### Коды ошибок

| Код | Когда |
|---|---|
| `400` | Не прошла проверка полей — текст перечисляет поля: `items.0.quantity: Number must be greater than or equal to 1`. Также бизнес-ошибки: смена закрыта, товара не хватает и т. п. |
| `401` | Нет токена, он просрочен или неверен. Обновите токен через `/auth/refresh`. |
| `403` | У роли нет права на это действие. |
| `404` | Запись не найдена (или принадлежит другой точке — чужие данные не видны). |
| `409` | Конфликт: цена изменилась и итог не совпал с `expectedTotal`, заказ уже закрыт и т. п. |
| `422` | Этот `Idempotency-Key` уже использован для другого запроса. |
| `429` | Слишком много запросов — см. «Лимиты». |
| `500` | Сбой сервера. Безопасно повторить с тем же `Idempotency-Key`. |

### Вход и токены

Запросы, кроме входа и `/api/health`, требуют заголовок `Authorization: Bearer <accessToken>`. Токен доступа живёт 15 минут (`JWT_EXPIRES_IN`), токен обновления — 7 дней (`JWT_REFRESH_EXPIRES_IN`). Новая пара — `POST /auth/refresh`. Смена пароля гасит все выданные раньше токены обновления.

Точка (магазин, кафе) определяется токеном: всё, что вы читаете и пишете, относится к точке вошедшего сотрудника. Передавать id точки не нужно.

Касса входит без почты: по коду точки получает список сотрудников с PIN (`GET /auth/staff`), кассир нажимает свою плитку и вводит PIN (`POST /auth/login-pin`).

### Роли

| Роль | Кто это | Что может |
|---|---|---|
| `admin` | Администратор, владелец | Всё, включая удаление сотрудников и назначение роли admin. |
| `manager` | Управляющий | Всё, кроме удаления сотрудников и назначения admin: товары, цены, склад, приходы, отчёты, возвраты, закрытие чужих смен. |
| `cashier` | Кассир | Продажа (`/orders/checkout`), оплаты, своя смена, приход товара, просмотр товаров и остатков. |
| `waiter` | Официант | Заказы и столы, без приёма оплаты. |
| `kitchen` | Кухня | Экран кухни: `/orders/kitchen` и шаги приготовления. |

### Повторы без двойных чеков: Idempotency-Key

Связь может оборваться посреди продажи, и программа не узнает, записал ли сервер чек. Чтобы повтор не создал второй чек и второе списание со склада, передавайте заголовок `Idempotency-Key` — уникальную строку на каждую продажу (8–128 символов: латиница, цифры и `. _ : -`).

- Работает на `POST /orders`, `POST /orders/checkout`, `POST /payments`, `POST /stock-receipts`.
- Повтор с тем же ключом и тем же телом возвращает уже созданную запись и заголовок `Idempotent-Replayed: true`.
- Тот же ключ с другим телом — ответ `422`.
- Сервер помнит ключи 7 дней: столько может идти чек, пробитый на кассе без связи.
- Если первая попытка упала с ошибкой, ключ не «сгорает» — повтор пройдёт заново.

### Списки, даты, деньги

- Списки постраничные: `?page=1&limit=20`, `limit` до 200. Всего записей и страниц — в `pagination`.
- Логические параметры в адресе — `true`/`false` (или `1`/`0`).
- Даты отчётов и фильтров: `YYYY-MM-DD` — календарный день в часовом поясе точки, обе границы включительно. Можно и полное время ISO 8601.
- Время в ответах — ISO 8601 в UTC (`2026-10-03T08:15:00.000Z`).
- Цены и суммы — числа в валюте точки (`currency` в настройках). Цену товара в чек сервер всегда берёт из каталога, а не из запроса (исключение — чек, пробитый без связи).
- Весовой товар: в строке заказа `grams` — вес одной порции, `quantity` — число порций; цена = цена за кг × вес.

### Лимиты

| Что | Сколько | Считается |
|---|---|---|
| Все запросы к API | 600 в минуту | на сотрудника (без токена — на IP) |
| `/auth/login`, `/auth/register` | 30 за 15 минут (`AUTH_RATE_LIMIT_MAX`) | на IP |
| `/auth/login-pin` | 8 неудачных за 10 минут | на сотрудника и IP; удачные входы не считаются |
| `/auth/staff` | 60 за 15 минут | на IP |

Ответ при превышении — `429`; заголовки `RateLimit-*` показывают остаток.

### События в реальном времени (Socket.IO)

Панель и экран кухни узнают о новых заказах без опроса сервера. Подключение — Socket.IO на том же адресе, путь `/socket.io`, токен доступа в `auth`. Клиент сам попадает в комнату своей точки; кухня, управляющий и администратор — ещё и в кухонную.

```js
import { io } from "socket.io-client";
const socket = io("https://pos.qwik.uz", { path: "/socket.io", auth: { token: accessToken } });
socket.on("order:created", (order) => { /* … */ });
```

| Событие | Кому | Когда |
|---|---|---|
| `order:created` | вся точка | создан заказ или пробита продажа |
| `order:new` | кухня | заказ пришёл на кухню |
| `order:updated` | вся точка | сменился статус заказа |
| `order:cancelled` | вся точка | заказ отменён |
| `order:kitchen` | вся точка | сменился шаг кухни (готовится, готов, выдан) |

В каждом событии — полный объект заказа, как в `GET /orders/:id`.

> Из браузера с чужого сайта запросы не пройдут: сервер разрешает CORS только своим доменам (`CORS_ORIGIN`). Интеграции (учёт, бухгалтерия, сайт) делайте со своего сервера.

## Эндпоинты

Всего 83. «Любой сотрудник» — любой вошедший, «без входа» — токен не нужен. Пути даны от `/api`.

- [Вход](#вход) — 7
- [Товары](#товары) — 9
- [База штрихкодов](#база-штрихкодов) — 4
- [Категории](#категории) — 7
- [Заказы и продажи](#заказы-и-продажи) — 9
- [Оплаты](#оплаты) — 4
- [Смены](#смены) — 5
- [Склад](#склад) — 4
- [Приходы товара](#приходы-товара) — 4
- [Техкарты](#техкарты) — 7
- [Столы](#столы) — 7
- [Сотрудники](#сотрудники) — 6
- [Настройки точки](#настройки-точки) — 2
- [Отчёты](#отчёты) — 3
- [Чеки](#чеки) — 2
- [Прочее](#прочее) — 3

### Вход

Вход по почте и паролю (панель), по PIN (касса), обновление токенов.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| POST | `/api/auth/login` | Вход по почте и паролю | без входа |
| POST | `/api/auth/register` | Регистрация новой точки и её администратора | без входа |
| GET | `/api/auth/staff` | Сотрудники точки для входа на кассе | без входа |
| POST | `/api/auth/login-pin` | Вход на кассе по PIN | без входа |
| POST | `/api/auth/refresh` | Новая пара токенов | без входа |
| POST | `/api/auth/change-password` | Сменить свой пароль | любой сотрудник |
| GET | `/api/auth/me` | Кто вошёл и его права на кассе | любой сотрудник |

#### POST /api/auth/login

Вход по почте и паролю. Кому: без входа.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `email` | `string` | почта сотрудника |
| `password` | `string` |  |

Пример:

```jsonc
{ "email": "manager@shop.uz", "password": "••••••••" }
```

Ответ (`data`):

```jsonc
{ "user": { "id", "email", "firstName", "lastName", "role", "avatarUrl" },
  "accessToken": "eyJ…", "refreshToken": "eyJ…" }
```

#### POST /api/auth/register

Регистрация новой точки и её администратора. Кому: без входа.

Создаёт точку и первого сотрудника с ролью admin. Код точки (для входа на кассе) получается из названия; при совпадении добавляется -2, -3…

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `email` | `string` |  |
| `password` | `string` | от 8 символов |
| `firstName` | `string` |  |
| `lastName` | `string` |  |
| `phone` | `string` | необязательно |
| `tenantName` | `string` | название точки |
| `businessType` | `cafe \| retail` | кафе или магазин; необязательно |

Ответ (`data`):

```jsonc
{ "user": { … }, "accessToken": "…", "refreshToken": "…" }
```

#### GET /api/auth/staff

Сотрудники точки для входа на кассе. Кому: без входа.

Только активные сотрудники с заданным PIN. Неизвестный код — `404` «Точка не найдена — проверьте код».

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `tenant` | `string` | код точки, например `ruslan-market` |

Ответ (`data`):

```jsonc
{ "tenantName": "Руслан Маркет",
  "staff": [ { "id", "firstName", "lastName", "avatarUrl", "role" } ] }
```

#### POST /api/auth/login-pin

Вход на кассе по PIN. Кому: без входа.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `tenant` | `string` | код точки |
| `userId` | `uuid` | id из /auth/staff |
| `pin` | `string` | 4–10 цифр |

Пример:

```jsonc
{ "tenant": "ruslan-market", "userId": "6fea51ae-…", "pin": "1234" }
```

Ответ (`data`):

```jsonc
{ "user": { … }, "accessToken": "…", "refreshToken": "…" }
```

#### POST /api/auth/refresh

Новая пара токенов. Кому: без входа.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `refreshToken` | `string` | токен обновления |

Ответ (`data`):

```jsonc
{ "accessToken": "…", "refreshToken": "…" }
```

#### POST /api/auth/change-password

Сменить свой пароль. Кому: любой сотрудник.

Все выданные раньше токены обновления перестают работать.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `currentPassword` | `string` |  |
| `newPassword` | `string` | от 8 символов |

### Товары

Каталог точки: товары, ингредиенты, остатки. По умолчанию список показывает только товары в продаже (isActive=true).

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/products` | Список товаров | любой сотрудник |
| GET | `/api/products/lookup` | Товар по штрихкоду или короткому коду | любой сотрудник |
| GET | `/api/products/ingredients` | Ингредиенты для техкарт | любой сотрудник |
| GET | `/api/products/:id` | Один товар | любой сотрудник |
| GET | `/api/products/:id/tech-card-cost` | Себестоимость по техкарте | любой сотрудник |
| POST | `/api/products` | Создать товар | admin, manager |
| PUT | `/api/products/:id` | Изменить товар | admin, manager |
| DELETE | `/api/products/:id` | Удалить товар | admin, manager |
| POST | `/api/products/:id/stock` | Поправить остаток | admin, manager |

#### GET /api/products

Список товаров. Кому: любой сотрудник.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `search` | `string` | по названию, артикулу, штрихкоду |
| `categoryId` | `uuid` |  |
| `isActive` | `bool` | по умолчанию true |
| `isIngredient` | `bool` | ингредиенты техкарт |
| `minPrice / maxPrice` | `number` |  |
| `inStock` | `bool` | только с остатком |
| `weighted` | `bool` | весовые (кг, г) |
| `noBarcode` | `bool` | без штрихкода (хлеб, развес) |
| `tag` | `string` | например `quick` — быстрые кнопки кассы |
| `sort` | `name \| price \| createdAt \| sortOrder` | по умолчанию sortOrder |
| `order` | `asc \| desc` |  |
| `page, limit` | `number` | limit до 200 |

#### GET /api/products/lookup

Товар по штрихкоду или короткому коду. Кому: любой сотрудник.

Точное совпадение: сначала штрихкод, потом короткий код (SKU). Так касса обрабатывает скан. Нет товара — `404` «Товар не найден».

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `code` | `string` | штрихкод или код, до 64 символов |

#### POST /api/products

Создать товар. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `name` | `string` | обязательно |
| `price` | `number` | цена продажи, обязательно |
| `costPrice` | `number` | себестоимость |
| `categoryId` | `uuid` |  |
| `barcode, sku` | `string` | штрихкод и короткий код |
| `saleUnit` | `string` | `кг` — весовой товар, цена за кг |
| `currentStock, minStock` | `number` | остаток и порог «мало» |
| `trackInventory` | `bool` | вести остаток |
| `isIngredient` | `bool` |  |
| `techCardId` | `uuid` | техкарта блюда |
| `taxRate` | `number` | 0–100 |
| `tags` | `string[]` | `["quick"]` — быстрая кнопка на кассе |
| `imageUrl, description` | `string` |  |
| `isActive` | `bool` |  |

Пример:

```jsonc
{ "name": "Молоко «Лактис» 3,2% 1 л", "barcode": "4780000000113",
  "price": 13500, "costPrice": 11000, "currentStock": 60, "trackInventory": true }
```

#### PUT /api/products/:id

Изменить товар. Кому: admin, manager.

Любые поля из «Создать товар»; пустая строка очищает поле.

#### POST /api/products/:id/stock

Поправить остаток. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `quantity` | `number` | на сколько изменить: плюс — добавить, минус — списать; не 0 |
| `reason` | `string` | причина, попадёт в журнал движений |

Пример:

```jsonc
{ "quantity": -2, "reason": "Бой при разгрузке" }
```

### База штрихкодов

Общая база: 137 тыс. товаров (Open Food Facts) плюс национальный каталог Узбекистана с ИКПУ. По скану подставляет название, объём, полку — магазину остаётся ввести цену.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/catalog/lookup` | Что за товар по штрихкоду | любой сотрудник |
| POST | `/api/catalog/lookup` | То же, с записью из национального каталога | любой сотрудник |
| GET | `/api/catalog/stats` | Сколько товаров в базе | любой сотрудник |
| POST | `/api/catalog/add` | Поставить товар на полку по скану | admin, manager |

#### GET /api/catalog/lookup

Что за товар по штрихкоду. Кому: любой сотрудник.

`valid: false` — код не мировой (ошибка набора или внутренняя этикетка магазина).

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `code` | `string` | штрихкод, до 32 символов |

Ответ (`data`):

```jsonc
{ "found": true, "barcode": "4780000000113", "name": "…", "brand": "…",
  "quantity": "1 л", "category": "Молочные продукты", "displayName": "…",
  "ikpu": "10401001001000000", "source": "snapshot | off | tasnif | crowd" }
// не найден:
{ "found": false, "barcode": "…", "valid": true }
```

#### POST /api/catalog/lookup

То же, с записью из национального каталога. Кому: любой сотрудник.

Сервер на Railway не всегда может достучаться до tasnif.soliq.uz, поэтому касса спрашивает его сама и передаёт ответ сюда.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `code` | `string` |  |
| `national` | `object` | что вернул tasnif.soliq.uz; необязательно |

#### POST /api/catalog/add

Поставить товар на полку по скану. Кому: admin, manager.

Создаёт товар точки из записи базы с вашей ценой. Полку можно указать названием — найдётся или создастся.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `barcode` | `string` | 4–14 цифр |
| `name` | `string` |  |
| `price` | `number` |  |
| `costPrice` | `number` |  |
| `categoryId` | `uuid` | или categoryName |
| `categoryName` | `string` | например «Напитки» |
| `weighed` | `bool` | продаётся на вес, цена за кг |
| `stock` | `number` | остаток; не указан — без учёта |
| `ikpu` | `string` | 17 цифр |

Пример:

```jsonc
{ "barcode": "4780000000113", "name": "Молоко «Лактис» 3,2% 1 л",
  "price": 13500, "categoryName": "Молочные продукты", "stock": 24 }
```

### Категории

Полки и разделы меню. Наценка категории используется при приходе товара.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/categories` | Список | любой сотрудник |
| GET | `/api/categories/tree` | Деревом (с подкатегориями) | любой сотрудник |
| GET | `/api/categories/:id` | Одна категория | любой сотрудник |
| POST | `/api/categories` | Создать | admin, manager |
| PUT | `/api/categories/:id` | Изменить | admin, manager |
| DELETE | `/api/categories/:id` | Удалить | admin, manager |
| POST | `/api/categories/reorder` | Порядок категорий | admin, manager |

#### POST /api/categories

Создать. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `name` | `string` |  |
| `parentId` | `uuid` | родитель |
| `color` | `#RRGGBB` |  |
| `markupPercent` | `number` | наценка 0–1000 % |
| `sortOrder` | `int` |  |
| `isIngredient` | `bool` |  |
| `description, imageUrl` | `string` |  |

#### POST /api/categories/reorder

Порядок категорий. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `ids` | `uuid[]` | id в нужном порядке |

### Заказы и продажи

Продажа на кассе магазина — один запрос `/orders/checkout`: заказ, списание со склада и оплата в одной транзакции. В кафе — заказ (`POST /orders`), кухня, затем оплата (`POST /payments`).

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| POST | `/api/orders/checkout` | Продажа: заказ и оплата одной операцией · Idempotency-Key | admin, manager, cashier |
| POST | `/api/orders` | Создать заказ (без оплаты) · Idempotency-Key | любой сотрудник |
| GET | `/api/orders` | Список заказов | admin, manager |
| GET | `/api/orders/active` | Открытые заказы | любой сотрудник |
| GET | `/api/orders/kitchen` | Экран кухни | admin, manager, kitchen |
| GET | `/api/orders/:id` | Один заказ | любой сотрудник |
| PATCH | `/api/orders/:id/status` | Сменить статус | любой сотрудник |
| PATCH | `/api/orders/:id/kitchen` | Шаг кухни | admin, manager, kitchen |
| POST | `/api/orders/:id/cancel` | Отменить заказ | любой сотрудник |

#### POST /api/orders/checkout

Продажа: заказ и оплата одной операцией. Кому: admin, manager, cashier. Поддерживает `Idempotency-Key`.

Цены строк сервер берёт из каталога и сверяет итог с `expectedTotal` — суммой, которую видел кассир. Не совпало (цену поменяли) — `409` с настоящей суммой в `actualTotal`; ничего не записано.

Часть `debt` (в долг) у кассира со снятой галочкой «Продажа в долг» — `403`, ничего не записано.

**Продажа без связи.** Касса магазина без интернета пробивает чек за наличные и отправляет его позже с полем `offline`. Тогда сервер не спорит: цена — та, по которой продали (`unitPrice` каждой строки), смена может быть уже закрыта, товара может не хватить — остаток уходит в минус. Заказ получает пометки `offlineAt`, `offlineShortfall`, `offlinePriceChanged`. Только наличные; время продажи — не позже 5 минут вперёд и не старше 30 дней.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `type` | `takeaway \| dine_in \| delivery \| online` | в магазине — takeaway |
| `cashShiftId` | `uuid` | открытая смена кассира |
| `items[]` | `array` | строки чека, минимум одна |
| `items[].productId` | `uuid` |  |
| `items[].quantity` | `int ≥ 1` |  |
| `items[].grams` | `number` | весовой товар: вес одной порции |
| `items[].unitPrice` | `number` | только для offline: цена, по которой продали |
| `items[].modifierIds` | `uuid[]` | модификаторы (кафе) |
| `expectedTotal` | `number` | итог, который видел кассир |
| `payment.method` | `cash \| card \| qr \| online \| gift_card` |  |
| `payment.tipAmount` | `number` | чаевые |
| `payment.transactionId, cardLastFour` | `string` | данные терминала банка |
| `customerName, customerPhone, notes` | `string` |  |
| `discountAmount` | `number` | скидка |
| `offline.soldAt` | `ISO 8601` | когда пробили на кассе |
| `offline.cashierId` | `uuid` | кто пробил |

Пример:

```jsonc
// Обычная продажа
{ "type": "takeaway", "cashShiftId": "11111111-…",
  "items": [ { "productId": "…", "quantity": 2 },
             { "productId": "…", "quantity": 1, "grams": 1500 } ],
  "expectedTotal": 37000, "payment": { "method": "cash" } }

// Чек, пробитый без связи
{ "type": "takeaway", "cashShiftId": "11111111-…",
  "items": [ { "productId": "…", "quantity": 2, "unitPrice": 5000 } ],
  "expectedTotal": 10000, "payment": { "method": "cash" },
  "offline": { "soldAt": "2026-10-03T08:15:00.000Z", "cashierId": "…" } }
```

Ответ (`data`):

```jsonc
201 { "id", "orderNumber", "status": "completed", "total", "items": [ … ],
      "payments": [ … ], "offlineAt": null, "offlineShortfall": false, … }
409 { "success": false,
      "error": "Сумма заказа изменилась — цены обновлены, проверьте корзину",
      "actualTotal": 38000 }
```

#### POST /api/orders

Создать заказ (без оплаты). Кому: любой сотрудник. Поддерживает `Idempotency-Key`.

Заказ ждёт оплаты, остаток резервируется. Неоплаченный заказ сам отменяется через 30 минут и возвращает резерв.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `type` | `dine_in \| takeaway \| delivery \| online` |  |
| `items[]` | `array` | как в checkout, без unitPrice |
| `tableId` | `uuid` | стол (кафе) |
| `cashShiftId, branchId` | `uuid` |  |
| `customerName, customerPhone, notes` | `string` |  |
| `discountAmount` | `number` |  |

#### GET /api/orders

Список заказов. Кому: admin, manager.

У каждого заказа — строки, оплаты, кассир, стол и пометки офлайн-продажи.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `status` | `string` | pending, completed, cancelled… |
| `type` | `string` |  |
| `dateFrom, dateTo` | `YYYY-MM-DD` | дни точки |
| `search` | `string` | номер, клиент |
| `tableId, branchId` | `uuid` |  |
| `sort` | `createdAt \| total \| orderNumber` |  |
| `order` | `asc \| desc` |  |
| `page, limit` | `number` |  |

#### PATCH /api/orders/:id/status

Сменить статус. Кому: любой сотрудник.

Отмена — не здесь, а через `/cancel`: только она возвращает резерв на склад и освобождает стол.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `status` | `confirmed \| preparing \| ready \| served \| completed` |  |

#### PATCH /api/orders/:id/kitchen

Шаг кухни. Кому: admin, manager, kitchen.

Можно вернуть на любой шаг, если нажали не на той карточке.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `status` | `new \| cooking \| ready \| served` | served — выдан, уходит с экрана |

#### POST /api/orders/:id/cancel

Отменить заказ. Кому: любой сотрудник.

Возвращает резерв на склад, освобождает стол. Завершённый или уже отменённый заказ — `409`.

### Оплаты

Оплата отдельного заказа (кафе) и возвраты. На кассе магазина оплата идёт сразу в `/orders/checkout`.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| POST | `/api/payments` | Принять оплату заказа · Idempotency-Key | admin, manager, cashier |
| GET | `/api/payments` | Список оплат | admin, manager |
| GET | `/api/payments/summary` | Итоги по способам оплаты | admin, manager |
| POST | `/api/payments/:id/refund` | Возврат | admin, manager |

#### POST /api/payments

Принять оплату заказа. Кому: admin, manager, cashier. Поддерживает `Idempotency-Key`.

Оплата меньше остатка по заказу отклоняется, если не передать `allowPartial: true` — чтобы устаревший итог на клиенте не записал недоплату как готовую продажу.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `orderId` | `uuid` |  |
| `method` | `cash \| card \| qr \| online \| split \| gift_card` |  |
| `amount` | `number` | больше 0 |
| `allowPartial` | `bool` | разрешить частичную оплату |
| `tipAmount` | `number` |  |
| `transactionId, cardLastFour` | `string` |  |

#### GET /api/payments

Список оплат. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `method` | `cash \| card \| qr \| online \| split \| gift_card` |  |
| `status` | `pending \| completed \| refunded \| failed` |  |
| `orderId` | `uuid` |  |
| `page, limit` | `number` |  |

#### GET /api/payments/summary

Итоги по способам оплаты. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `dateFrom, dateTo` | `YYYY-MM-DD` |  |

#### POST /api/payments/:id/refund

Возврат. Кому: admin, manager.

Оплата переходит в статус refunded и выпадает из итогов смены.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `reason` | `string` | причина |

### Смены

Кассовая смена: открытие с суммой в ящике, итоги по наличным, карте и QR, расхождение при закрытии. Итоги считаются по заказам смены, поэтому несколько касс друг другу не мешают.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/cash-shifts/current` | Моя открытая смена | любой сотрудник |
| POST | `/api/cash-shifts/open` | Открыть смену | любой сотрудник |
| POST | `/api/cash-shifts/:id/close` | Закрыть смену | любой сотрудник |
| GET | `/api/cash-shifts/:id` | Одна смена | любой сотрудник |
| GET | `/api/cash-shifts` | Все смены | admin, manager |

#### GET /api/cash-shifts/current

Моя открытая смена. Кому: любой сотрудник.

Открытая смена вошедшего сотрудника с живыми итогами или `null`.

Кассиру со снятой галочкой «Видит сумму смены» («слепое» закрытие) итоги, `expectedCash` и `difference` не отдаются ни здесь, ни в `GET /cash-shifts/:id`, ни в ответе на закрытие; вместо них — `blind: true`. Администратор и менеджер видят всё.

#### POST /api/cash-shifts/open

Открыть смену. Кому: любой сотрудник.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `openingCash` | `number` | наличные в ящике на начало; по умолчанию 0 |
| `notes` | `string` |  |

#### POST /api/cash-shifts/:id/close

Закрыть смену. Кому: любой сотрудник.

Своя смена — любой сотрудник; чужую (брошенную кассиром) — управляющий или администратор. Касса не даёт закрыть смену, пока не отправлены чеки, пробитые без связи.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `closingCash` | `number` | сколько насчитали в ящике |
| `notes` | `string` |  |

Ответ (`data`):

```jsonc
{ "totalSales", "totalCashSales", "totalCardSales", "totalQrSales", "totalTips",
  "totalRefunds", "expectedCash", "closingCash", "difference", "closedAt", … }
```

#### GET /api/cash-shifts

Все смены. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `status` | `open \| closed` |  |
| `userId` | `uuid` |  |
| `page, limit` | `number` |  |

### Склад

Остатки и журнал движений. Каждое изменение остатка — продажа, приход, ручная правка — записывается в журнал.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/inventory/stock` | Остатки | любой сотрудник |
| GET | `/api/inventory/movements` | Журнал движений | любой сотрудник |
| GET | `/api/inventory/alerts` | Заканчивается | любой сотрудник |
| POST | `/api/inventory/:id/adjust` | Поправить остаток товара | admin, manager |

#### GET /api/inventory/stock

Остатки. Кому: любой сотрудник.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `lowStock` | `bool` | только ниже порога |
| `categoryId` | `uuid` |  |
| `search` | `string` |  |
| `page, limit` | `number` |  |

#### GET /api/inventory/movements

Журнал движений. Кому: любой сотрудник.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `productId` | `uuid` |  |
| `type` | `in \| out` |  |
| `page, limit` | `number` |  |

#### GET /api/inventory/alerts

Заканчивается. Кому: любой сотрудник.

Товары с остатком ниже минимального.

#### POST /api/inventory/:id/adjust

Поправить остаток товара. Кому: admin, manager.

`:id` — id товара. То же, что `POST /products/:id/stock`.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `quantity` | `number` | плюс или минус, не 0 |
| `reason` | `string` |  |

### Приходы товара

Накладная поставщика: увеличивает остатки и обновляет себестоимость. Цену продажи меняет, только если об этом попросили.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| POST | `/api/stock-receipts` | Оформить приход · Idempotency-Key | admin, manager, cashier |
| GET | `/api/stock-receipts` | Список приходов | admin, manager |
| GET | `/api/stock-receipts/:id` | Один приход | admin, manager |
| DELETE | `/api/stock-receipts/:id` | Удалить приход | admin, manager |

#### POST /api/stock-receipts

Оформить приход. Кому: admin, manager, cashier. Поддерживает `Idempotency-Key`.

Кассиру со снятой галочкой «Приход товара» — `403`.

В строке — существующий товар (`productId`) или новый (`newProduct`), он создастся. Новому товару цена продажи считается от себестоимости и наценки категории.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `supplierName, invoiceNumber, notes` | `string` |  |
| `items[].productId` | `uuid` | или newProduct |
| `items[].newProduct` | `{ name, categoryId \| newCategoryName, unit }` |  |
| `items[].quantity` | `number` | больше 0 |
| `items[].costPrice` | `number` | цена закупки за единицу |
| `items[].updateSalePrice` | `bool` | пересчитать цену продажи по наценке |
| `items[].salePrice` | `number` | или задать её прямо |

Пример:

```jsonc
{ "supplierName": "Lactel", "invoiceNumber": "ТН-0412",
  "items": [ { "productId": "…", "quantity": 24, "costPrice": 11000 },
             { "newProduct": { "name": "Кефир 1 л", "newCategoryName": "Молочные" },
               "quantity": 12, "costPrice": 9000 } ] }
```

#### GET /api/stock-receipts

Список приходов. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `dateFrom, dateTo` | `YYYY-MM-DD` |  |
| `supplierName` | `string` |  |
| `page, limit` | `number` |  |

### Техкарты

Рецепты блюд: при оплате ингредиенты списываются со склада с точностью до грамма.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/tech-cards` | Список | любой сотрудник |
| GET | `/api/tech-cards/:id` | Одна техкарта | любой сотрудник |
| POST | `/api/tech-cards` | Создать | admin, manager |
| PUT | `/api/tech-cards/:id` | Изменить | admin, manager |
| DELETE | `/api/tech-cards/:id` | Удалить | admin, manager |
| POST | `/api/tech-cards/:id/copy` | Копия | admin, manager |
| POST | `/api/tech-cards/:id/recalculate` | Пересчитать себестоимость | admin, manager |

#### GET /api/tech-cards

Список. Кому: любой сотрудник.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `search` | `string` |  |
| `isActive` | `bool` |  |
| `sort` | `name \| totalCost \| createdAt` |  |
| `order` | `asc \| desc` |  |
| `page, limit` | `number` |  |

#### POST /api/tech-cards

Создать. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `name` | `string` |  |
| `ingredients[]` | `{ ingredientId, quantity, unit, grossWeight?, netWeight? }` |  |
| `output` | `number` | выход блюда |
| `unit` | `string` |  |

### Столы

Зал кафе.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/tables` | Список | любой сотрудник |
| GET | `/api/tables/stats` | Сколько свободно и занято | любой сотрудник |
| GET | `/api/tables/:id` | Один стол | любой сотрудник |
| POST | `/api/tables` | Добавить стол | admin, manager |
| PUT | `/api/tables/:id` | Изменить | admin, manager |
| PATCH | `/api/tables/:id/status` | Статус стола | любой сотрудник |
| DELETE | `/api/tables/:id` | Удалить | admin, manager |

#### GET /api/tables

Список. Кому: любой сотрудник.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `branchId` | `uuid` |  |

#### POST /api/tables

Добавить стол. Кому: admin, manager.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `number` | `string` | номер |
| `capacity` | `int` | 1–100 мест |
| `zone` | `string` | зал, веранда |
| `positionX, positionY` | `number` | место на схеме |
| `branchId` | `uuid` |  |

#### PATCH /api/tables/:id/status

Статус стола. Кому: любой сотрудник.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `status` | `available \| occupied \| reserved \| maintenance` |  |

### Сотрудники

Сотрудники точки. PIN нужен для входа на кассе по плитке.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/users` | Список | admin, manager |
| GET | `/api/users/:id` | Один сотрудник | admin, manager |
| POST | `/api/users` | Добавить сотрудника | admin, manager |
| PUT | `/api/users/:id` | Изменить | admin, manager |
| POST | `/api/users/:id/toggle` | Включить или выключить | admin, manager |
| DELETE | `/api/users/:id` | Удалить | admin |

#### GET /api/users

Список. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `search` | `string` |  |
| `role` | `admin \| manager \| cashier \| waiter \| kitchen` |  |
| `isActive` | `bool` |  |
| `page, limit` | `number` |  |

#### POST /api/users

Добавить сотрудника. Кому: admin, manager.

Назначить роль `admin` может только администратор — иначе `403`.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `email` | `string` |  |
| `password` | `string` | от 8 символов |
| `firstName, lastName` | `string` |  |
| `phone` | `string` |  |
| `pin` | `string` | 4–10 цифр, для кассы |
| `role` | `admin \| manager \| cashier \| waiter \| kitchen` |  |
| `isActive` | `bool` |  |
| `canSellOnDebt` | `bool` | право продавать в долг; по умолчанию `true` |
| `canReceiveStock` | `bool` | право оформлять приход (и новые товары в нём); по умолчанию `true` |
| `canSeeExpectedCash` | `bool` | видит итоги и ожидаемую наличность смены; `false` — «слепое» закрытие |

Права касаются кассира и официанта; администратору и менеджеру разрешено всё. Сервер проверяет их при каждом действии по базе, а не по токену: снятая галочка действует сразу. `GET /auth/me` и ответ на вход отдают `permissions` — касса прячет по ним кнопки.

#### PUT /api/users/:id

Изменить. Кому: admin, manager.

Любые поля; пароль — по желанию.

### Настройки точки

Название, тип, валюта, часовой пояс, налоги.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/settings` | Настройки | любой сотрудник |
| PUT | `/api/settings` | Изменить настройки | admin, manager |

#### PUT /api/settings

Изменить настройки. Кому: admin, manager.

Принимаются только перечисленные поля, остальные игнорируются.

Тело запроса (JSON):

| Поле | Тип | Описание |
|---|---|---|
| `name` | `string` | название |
| `businessType` | `cafe \| retail` | касса кафе или магазина |
| `currency` | `string` | UZS, USD, EUR, RUB, KZT |
| `timezone` | `string` | например Asia/Tashkent |
| `taxRate` | `number` |  |
| `defaultMarkupPercent` | `number` | наценка по умолчанию |
| `catalogSharing` | `bool` | делиться товарами с общей базой штрихкодов |
| `phone, email, address, logoUrl` | `string` |  |
| `settings` | `object` | прочие настройки |

### Отчёты

Даты — календарные дни в часовом поясе точки, обе включительно.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/reports/dashboard` | Сводка для главной | любой сотрудник |
| GET | `/api/reports/sales` | Продажи за период | admin, manager |
| GET | `/api/reports/employees` | Продажи по сотрудникам | admin, manager |

#### GET /api/reports/dashboard

Сводка для главной. Кому: любой сотрудник.

Выручка за сегодня, неделю, месяц и всего, чаевые, число оплат, заказы по типам.

#### GET /api/reports/sales

Продажи за период. Кому: admin, manager.

Выручка по часам, топ товаров, средний чек.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `dateFrom` | `YYYY-MM-DD` | обязательно |
| `dateTo` | `YYYY-MM-DD` | обязательно |

#### GET /api/reports/employees

Продажи по сотрудникам. Кому: admin, manager.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `dateFrom` | `YYYY-MM-DD` | обязательно |
| `dateTo` | `YYYY-MM-DD` | обязательно |

### Чеки

Печатная форма чека.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/receipts/:orderId` | Чек для печати (HTML) | любой сотрудник |
| POST | `/api/receipts/:orderId/print` | Отметить чек напечатанным | любой сотрудник |

#### GET /api/receipts/:orderId

Чек для печати (HTML). Кому: любой сотрудник.

Ответ — страница `text/html`, не JSON.

#### POST /api/receipts/:orderId/print

Отметить чек напечатанным. Кому: любой сотрудник.

Ответ (`data`):

```jsonc
{ "printed": true }
```

### Прочее

Уведомления, журнал действий, проверка связи.

| Метод | Путь | Что делает | Кому |
|---|---|---|---|
| GET | `/api/notifications` | Уведомления | любой сотрудник |
| GET | `/api/audit` | Журнал действий | admin, manager |
| GET | `/api/health` | Сервер жив | без входа |

#### GET /api/notifications

Уведомления. Кому: любой сотрудник.

Ответ (`data`):

```jsonc
{ "notifications": [ { "id", "type": "order | stock", "title", "message", "read", "createdAt" } ],
  "unreadCount": 3 }
```

#### GET /api/audit

Журнал действий. Кому: admin, manager.

Кто, что и когда сделал, с IP.

Параметры адреса:

| Поле | Тип | Описание |
|---|---|---|
| `userId` | `uuid` |  |
| `entityType` | `string` | order, product, user… |
| `action` | `string` | например order.checkout |
| `page, limit` | `number` |  |

#### GET /api/health

Сервер жив. Кому: без входа.

Касса проверяет по нему связь каждые 20 секунд.

Ответ (`data`):

```jsonc
{ "status": "ok", "timestamp": "2026-10-03T10:15:00.000Z" }
```
