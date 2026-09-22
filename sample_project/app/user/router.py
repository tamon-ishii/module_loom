"""User HTTP routing endpoints."""
from app.user.service import UserService

user_service = UserService()

def handle_login(req):
    return user_service.login(req.get("user"), req.get("pass"))

def handle_get_user(user_id: int):
    return user_service.get_profile(user_id)
