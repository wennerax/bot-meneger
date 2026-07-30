# Telegram Bot Manager

Модульный шаблон Telegram-бота на Python и `aiogram 3`.

## Возможности

- `/start` регистрирует пользователя и приветствует его.
- `/help` показывает доступные команды.
- `/id` возвращает Telegram ID пользователя и чата.
- `/about` показывает информацию о боте.
- `/stats` доступна администраторам из `ADMIN_IDS` и показывает статистику пользователей.
- `/rules`, `/setrules` управляют правилами чата.
- `/warn`, `/unwarn`, `/warnings` ведут предупреждения пользователей.
- `/mute`, `/unmute`, `/ban`, `/unban` управляют доступом участников.
- `/filter`, `/unfilter` создают автоматические ответы по ключевым словам.
- Новые участники получают приветствие со ссылкой на правила.
- `/top` показывает отдельный топ участников по сообщениям в текущей группе.
- `/linktrigger on|off` включает мут на 1 день за ссылки.
- `/чс` или `/blacklist` навсегда банит участника и сохраняет его в чёрном списке.
- Команды наказаний принимают числовой ID, `@username` или ответ на сообщение.
- Команды разделены по роутерам, а их подключение выполняется в одном месте.

## Быстрый запуск

1. Создайте виртуальное окружение и установите зависимости:

	```powershell
	python -m venv .venv
	.\.venv\Scripts\Activate.ps1
	python -m pip install -r requirements.txt
	```

2. Скопируйте `.env.example` в `.env` и укажите токен бота от `@BotFather`.

3. Добавьте ID администраторов в `ADMIN_IDS` через запятую. В групповом чате выдайте боту права администратора с разрешением банить и ограничивать участников.

4. Запустите приложение:

	```powershell
	python -m app
	```

Наказания поддерживают срок и причину. Например, ответьте командой на сообщение или укажите ID:

```text
/mute 1d реклама
/ban 7d оскорбления
/warn спам
```

Также можно использовать username:

```text
/mute @username 1d реклама
/ban @username оскорбления
/чс @username повторные нарушения
```

`m` означает минуты, `h` часы, `d` дни. Если срок не указан, бан постоянный, а мут действует до ручного `/unmute`.

Команды `/top`, `/linktrigger` и `/чс` работают отдельно в каждой группе. Данные сохраняются в SQLite по пути `DATABASE_PATH`.

## Тесты

```powershell
python -m pytest
```

## Безопасность API-ключей

API-ключи (включая `AI_API_KEY`, `BOT_TOKEN` и другие приватные секреты) — конфиденциальны. Никогда не публикуйте их в чатах, исходниках репозиториев или скриншотах.

- Если ключ оказался публичен — немедленно отзовите/перегенерируйте его в панели провайдера.
- Храните ключи в файле `.env`, который должен быть добавлен в `.gitignore`.
- В этом проекте AI ключ читается только из файла `.env`.

- Пример строки в `.env`:

```env
AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AI_MODEL=gpt-4o-mini
AI_API_BASE_URL=https://api.openai.com/v1
```

Если вы используете OpenRouter AI, можно задать переменные с `OPENROUTER_` префиксом в `.env`:

```env
OPENROUTER_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_MODEL=gpt-4o-mini
OPENROUTER_API_BASE_URL=https://api.openrouter.ai/v1
```

- Никогда не записывайте ключи прямо в код или коммиты. Если вы случайно добавили ключ в репозиторий, удалите его из истории и регенерируйте ключ у провайдера.

### Проверка AI endpoint (локально)

Если вы хотите быстро проверить, корректно ли настроен ключ и endpoint, используйте один из примеров ниже (не публикуйте ключ публично).

curl (bash/unix):

```bash
curl -s -X POST "${OPENROUTER_API_BASE_URL:-https://api.openrouter.ai}/chat/completions" \
	-H "Authorization: Bearer $OPENROUTER_API_KEY" \
	-H "Content-Type: application/json" \
	-d '{"model":"openrouter","messages":[{"role":"user","content":"ping"}]}' | jq .
```

PowerShell (Windows):

```powershell
$body = @{ model='openrouter'; messages=@(@{ role='user'; content='ping' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri ($env:OPENROUTER_API_BASE_URL -or 'https://api.openrouter.ai') -Method POST -Headers @{ Authorization = "Bearer $env:OPENROUTER_API_KEY"; 'Content-Type' = 'application/json' } -Body $body
```

Ожидаемые результаты:
- Успех (200/201): endpoint работает.
- 401 Unauthorized: ключ неверный/отозван — сгенерируйте новый ключ в панели OpenRouter и обновите `.env`.
- Другие коды/ошибки: проверьте `OPENROUTER_API_BASE_URL` и формат запроса.


## Структура

```text
app/
  __main__.py       # точка запуска
  bot.py            # создание Dispatcher и подключение роутеров
  config.py         # чтение и проверка настроек
  handlers/         # отдельный модуль для каждой группы команд
  services/         # бизнес-логика без Telegram-зависимостей
tests/              # модульные тесты
```

Для остановки бота нажмите `Ctrl+C`.

SQLite хранит группы, админ-листы, сообщения, username пользователей, наказания, ссылочный триггер и чёрный список. Правила и автоматические текстовые фильтры пока остаются в памяти процесса.

Telegram не позволяет боту получить ID произвольного пользователя только по username. Поэтому username запоминается, когда пользователь пишет сообщение в группе. Если бот ещё не видел участника, используйте ответ на его сообщение или числовой ID.