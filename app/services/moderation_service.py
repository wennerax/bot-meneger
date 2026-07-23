from dataclasses import dataclass, field


@dataclass
class ChatSettings:
    rules: str = "Правила чата пока не настроены."
    warnings: dict[int, int] = field(default_factory=dict)
    filters: dict[str, str] = field(default_factory=dict)


class ModerationService:
    """Keeps chat moderation settings for the current process."""

    def __init__(self) -> None:
        self._chats: dict[int, ChatSettings] = {}

    def _get_chat(self, chat_id: int) -> ChatSettings:
        return self._chats.setdefault(chat_id, ChatSettings())

    def get_rules(self, chat_id: int) -> str:
        return self._get_chat(chat_id).rules

    def set_rules(self, chat_id: int, rules: str) -> None:
        self._get_chat(chat_id).rules = rules

    def add_warning(self, chat_id: int, user_id: int) -> int:
        settings = self._get_chat(chat_id)
        settings.warnings[user_id] = settings.warnings.get(user_id, 0) + 1
        return settings.warnings[user_id]

    def get_warnings(self, chat_id: int, user_id: int) -> int:
        return self._get_chat(chat_id).warnings.get(user_id, 0)

    def reset_warnings(self, chat_id: int, user_id: int) -> None:
        self._get_chat(chat_id).warnings.pop(user_id, None)

    def add_filter(self, chat_id: int, keyword: str, response: str) -> None:
        self._get_chat(chat_id).filters[keyword.casefold()] = response

    def remove_filter(self, chat_id: int, keyword: str) -> bool:
        return self._get_chat(chat_id).filters.pop(keyword.casefold(), None) is not None

    def find_filter_response(self, chat_id: int, text: str) -> str | None:
        normalized_text = text.casefold()
        for keyword, response in self._get_chat(chat_id).filters.items():
            if keyword in normalized_text:
                return response
        return None