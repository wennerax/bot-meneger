from aiogram import Dispatcher

from app.handlers.admin import router as admin_router
from app.handlers.common import router as common_router
from app.handlers.moderation import router as moderation_router
from app.handlers.start import router as start_router


def register_routers(dispatcher: Dispatcher) -> None:
    dispatcher.include_router(start_router)
    dispatcher.include_router(common_router)
    dispatcher.include_router(admin_router)
    dispatcher.include_router(moderation_router)