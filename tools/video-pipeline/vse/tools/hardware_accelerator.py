"""Hardware accelerator detection for Paddle/ONNX."""

import paddle


class HardwareAccelerator:
    """Singleton to detect GPU/ONNX acceleration availability."""

    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = HardwareAccelerator()
            cls._instance.initialize()
        return cls._instance

    def __init__(self):
        self.__cuda = False
        self.__onnx_providers = []
        self.__enabled = True

    def initialize(self):
        self.check_paddle()
        self.check_onnx()

    def check_paddle(self):
        if paddle.is_compiled_with_cuda():
            if len(paddle.static.cuda_places()) > 0:
                self.__cuda = True

    def check_onnx(self):
        if self.__cuda:
            return
        try:
            import onnxruntime as ort

            available_providers = ort.get_available_providers()
            for provider in available_providers:
                if provider in ["CPUExecutionProvider"]:
                    continue
                if provider not in [
                    "DmlExecutionProvider",
                    "ROCMExecutionProvider",
                    "MIGraphXExecutionProvider",
                    "VitisAIExecutionProvider",
                    "OpenVINOExecutionProvider",
                    "MetalExecutionProvider",
                    "CoreMLExecutionProvider",
                    "CUDAExecutionProvider",
                ]:
                    print(f"ONNX Execution Provider: {provider} not supported, skipped.")
                    continue
                print(f"Detected ONNX execution provider: {provider}")
                self.__onnx_providers.append(provider)
        except ModuleNotFoundError:
            print("ONNX runtime not installed, skipped.")

    def has_accelerator(self):
        if not self.__enabled:
            return False
        return self.__cuda or len(self.__onnx_providers) > 0

    @property
    def accelerator_name(self):
        if not self.__enabled:
            return "CPU"
        if self.__cuda:
            return "GPU"
        elif len(self.__onnx_providers) > 0:
            return ", ".join(self.__onnx_providers)
        else:
            return "CPU"

    @property
    def onnx_providers(self):
        if not self.__enabled:
            return []
        return self.__onnx_providers

    def has_cuda(self):
        if not self.__enabled:
            return False
        return self.__cuda

    def set_enabled(self, enable):
        self.__enabled = enable
