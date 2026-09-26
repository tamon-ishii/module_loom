"""Order controller HTTP endpoints.
Demonstrates downstream circular import detection (processor <-> payment).
"""
from app.common.utils import format_currency
from app.order.processor import OrderProcessor, OrderItem

order_processor = OrderProcessor()

def handle_create_order(req):
    customer_id = req.get("customer_id", 1)
    items = [
        OrderItem(1, "Laptop Pro", 180000.0, 1),
        OrderItem(2, "Wireless Mouse", 4500.0, 2),
    ]
    coupon = req.get("coupon")
    order = order_processor.create_order(customer_id, items, coupon)
    return {
        "order": order,
        "message": f"Created order with total {format_currency(order['total'])}"
    }
