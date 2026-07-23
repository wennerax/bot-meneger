from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import ChatMemberUpdated, ChatPermissions, Message
from datetime import datetime, timedelta, timezone
import re

from app.config import Settings
from app.services.database import Database
from app.services.moderation_service import ModerationService

router = Router(name="moderation")


def _target_user(
    message: Message,
    command: CommandObject,
    database: Database,
) -> tuple[int, str] | None:
    if message.reply_to_message and message.reply_to_message.from_user:
        user = message.reply_to_message.from_user
        return user.id, user.full_name
    if command.args:
        value = command.args.split(maxsplit=1)[0]
        if value.lstrip("-").isdigit():
            return int(value), value
        if value.startswith("@"):
            return database.resolve_username(message.chat.id, value)
    return None


def _is_admin(message: Message, config: Settings, database: Database) -> bool:
    return message.from_user is not None and database.is_admin(
        message.chat.id, message.from_user.id, config.admin_ids
    )


@router.message(F.new_chat_members)
async def new_member_message(message: Message) -> None:
    names = ", ".join(user.full_name for user in message.new_chat_members)
    await message.answer(f"Добро пожаловать, {names}! Ознакомьтесь с правилами через /rules.")


async def _require_admin(message: Message, config: Settings, database: Database) -> bool:
    if _is_admin(message, config, database):
        return True
    await message.answer("Эта команда доступна только администраторам.")
    return False


def _punishment_details(command: CommandObject, has_reply: bool) -> tuple[timedelta | None, str]:
    parts = command.args.split() if command.args else []
    if not has_reply and parts:
        parts = parts[1:]
    duration = None
    if parts and re.fullmatch(r"\d+[mhd]", parts[0].lower()):
        amount, unit = int(parts[0][:-1]), parts[0][-1].lower()
        duration = timedelta(**{"minutes": amount} if unit == "m" else {
            "hours" if unit == "h" else "days": amount
        })
        parts.pop(0)
    return duration, " ".join(parts).strip() or "Без причины"


@router.my_chat_member()
async def bot_added_to_group(event: ChatMemberUpdated, bot: Bot, database: Database) -> None:
    if event.chat.type not in {"group", "supergroup"}:
        return
    if event.new_chat_member.user.id != (await bot.me()).id:
        return
    if event.new_chat_member.status not in {"member", "administrator"}:
        return
    owner_id = None
    for member in await bot.get_chat_administrators(event.chat.id):
        if member.status == "creator":
            owner_id = member.user.id
            break
    database.ensure_group(event.chat.id, event.chat.title or str(event.chat.id), owner_id)
    await bot.send_message(event.chat.id, "Я подключён. Владелец группы добавлен в админ-лист.")


@router.message(Command("rules"))
async def rules_command(message: Message, moderation_service: ModerationService) -> None:
    await message.answer(moderation_service.get_rules(message.chat.id))


@router.message(Command("setrules"))
async def set_rules_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    if not await _require_admin(message, config, database):
        return
    if not command.args:
        await message.answer("Использование: /setrules текст правил")
        return
    moderation_service.set_rules(message.chat.id, command.args.strip())
    await message.answer("Правила чата обновлены.")


@router.message(Command("warn"))
async def warn_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    _, reason = _punishment_details(command, bool(message.reply_to_message))
    count = moderation_service.add_warning(message.chat.id, target[0])
    database.add_punishment(message.chat.id, target[0], "warn", reason, None)
    await message.answer(f"Предупреждение для {target[1]}: {count}/3. Причина: {reason}")


@router.message(Command("warnings"))
async def warnings_command(
    message: Message,
    command: CommandObject,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    target = _target_user(message, command, database)
    user_id = target[0] if target else message.from_user.id if message.from_user else None
    if user_id is None:
        await message.answer("Не удалось определить пользователя.")
        return
    await message.answer(
        f"Предупреждений: {moderation_service.get_warnings(message.chat.id, user_id)}/3"
    )


@router.message(Command("unwarn"))
async def unwarn_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    moderation_service.reset_warnings(message.chat.id, target[0])
    await message.answer(f"Предупреждения пользователя {target[1]} сброшены.")


@router.message(Command("mute"))
async def mute_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    bot: Bot,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    duration, reason = _punishment_details(command, bool(message.reply_to_message))
    until_at = datetime.now(timezone.utc) + duration if duration else None
    await bot.restrict_chat_member(
        chat_id=message.chat.id,
        user_id=target[0],
        permissions=ChatPermissions(can_send_messages=False),
        until_date=until_at,
    )
    database.add_punishment(message.chat.id, target[0], "mute", reason, until_at)
    await message.answer(f"Пользователь {target[1]} ограничен. Причина: {reason}")


@router.message(Command("unmute"))
async def unmute_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    bot: Bot,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    await bot.restrict_chat_member(
        chat_id=message.chat.id,
        user_id=target[0],
        permissions=ChatPermissions(can_send_messages=True, can_send_other_messages=True),
    )
    await message.answer(f"Ограничения с пользователя {target[1]} сняты.")


@router.message(Command("ban"))
async def ban_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    bot: Bot,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    duration, reason = _punishment_details(command, bool(message.reply_to_message))
    until_at = datetime.now(timezone.utc) + duration if duration else None
    await bot.ban_chat_member(chat_id=message.chat.id, user_id=target[0], until_date=until_at)
    database.add_punishment(message.chat.id, target[0], "ban", reason, until_at)
    await message.answer(f"Пользователь {target[1]} заблокирован. Причина: {reason}")


@router.message(Command("unban"))
async def unban_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    bot: Bot,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Использование: /unban числовой_ID")
        return
    await bot.unban_chat_member(chat_id=message.chat.id, user_id=target[0])
    await message.answer(f"Пользователь {target[1]} разблокирован.")


@router.message(Command("filter"))
async def filter_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    if not await _require_admin(message, config, database):
        return
    if not command.args or "=" not in command.args:
        await message.answer("Использование: /filter слово = ответ")
        return
    keyword, response = command.args.split("=", maxsplit=1)
    if not keyword.strip() or not response.strip():
        await message.answer("И слово, и ответ должны быть заполнены.")
        return
    moderation_service.add_filter(message.chat.id, keyword.strip(), response.strip())
    await message.answer("Фильтр добавлен.")


@router.message(Command("unfilter"))
async def unfilter_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    moderation_service: ModerationService,
) -> None:
    if not await _require_admin(message, config, database):
        return
    if not command.args:
        await message.answer("Использование: /unfilter слово")
        return
    removed = moderation_service.remove_filter(message.chat.id, command.args.strip())
    await message.answer("Фильтр удалён." if removed else "Такого фильтра нет.")


@router.message(Command("top"))
async def top_command(message: Message, database: Database) -> None:
    rows = database.top_messages(message.chat.id)
    if not rows:
        await message.answer("Статистика сообщений пока пуста.")
        return
    lines = [f"{index}. {row['display_name']} — {row['message_count']}" for index, row in enumerate(rows, 1)]
    await message.answer("Топ участников по сообщениям:\n" + "\n".join(lines))


@router.message(Command("linktrigger"))
async def link_trigger_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
) -> None:
    if not await _require_admin(message, config, database):
        return
    value = command.args.casefold().strip() if command.args else ""
    if value not in {"on", "off", "вкл", "выкл"}:
        await message.answer("Использование: /linktrigger on или /linktrigger off")
        return
    enabled = value in {"on", "вкл"}
    database.ensure_group(message.chat.id, message.chat.title or str(message.chat.id))
    database.set_link_trigger(message.chat.id, enabled)
    await message.answer(
        "Триггер ссылок включён: ссылка удаляется, автор получает мут на 1 день."
        if enabled else "Триггер ссылок выключен."
    )


@router.message(Command("чс", "blacklist"))
async def blacklist_command(
    message: Message,
    command: CommandObject,
    config: Settings,
    database: Database,
    bot: Bot,
) -> None:
    if not await _require_admin(message, config, database):
        return
    target = _target_user(message, command, database)
    if target is None:
        await message.answer("Ответьте на сообщение пользователя или укажите его числовой ID.")
        return
    _, reason = _punishment_details(command, bool(message.reply_to_message))
    database.add_blacklist(message.chat.id, target[0], reason)
    database.add_punishment(message.chat.id, target[0], "blacklist", reason, None)
    await bot.ban_chat_member(chat_id=message.chat.id, user_id=target[0])
    await message.answer(f"{target[1]} добавлен в чёрный список и заблокирован навсегда.")


@router.message()
async def auto_filter(message: Message, moderation_service: ModerationService, database: Database) -> None:
    if message.from_user and message.chat.type in {"group", "supergroup"}:
        database.ensure_group(message.chat.id, message.chat.title or str(message.chat.id))
        database.record_message(
            message.chat.id,
            message.from_user.id,
            message.from_user.full_name,
            message.from_user.username,
        )
        if database.is_blacklisted(message.chat.id, message.from_user.id):
            return
    if not message.text or message.text.startswith("/"):
        return
    if database.link_trigger_enabled(message.chat.id) and re.search(r"https?://|t\.me/|www\.", message.text, re.I):
        try:
            await message.delete()
            until_at = datetime.now(timezone.utc) + timedelta(days=1)
            await message.bot.restrict_chat_member(
                message.chat.id, message.from_user.id,
                permissions=ChatPermissions(can_send_messages=False), until_date=until_at,
            )
            database.add_punishment(message.chat.id, message.from_user.id, "link_mute", "Ссылка", until_at)
        except Exception:
            pass
        return
    response = moderation_service.find_filter_response(message.chat.id, message.text)
    if response:
        await message.answer(response)