from datetime import datetime, timezone

from app.services.database import Database


def test_group_owner_is_added_to_admin_list(tmp_path) -> None:
    database = Database(str(tmp_path / "bot.sqlite3"))
    database.ensure_group(100, "Test group", owner_id=42)

    assert database.is_admin(100, 42, set()) is True
    assert database.is_admin(200, 42, set()) is False


def test_message_top_is_separate_for_each_group(tmp_path) -> None:
    database = Database(str(tmp_path / "bot.sqlite3"))
    database.ensure_group(100, "One")
    database.ensure_group(200, "Two")
    database.record_message(100, 1, "Alice")
    database.record_message(100, 1, "Alice")
    database.record_message(200, 2, "Bob")

    assert database.top_messages(100)[0]["display_name"] == "Alice"
    assert database.top_messages(100)[0]["message_count"] == 2
    assert database.top_messages(200)[0]["display_name"] == "Bob"


def test_username_resolves_only_inside_its_group(tmp_path) -> None:
    database = Database(str(tmp_path / "bot.sqlite3"))
    database.record_message(100, 7, "Alice", "Alice_Example")

    assert database.resolve_username(100, "@alice_example") == (7, "Alice")
    assert database.resolve_username(200, "@alice_example") is None


def test_link_trigger_blacklist_and_punishment_are_persistent(tmp_path) -> None:
    database = Database(str(tmp_path / "bot.sqlite3"))
    database.ensure_group(100, "Test")
    database.set_link_trigger(100, True)
    database.add_blacklist(100, 7, "Реклама")
    database.add_punishment(100, 7, "mute", "Ссылка", datetime.now(timezone.utc))

    assert database.link_trigger_enabled(100) is True
    assert database.is_blacklisted(100, 7) is True