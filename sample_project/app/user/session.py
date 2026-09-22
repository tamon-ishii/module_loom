"""Session management module.
Contains circular dependency with app.user.auth.
Also imports app.common.database.
"""
from app.common.database import get_db
from app.common.utils import generate_uuid
from app.user.auth import verify_auth_token

active_sessions = {}

def create_session(user_id: int) -> str:
    db = get_db()
    db.execute_query("INSERT INTO sessions ...")
    token = f"tok_{generate_uuid()}"
    active_sessions[token] = user_id
    return token

def get_active_session(username: str):
    return active_sessions.get(username)

def validate_session(token: str) -> bool:
    if verify_auth_token(token):
        return token in active_sessions
    return False
