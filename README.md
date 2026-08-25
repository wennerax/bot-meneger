# Telegram Bot Manager

Модульный Telegram-бот на Node.js и `telegraf`.

## Возможности

- Регистрация пользователей и приветствия.
- Управление группой: предупреждения, муты, баны и разбаны.
- Защита от ссылок, спама, пересланных сообщений и запрещённых слов.
- Правила группы, команды администратора и журналы модерации.
- ИИ для текстовых запросов и изображений через OpenAI или OpenRouter.
- `/top` показывает рейтинг участников текущей группы.

## Установка

Требуется Node.js 18 или новее.

```powershell
npm install
Copy-Item .env.example .env
```

Откройте `.env` и укажите токен бота:

```env
BOT_TOKEN=put-your-bot-token-here
ADMIN_IDS=123456789,987654321
RELOAD_ADMIN_IDS=123456789
BOT_NAME=Telegram Bot Manager
DATABASE_PATH=data/bot.json
```

`ADMIN_IDS` и `RELOAD_ADMIN_IDS` принимают список Telegram ID через запятую. В группе боту нужны права администратора для ограничений участников и удаления сообщений.

## Запуск

```powershell
npm start
```

В production задавайте секреты через переменные окружения. Файл `.env` в production не используется.

## ИИ

Можно использовать OpenAI:

```env
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

Или OpenRouter:

```env
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=gpt-4o-mini
OPENROUTER_API_BASE_URL=https://openrouter.ai/api/v1
```

Также поддерживаются универсальные переменные `AI_API_KEY`, `AI_MODEL` и `AI_API_BASE_URL`.

Никогда не публикуйте ключи в исходниках, коммитах, чатах или скриншотах. Файл `.env` должен оставаться локальным и быть добавлен в `.gitignore`.

## Тесты

```powershell
npm test
```

Для проверки только бота и модерации:

```powershell
npm test -- --test tests/bot.test.js tests/moderation_service.test.js
```

## Структура

```text
app/
  main.js              # запуск приложения
  bot.js               # создание бота и обработчики команд
  config.js            # загрузка конфигурации
  ai.js                # интеграция с ИИ
  handlers/            # обработчики сообщений
  services/            # база данных, пользователи и модерация
data/                  # локальные данные бота
tests/                 # тесты Node.js
package.json           # зависимости и npm-скрипты
```

Для остановки бота нажмите `Ctrl+C`. Данные по умолчанию сохраняются в `data/bot.json`.

