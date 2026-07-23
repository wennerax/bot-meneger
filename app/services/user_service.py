class UserService:
    """Stores users for the current process and exposes simple statistics."""

    def __init__(self) -> None:
        self._user_ids: set[int] = set()

    def register(self, user_id: int) -> bool:
        if user_id in self._user_ids:
            return False
        self._user_ids.add(user_id)
        return True

    @property
    def count(self) -> int:
        return len(self._user_ids)