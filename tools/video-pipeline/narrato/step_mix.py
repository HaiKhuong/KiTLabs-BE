"""Step mix-cut (short)."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import main_step_script

if __name__ == "__main__":
    raise SystemExit(main_step_script("mix"))
