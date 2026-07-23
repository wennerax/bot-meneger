from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.config import Settings
from app.services.user_service import UserService

router = Router(name="admin")


@router.message(Command("stats"))
async def stats_command(
    message: Message,
    config: Settings,
    user_service: UserService,
) -> None:
    user_id = message.from_user.id if message.from_user else None
    if user_id not in config.admin_ids:
        await message.answer("Команда доступна только администраторам.")
        return
    await message.answer(f"Зарегистрировано пользователей: {user_service.count}")