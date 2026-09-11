"""轻量 .env 读取（无第三方依赖），保留给 JWT secret 等配置用。"""
import os
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def _env_file() -> dict:
    env: dict = {}
    p = PROJECT_ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get(key: str, default: str = "") -> str:
    """环境变量优先，其次项目根 .env。"""
    return os.environ.get(key) or _env_file().get(key, default)
