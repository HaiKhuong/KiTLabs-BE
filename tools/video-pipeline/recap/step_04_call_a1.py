"""Step 4/9 — CallA-1 story analyst (Gemini)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recap_pipeline import main_step_script

if __name__ == "__main__":
    raise SystemExit(main_step_script("call_a1"))
