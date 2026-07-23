from app.services.user_service import UserService


def test_register_returns_true_only_for_new_user() -> None:
    service = UserService()

    assert service.register(42) is True
    assert service.register(42) is False
    assert service.count == 1


def test_users_are_counted_independently() -> None:
    service = UserService()

    service.register(1)
    service.register(2)

    assert service.count == 2