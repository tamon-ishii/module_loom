"""Application configuration module."""

class Config:
    DEBUG: bool = True
    DATABASE_URL: str = "sqlite:///sample_app.db"
    API_PORT: int = 8000
    SECRET_KEY: str = "super-secret-key-12345"

def get_config() -> Config:
    return Config()
