"""Application entry point.
Imports top-level API and configuration.
"""
from app.api import start_api_server
from app.common.logger import log_info
from app.config import get_config

def main():
    config = get_config()
    log_info(f"Starting application in debug={config.DEBUG} mode")
    server = start_api_server()
    return server

if __name__ == "__main__":
    main()
