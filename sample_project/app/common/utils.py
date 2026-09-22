"""Common utility helpers."""
import hashlib
import uuid

def generate_uuid() -> str:
    return str(uuid.uuid4())

def hash_password(plain_text: str) -> str:
    return hashlib.sha256(plain_text.encode("utf-8")).hexdigest()

def format_currency(amount: float) -> str:
    return f"¥{amount:,.0f}"
