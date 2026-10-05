"""Real-ESRGAN inference without the realesrgan / basicsr pip packages.

Architectures match xinntao/Real-ESRGAN (RRDBNet x4plus, SRVGGNetCompact anime 6B).
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F


def _make_layer(block: type[nn.Module], count: int, **kwargs) -> nn.Sequential:
    return nn.Sequential(*[block(**kwargs) for _ in range(count)])


class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat: int = 64, num_grow_ch: int = 32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat: int, num_grow_ch: int = 32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(
        self,
        num_in_ch: int,
        num_out_ch: int,
        scale: int = 4,
        num_feat: int = 64,
        num_block: int = 23,
        num_grow_ch: int = 32,
    ):
        super().__init__()
        self.scale = scale
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = _make_layer(RRDB, num_block, num_feat=num_feat, num_grow_ch=num_grow_ch)
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


class SRVGGNetCompact(nn.Module):
    def __init__(
        self,
        num_in_ch: int = 3,
        num_out_ch: int = 3,
        num_feat: int = 64,
        num_conv: int = 32,
        upscale: int = 4,
        act_type: str = "prelu",
    ):
        super().__init__()
        self.upscale = upscale
        body: list[nn.Module] = [nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)]
        if act_type == "prelu":
            body.append(nn.PReLU(num_parameters=num_feat))
        else:
            body.append(nn.LeakyReLU(negative_slope=0.1, inplace=True))
        for _ in range(num_conv):
            body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            if act_type == "prelu":
                body.append(nn.PReLU(num_parameters=num_feat))
            else:
                body.append(nn.LeakyReLU(negative_slope=0.1, inplace=True))
        body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.body = nn.ModuleList(body)
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


def _load_state(path: Path, device: str) -> dict:
    try:
        payload = torch.load(str(path), map_location=device, weights_only=False)
    except TypeError:
        payload = torch.load(str(path), map_location=device)
    if isinstance(payload, dict):
        if "params_ema" in payload:
            return payload["params_ema"]
        if "params" in payload:
            return payload["params"]
    return payload


def build_model(domain: str, weight_path: Path, device: str) -> nn.Module:
    if domain == "anime":
        model: nn.Module = SRVGGNetCompact(
            num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type="prelu"
        )
    else:
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    model.load_state_dict(_load_state(weight_path, device), strict=True)
    model.eval()
    model.to(device)
    if device == "cuda":
        model.half()
    return model


def _to_tensor(img: np.ndarray, device: str, half: bool) -> torch.Tensor:
    tensor = torch.from_numpy(np.transpose(img, (2, 0, 1))).float().unsqueeze(0).to(device)
    if half:
        tensor = tensor.half()
    return tensor


def _from_tensor(tensor: torch.Tensor) -> np.ndarray:
    output = tensor.data.squeeze().float().cpu().clamp_(0, 1).numpy()
    output = np.transpose(output[[2, 1, 0], :, :], (1, 2, 0))
    return output


@torch.no_grad()
def _infer_tiled(
    model: nn.Module,
    img: torch.Tensor,
    scale: int,
    tile: int,
    tile_pad: int,
) -> torch.Tensor:
    _batch, _channel, height, width = img.shape
    if tile <= 0 or (height <= tile and width <= tile):
        return model(img)

    output = img.new_zeros((_batch, _channel, height * scale, width * scale))
    tiles_x = math.ceil(width / tile)
    tiles_y = math.ceil(height / tile)
    for y in range(tiles_y):
        for x in range(tiles_x):
            input_start_x = x * tile
            input_end_x = min(input_start_x + tile, width)
            input_start_y = y * tile
            input_end_y = min(input_start_y + tile, height)
            pad_start_x = max(input_start_x - tile_pad, 0)
            pad_end_x = min(input_end_x + tile_pad, width)
            pad_start_y = max(input_start_y - tile_pad, 0)
            pad_end_y = min(input_end_y + tile_pad, height)
            input_tile = img[:, :, pad_start_y:pad_end_y, pad_start_x:pad_end_x]
            output_tile = model(input_tile)
            output_start_x = input_start_x * scale
            output_end_x = input_end_x * scale
            output_start_y = input_start_y * scale
            output_end_y = input_end_y * scale
            tile_out_start_x = (input_start_x - pad_start_x) * scale
            tile_out_end_x = tile_out_start_x + (input_end_x - input_start_x) * scale
            tile_out_start_y = (input_start_y - pad_start_y) * scale
            tile_out_end_y = tile_out_start_y + (input_end_y - input_start_y) * scale
            output[:, :, output_start_y:output_end_y, output_start_x:output_end_x] = output_tile[
                :, :, tile_out_start_y:tile_out_end_y, tile_out_start_x:tile_out_end_x
            ]
    return output


def enhance(
    bgr: np.ndarray,
    model: nn.Module,
    device: str,
    outscale: float,
    model_scale: int = 4,
    tile: int = 512,
    tile_pad: int = 10,
) -> np.ndarray:
    img = bgr.astype(np.float32)
    max_range = 65535.0 if np.max(img) > 256 else 255.0
    img = img / max_range
    img = img[:, :, [2, 1, 0]]
    h_input, w_input = img.shape[:2]
    half = device == "cuda"
    tensor = _to_tensor(img, device, half)
    output = _infer_tiled(model, tensor, model_scale, tile, tile_pad)
    rgb = _from_tensor(output)
    if outscale != float(model_scale):
        rgb = cv2.resize(
            rgb,
            (int(w_input * outscale), int(h_input * outscale)),
            interpolation=cv2.INTER_LANCZOS4,
        )
    return (rgb * max_range).round().astype(np.uint16 if max_range == 65535 else np.uint8)
