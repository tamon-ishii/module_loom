"""User authentication service.
Demonstrates resolving circular imports via function-level (deferred / 遅延インポート) import.
"""
from app.common.utils import hash_password

def authenticate_user(username: str, password_hash: str) -> bool:
    # 遅延インポート (関数内インポート): モジュールロード時には実行されないため循環エラーを回避
    from app.user.session import get_active_session
    session = get_active_session(username)
    if session:
        return True
    return False

def verify_auth_token(token: str) -> bool:
    return token.startswith("tok_")
