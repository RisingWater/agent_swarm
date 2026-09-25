"""测试公共夹具。

AGENT_SWARM_DB 必须在任何 server 模块导入之前设置——db.py 在 import 时就
创建 engine（路径固化），放 conftest 顶部才能保证生效。测试一律用临时库，
绝不触碰 data/agent_swarm.db。
"""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="agent-swarm-test-")
os.environ["AGENT_SWARM_DB"] = os.path.join(_TMP, "test.db")
