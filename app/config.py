from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    bot_token: SecretStr = Field(alias="BOT_TOKEN")
    admin_ids: set[int] = Field(default_factory=set, alias="ADMIN_IDS")
    bot_name: str = Field(default="Telegram Bot Manager", alias="BOT_NAME")
    database_path: str = Field(default="data/bot.sqlite3", alias="DATABASE_PATH")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("admin_ids", mode="before")
    @classmethod
    def parse_admin_ids(cls, value: object) -> object:
        if value in (None, ""):
            return set()
        if isinstance(value, str):
            return {int(item.strip()) for item in value.split(",") if item.strip()}
        return value


@lru_cache(maxsize=1)
def load_config() -> Settings:
    return Settings()