"""Database connection and session pooling module.
This core module is widely imported across services, demonstrating inbound dependencies.
"""
from app.common.logger import log_info, log_error

class DatabaseConnection:
    def __init__(self, uri: str = "sqlite:///sample.db"):
        self.uri = uri
        self.is_connected = False

    def connect(self) -> None:
        log_info(f"Connecting to database at {self.uri}")
        self.is_connected = True

    def execute_query(self, query: str, params: dict = None) -> list:
        if not self.is_connected:
            self.connect()
        log_info(f"Executing SQL: {query}")
        return [{"id": 1, "status": "success"}]

    def close(self) -> None:
        log_info("Closing database connection")
        self.is_connected = False

db_instance = DatabaseConnection()

def get_db() -> DatabaseConnection:
    return db_instance
