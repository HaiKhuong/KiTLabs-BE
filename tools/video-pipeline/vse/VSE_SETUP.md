# VSE Step1 Setup Guide (Linux GPU)

VSE (Video Subtitle Extractor) integration for KiTLabs auto_vietsub_pro.py.

## Requirements

- Linux (Ubuntu 20.04+ recommended)
- NVIDIA GPU with CUDA 11.8 or 12.x
- Python 3.9+

## Installation

### 1. Install PaddlePaddle GPU

```bash
# CUDA 11.8
pip install paddlepaddle-gpu==3.0.0 -i https://pypi.tuna.tsinghua.edu.cn/simple

# Or CUDA 12.x
pip install paddlepaddle-gpu==3.0.0 -f https://www.paddlepaddle.org.cn/whl/linux/cudnnin/stable.html
```

Verify:
```python
import paddle
print(paddle.is_compiled_with_cuda())  # should be True
print(len(paddle.static.cuda_places()) > 0)  # should be True
```

### 2. Install PaddleOCR and dependencies

```bash
pip install paddleocr>=3.4.0 Levenshtein pysrt shapely pyclipper scikit-image Pillow
```

### 3. Download PP-OCRv5 Models

Download and extract to `tools/video-pipeline/vse/models/V5/`:

- `PP-OCRv5_server_det_infer` - Detection model
- `PP-OCRv5_server_rec_infer` - Recognition model (Chinese/English)

Download links:
- https://paddleocr.bj.bcebos.com/PP-OCRv5/PP-OCRv5_server_det_infer.tar
- https://paddleocr.bj.bcebos.com/PP-OCRv5/PP-OCRv5_server_rec_infer.tar

```bash
cd tools/video-pipeline/vse/models/V5
wget https://paddleocr.bj.bcebos.com/PP-OCRv5/PP-OCRv5_server_det_infer.tar
wget https://paddleocr.bj.bcebos.com/PP-OCRv5/PP-OCRv5_server_rec_infer.tar
tar xf PP-OCRv5_server_det_infer.tar
tar xf PP-OCRv5_server_rec_infer.tar
```

### 4. Make VideoSubFinder executable (optional)

```bash
chmod +x tools/video-pipeline/vse/subfinder/linux/VideoSubFinderCli.run
```

## Usage

```bash
python auto_vietsub_pro.py --input video.mp4 --step1-subtitle-source vse
```

### Options

```bash
--vse-mode fast|auto|accurate  # default: auto
--vse-language ch              # OCR language (ch, en, korean, japan, etc.)
--vse-hardware-accel on|off    # GPU acceleration
--vse-drop-score 75            # Min confidence %
--vse-text-similarity 80       # Dedup threshold %
--vse-roi "0.78,0.99,0.05,0.95"  # Manual ROI (ymin,ymax,xmin,xmax normalized)
```

## Modes

| Mode | Detection | Recognition | Frame Selection | GPU Required |
|------|-----------|-------------|-----------------|--------------|
| fast | mobile | mobile | VideoSubFinder | No |
| auto | server | server | VideoSubFinder | Recommended |
| accurate | server | server | Full-frame det | Yes |

## Troubleshooting

### "No CUDA devices found"
- Check NVIDIA driver: `nvidia-smi`
- Check CUDA toolkit: `nvcc --version`
- Ensure paddlepaddle-gpu matches your CUDA version

### "Model not found"
- Download models to `vse/models/V5/`
- Check directory structure: `vse/models/V5/PP-OCRv5_server_det_infer/`

### VideoSubFinder fails
- Check permissions: `chmod +x vse/subfinder/linux/VideoSubFinderCli.run`
- Run manually to see errors: `./VideoSubFinderCli.run --help`
