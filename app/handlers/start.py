from aiogram import Router
from aiogram.filters import CommandStart
from aiogram.types import Message

from app.services.user_service import UserService

router = Router(name="start")


@router.message(CommandStart())
async def start_command(message: Message, user_service: UserService) -> None:
    user = message.from_user
    if user is None:
        return
    is_new = user_service.register(user.id)
    status = "Рад знакомству" if is_new else "С возвращением"
    await message.answer(
        f"{status}, {user.full_name}!\n\n"
        "Я помогу управлять ботом. Используйте /help, чтобы увидеть команды."
    )