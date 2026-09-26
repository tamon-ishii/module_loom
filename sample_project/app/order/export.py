"""注文と返金のCSV出力例。短いコピペ箇所の検出に使う。"""


def export_orders(rows: list[dict]) -> str:
    output = ["id,customer,amount"]
    for row in rows:
        identifier = str(row.get("id", "")).strip()
        customer = str(row.get("customer", "")).strip()
        amount = float(row.get("amount", 0))
        output.append(f"{identifier},{customer},{amount:.2f}")
    return "\n".join(output)


def export_refunds(rows: list[dict]) -> str:
    output = ["id,customer,amount"]
    for row in rows:
        identifier = str(row.get("id", "")).strip()
        customer = str(row.get("customer", "")).strip()
        amount = float(row.get("amount", 0))
        output.append(f"{identifier},{customer},{amount:.2f}")
    return "\n".join(output)
