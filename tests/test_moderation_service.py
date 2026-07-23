from app.services.moderation_service import ModerationService


def test_warnings_are_stored_per_chat_and_user() -> None:
    service = ModerationService()

    assert service.add_warning(100, 7) == 1
    assert service.add_warning(100, 7) == 2
    assert service.get_warnings(100, 7) == 2
    assert service.get_warnings(200, 7) == 0


def test_rules_and_filters_are_stored_per_chat() -> None:
    service = ModerationService()

    service.set_rules(100, "Будьте вежливы")
    service.add_filter(100, "привет", "Привет!")

    assert service.get_rules(100) == "Будьте вежливы"
    assert service.find_filter_response(100, "ПРИВЕТ всем") == "Привет!"
    assert service.find_filter_response(200, "привет") is None


def test_filter_can_be_removed() -> None:
    service = ModerationService()
    service.add_filter(100, "spam", "Не спамьте")

    assert service.remove_filter(100, "SPAM") is True
    assert service.remove_filter(100, "spam") is False