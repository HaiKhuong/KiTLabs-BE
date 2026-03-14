import argparse
import os
import time

import requests
from tqdm import tqdm

GOPEED_CREATE_TASK = "http://localhost:9999/api/v1/tasks"
GOPEED_TASK_LIST = "http://localhost:9999/api/v1/tasks"

progress_bars = {}


def ensure_mp4_filename(filename):
    base = (filename or "").strip()
    if not base:
        return f"video_{int(time.time())}.mp4"
    if "." not in base:
        return base + ".mp4"
    return base


def build_filename_from_url(url):
    name = url.split("?")[0].rstrip("/").split("/")[-1]
    if not name:
        name = f"video_{int(time.time())}.mp4"
    return ensure_mp4_filename(name)


def parse_video_list_txt(txt_path):
    entries = []
    with open(txt_path, "r", encoding="utf-8") as f:
        for line_no, raw_line in enumerate(f, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            # Format:
            # so_thu_tu | aweme_id | ngay | file_name | video_url | mo_ta
            parts = [p.strip() for p in line.split("|", 5)]
            if len(parts) < 5:
                print(f"Skip line {line_no}: invalid format")
                continue

            file_name = parts[3] if len(parts) > 3 else ""
            video_url = parts[4] if len(parts) > 4 else ""

            if not video_url.startswith("http"):
                print(f"Skip line {line_no}: invalid video URL")
                continue

            if video_url.startswith("http://"):
                video_url = "https://" + video_url[len("http://"):]

            if not file_name:
                file_name = build_filename_from_url(video_url)

            entries.append(
                {
                    "url": video_url,
                    "filename": ensure_mp4_filename(file_name),
                }
            )
    return entries


def send_to_gopeed(video_url, filename):
    safe_filename = ensure_mp4_filename(filename)
    payload = {
        "name": safe_filename,
        "req": {"url": video_url},
        "opts": {"name": safe_filename},
    }

    r = requests.post(GOPEED_CREATE_TASK, json=payload, timeout=15)
    r.raise_for_status()
    result = r.json()

    if result.get("code") == 0:
        task_id = result.get("data")
        print(f"Task created: {safe_filename} | id={task_id}")
        return task_id

    print("Gopeed create task failed:", result.get("msg", "unknown error"))
    print("Payload:", payload)
    return None


def fetch_gopeed_tasks():
    r = requests.get(GOPEED_TASK_LIST, timeout=10)
    r.raise_for_status()
    payload = r.json()

    if isinstance(payload, dict):
        tasks = payload.get("tasks") or payload.get("data") or []
    elif isinstance(payload, list):
        tasks = payload
    else:
        tasks = []

    return tasks if isinstance(tasks, list) else []


def wait_gopeed_tasks(task_ids):
    if not task_ids:
        print("No Gopeed tasks created")
        return

    remaining = set(task_ids)
    failed = set()
    task_positions = {task_id: i for i, task_id in enumerate(task_ids)}
    success_states = {"done", "completed", "finish", "finished"}
    failed_states = {"error", "failed", "canceled", "cancelled"}

    while remaining:
        try:
            tasks = fetch_gopeed_tasks()
        except Exception as e:
            print("Monitor error:", e)
            time.sleep(2)
            continue

        task_map = {}
        for task in tasks:
            if isinstance(task, dict) and task.get("id"):
                task_map[task["id"]] = task

        for task_id in list(remaining):
            task = task_map.get(task_id)
            if not task:
                continue

            name = task.get("name") or task_id
            status = str(task.get("status") or "").lower()
            progress_info = task.get("progress", 0)

            if isinstance(progress_info, dict):
                downloaded = float(progress_info.get("downloaded", 0) or 0)
                used = float(progress_info.get("used", 0) or 0)
                percent = int((downloaded / used) * 100) if used > 0 else 0
            else:
                percent = int(float(progress_info) * 100)

            bar = progress_bars.get(task_id)
            if bar is None:
                bar = tqdm(total=100, desc=name, position=task_positions[task_id], leave=True)
                progress_bars[task_id] = bar

            bar.n = max(0, min(100, percent))
            bar.set_postfix_str(status or "running")
            bar.refresh()

            if status in success_states:
                bar.n = 100
                bar.set_postfix_str("done")
                bar.refresh()
                bar.close()
                remaining.remove(task_id)
            elif status in failed_states:
                bar.set_postfix_str("failed")
                bar.refresh()
                bar.close()
                remaining.remove(task_id)
                failed.add(task_id)

        time.sleep(1)

    if failed:
        print(f"Completed with failures: {len(failed)}/{len(task_ids)}")
    else:
        print(f"All downloads finished: {len(task_ids)} task(s)")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Download videos from txt list using Gopeed only."
    )
    parser.add_argument("txt_file", help="Path to douyin_video_list_*.txt")
    parser.add_argument(
        "--max-videos",
        type=int,
        default=None,
        help="Limit number of entries to process",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="Create tasks only, do not wait for completion",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if not os.path.isfile(args.txt_file):
        print(f"File not found: {args.txt_file}")
        return

    if not args.txt_file.lower().endswith(".txt"):
        print(f"Input must be .txt file: {args.txt_file}")
        return

    entries = parse_video_list_txt(args.txt_file)
    if args.max_videos is not None:
        if args.max_videos <= 0:
            print("--max-videos must be > 0")
            return
        entries = entries[:args.max_videos]

    if not entries:
        print("No valid video entries found in txt file")
        return

    print(f"Input file: {args.txt_file}")
    print(f"Videos to create task: {len(entries)}")

    task_ids = []
    for index, entry in enumerate(entries, start=1):
        print(f"[{index}/{len(entries)}] {entry['filename']}")
        try:
            task_id = send_to_gopeed(entry["url"], entry["filename"])
            if task_id:
                task_ids.append(task_id)
        except Exception as e:
            print(f"Create task failed for {entry['filename']}: {e}")

    print(f"Created {len(task_ids)} Gopeed task(s)")
    if not args.no_wait:
        print("Waiting for Gopeed downloads to finish...")
        wait_gopeed_tasks(task_ids)


if __name__ == "__main__":
    main()