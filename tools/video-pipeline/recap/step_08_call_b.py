"""Step 8/9 — CallB shot planner + diversity."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recap_pipeline import main_step_script

if __name__ == "__main__":
    raise SystemExit(main_step_script("call_b"))
