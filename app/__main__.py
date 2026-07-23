import asyncio
import logging

from app.bot import create_bot
from app.config import load_config


async def main() -> None:
    config = load_config()
    bot, dispatcher = create_bot(config)
    await dispatcher.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Bot stopped")