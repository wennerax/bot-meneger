from app.config import Settings


def test_admin_ids_are_parsed_from_comma_separated_value() -> None:
    settings = Settings(BOT_TOKEN="token", ADMIN_IDS="10, 20,10")

    assert settings.admin_ids == {10, 20}


def test_admin_ids_can_be_empty() -> None:
    settings = Settings(BOT_TOKEN="token", ADMIN_IDS="")

    assert settings.admin_ids == set()