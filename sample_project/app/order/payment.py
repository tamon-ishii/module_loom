"""Payment processing gateway module.
Contains circular dependency with app.order.processor.
"""
from app.common.database import get_db
from app.order.processor import update_order_status

def process_payment_gateway(order_id: int, amount: float) -> bool:
    db = get_db()
    db.execute_query("INSERT INTO payments ...")
    # Callback to processor to update status
    update_order_status(order_id, "PAID")
    return True

def refund_payment(payment_id: int) -> bool:
    db = get_db()
    db.execute_query("UPDATE payments SET status = 'REFUNDED'")
    return True
