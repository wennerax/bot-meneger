from aiogram import Bot, Dispatcher

from app.config import Settings
from app.handlers import register_routers
from app.services.moderation_service import ModerationService
from app.services.database import Database
from app.services.user_service import UserService


def create_bot(config: Settings) -> tuple[Bot, Dispatcher]:
    bot = Bot(token=config.bot_token.get_secret_value())
    dispatcher = Dispatcher()
    dispatcher["config"] = config
    dispatcher["moderation_service"] = ModerationService()
    dispatcher["database"] = Database(config.database_path)
    dispatcher["user_service"] = UserService()
    register_routers(dispatcher)
    return bot, dispatcher