"""User domain service.
Imports app.user.auth, demonstrating downstream circular dependency detection.
Also imports app.common.database.
"""
from app.common.database import get_db
from app.user.auth import authenticate_user
from app.user.session import create_session

class UserService:
    def __init__(self):
        self.db = get_db()

    def login(self, username: str, password_hash: str):
        if authenticate_user(username, password_hash):
            return create_session(1)
        return None

    def get_profile(self, user_id: int):
        return self.db.execute_query("SELECT * FROM users WHERE id = :id", {"id": user_id})
