"""利用履歴の集計例。共通関数化できる長い重複を含む。"""


def summarize_logins(events: list[dict]) -> dict:
    totals = {}
    counts = {}
    for event in events:
        user_id = event.get("user_id")
        if user_id is None:
            continue
        duration = max(0, int(event.get("duration", 0)))
        totals[user_id] = totals.get(user_id, 0) + duration
        counts[user_id] = counts.get(user_id, 0) + 1
    summary = {}
    for user_id in sorted(totals):
        summary[user_id] = {
            "count": counts[user_id],
            "total_duration": totals[user_id],
        }
    return summary


def summarize_sessions(events: list[dict]) -> dict:
    totals = {}
    counts = {}
    for event in events:
        user_id = event.get("user_id")
        if user_id is None:
            continue
        duration = max(0, int(event.get("duration", 0)))
        totals[user_id] = totals.get(user_id, 0) + duration
        counts[user_id] = counts.get(user_id, 0) + 1
    summary = {}
    for user_id in sorted(totals):
        summary[user_id] = {
            "count": counts[user_id],
            "total_duration": totals[user_id],
        }
    return summary
