"""Main API router aggregating User and Order subsystems.
Ideal module to test Focus Mode and 1-Hop dependency diagram.
"""
from app.config import get_config
from app.order.controller import handle_create_order
from app.user.router import handle_login, handle_get_user

class ApiServer:
    def __init__(self):
        self.config = get_config()

    def route_request(self, path: str, method: str, data: dict):
        if path == "/api/login":
            return handle_login(data)
        elif path == "/api/user":
            return handle_get_user(data.get("user_id", 1))
        elif path == "/api/order":
            return handle_create_order(data)
        return {"error": "Not Found"}

def start_api_server():
    server = ApiServer()
    print(f"API Server listening on port {server.config.API_PORT}")
    return server
