from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.config import Settings

router = Router(name="common")


@router.message(Command("help"))
async def help_command(message: Message) -> None:
    await message.answer(
        "Доступные команды:\n"
        "/start - начать работу\n"
        "/help - показать эту справку\n"
        "/id - показать ваши ID\n"
        "/about - информация о боте\n"
        "/stats - статистика для администратора\n\n"
        "Команды чата:\n"
        "/rules, /setrules - правила чата\n"
        "/warn, /unwarn, /warnings - предупреждения\n"
        "/mute, /unmute - ограничить или вернуть сообщения\n"
        "/ban, /unban - блокировка пользователя\n"
        "/filter, /unfilter - автоматические ответы по словам"
    )


@router.message(Command("id"))
async def id_command(message: Message) -> None:
    user_id = message.from_user.id if message.from_user else "неизвестен"
    await message.answer(f"Ваш Telegram ID: {user_id}\nID чата: {message.chat.id}")


@router.message(Command("about"))
async def about_command(message: Message, config: Settings) -> None:
    await message.answer(f"{config.bot_name}\nМодульный бот на aiogram 3.")