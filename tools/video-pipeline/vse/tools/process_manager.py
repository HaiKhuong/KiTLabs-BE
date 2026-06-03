"""Process manager for managing VSF subprocess lifecycle."""

import atexit
import subprocess
import platform
import concurrent.futures


class ProcessManager:
    """Singleton process manager for child processes (VSF, etc.)."""

    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = ProcessManager()
        return cls._instance

    def __init__(self):
        self.processes = {}
        atexit.register(self.terminate_all)

    def add_process(self, process, name=None):
        if process is None:
            return
        process_id = name or f"Process:{id(process)}"
        self.processes[process_id] = process
        print(f"Added process: {process_id}, PID: {process.pid if hasattr(process, 'pid') else 'unknown'}")
        return process_id

    def add_pid(self, pid, name=None):
        process_id = name or f"Pid:{pid}"
        self.processes[process_id] = pid
        print(f"Added process: {process_id}, PID: {pid}")
        return process_id

    def remove_process(self, process_id):
        if process_id in self.processes:
            del self.processes[process_id]
            print(f"Removed process: {process_id}")
            return True
        return False

    def terminate_all(self):
        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = []
            for process_id, process in list(self.processes.items()):
                if isinstance(process, int):
                    futures.append(executor.submit(self.terminate_by_pid, process))
                else:
                    futures.append(executor.submit(self.terminate_by_process, process))
            concurrent.futures.wait(futures)
        self.processes.clear()

    def terminate_by_process(self, process):
        if process is None:
            return
        try:
            print(f"Terminating process: pid: {process.pid}")
            if hasattr(process, "poll") and process.poll() is not None:
                return
            process.terminate()
            if hasattr(process, "join"):
                try:
                    process.join(timeout=3)
                except Exception:
                    pass
            if hasattr(process, "wait"):
                try:
                    process.wait(timeout=3)
                except Exception:
                    pass
            if hasattr(process, "kill"):
                process.kill()
        except Exception:
            pass
        self.terminate_by_pid(process.pid)

    def terminate_by_pid(self, pid):
        try:
            if platform.system() == "Windows":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=3,
                )
            else:
                subprocess.run(
                    ["pkill", "-9", "-P", str(pid)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=2,
                )
                subprocess.run(
                    ["kill", "-9", str(pid)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=3,
                )
        except Exception as e:
            print(f"Error forcibly terminating process with PID {pid}: {str(e)}")
