import sys
from pathlib import Path

HERE = Path(__file__).parent
# The tests import the conformance nodes that sit beside them, and the fixture project's nodes import its `ports`.
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixture"))
