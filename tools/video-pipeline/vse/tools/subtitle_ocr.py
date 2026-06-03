"""Subtitle OCR pipeline with multiprocessing."""

import os
import re
import shutil
import queue
from multiprocessing import Queue, Process
from threading import Thread
from types import SimpleNamespace
from collections import namedtuple

import cv2
import numpy as np
from tqdm import tqdm

from .ocr import OcrRecogniser, get_coordinates
from .constant import SubtitleArea
from . import constant


def extract_subtitles(
    data, text_recogniser, img, raw_subtitles, sub_area, options, dt_box_arg, rec_res_arg, ocr_loss_debug_path
):
    """Extract subtitle info from a video frame."""
    dt_box = dt_box_arg
    rec_res = rec_res_arg
    if dt_box is None or rec_res is None:
        dt_box, rec_res = text_recogniser.predict(img)

    coordinates = get_coordinates(dt_box)
    if options.REC_CHAR_TYPE == "en":
        text_res = [(re.sub(r"[\u4e00-\u9fa5]", "", res[0]), res[1]) for res in rec_res]
    else:
        text_res = [(res[0], res[1]) for res in rec_res]

    line = ""
    loss_list = []
    for content, coordinate in zip(text_res, coordinates):
        text = content[0]
        prob = content[1]
        if sub_area is not None:
            selected = False
            overflow_area_rate = 0
            c_xmin, c_xmax, c_ymin, c_ymax = coordinate
            inter_xmin = max(sub_area.xmin, c_xmin)
            inter_ymin = max(sub_area.ymin, c_ymin)
            inter_xmax = min(sub_area.xmax, c_xmax)
            inter_ymax = min(sub_area.ymax, c_ymax)
            has_intersection = inter_xmin < inter_xmax and inter_ymin < inter_ymax
            drop_reason = ""
            if has_intersection:
                sub_area_w = sub_area.xmax - sub_area.xmin
                sub_area_h = sub_area.ymax - sub_area.ymin
                sub_area_size = sub_area_w * sub_area_h
                inter_area = (inter_xmax - inter_xmin) * (inter_ymax - inter_ymin)
                coord_area = (c_xmax - c_xmin) * (c_ymax - c_ymin)
                overflow_area_rate = ((sub_area_size + coord_area - inter_area) / sub_area_size) - 1
                not_overflow = overflow_area_rate <= options.SUB_AREA_DEVIATION_RATE
                confident = prob > options.DROP_SCORE
                if not_overflow and confident:
                    selected = True
                    line += f'{str(data["i"]).zfill(8)}\t{coordinate}\t{text}\n'
                    raw_subtitles.append(f'{str(data["i"]).zfill(8)}\t{coordinate}\t{text}\n')
                else:
                    if not not_overflow:
                        drop_reason = f"Exceeds allowed deviation: {int(options.SUB_AREA_DEVIATION_RATE * 100)}% Current: {int(overflow_area_rate * 100)}%"
                    elif not confident:
                        drop_reason = f"Confidence below threshold: {int(options.DROP_SCORE * 100)}%"
            else:
                drop_reason = "Out of selection"
            if drop_reason:
                tqdm.write(f"× Confidence: {round(prob * 100, 1)}% Result: {text} Drop reason: {drop_reason}")
            else:
                tqdm.write(f"√ Confidence: {round(prob * 100, 1)}% Result: {text}")
            loss_info = namedtuple("loss_info", "text prob overflow_area_rate coordinate selected")
            loss_list.append(loss_info(text, prob, overflow_area_rate, coordinate, selected))
        else:
            raw_subtitles.append(f'{str(data["i"]).zfill(8)}\t{coordinate}\t{text}\n')


def ocr_task_consumer(ocr_queue, raw_subtitle_path, sub_area, video_path, options):
    """Consumer: OCR frames from queue and write to raw.txt."""
    data = {"i": 1}
    text_recogniser = OcrRecogniser()
    text_recogniser.hardware_accelerator = options.HARDWARD_ACCELERATOR
    ocr_loss_debug_path = os.path.join(os.path.abspath(os.path.splitext(video_path)[0]), "loss")
    if os.path.exists(ocr_loss_debug_path):
        shutil.rmtree(ocr_loss_debug_path, True)

    raw_subtitles = []
    try:
        while True:
            try:
                frame_no, frame, dt_box, rec_res = ocr_queue.get(block=True)
                if frame_no == -1:
                    return
                data["i"] = frame_no
                extract_subtitles(
                    data, text_recogniser, frame, raw_subtitles, sub_area, options, dt_box, rec_res, ocr_loss_debug_path
                )
            except Exception as e:
                print(e)
                break
    finally:
        with open(raw_subtitle_path, mode="w+", encoding="utf-8") as raw_subtitle_file:
            for line in raw_subtitles:
                raw_subtitle_file.write(line)


def ocr_task_producer(ocr_queue, task_queue, progress_queue, video_path, raw_subtitle_path):
    """Producer: read frames and push to OCR queue."""
    cap = cv2.VideoCapture(video_path)
    tbar = None
    while True:
        try:
            total_frame_count, current_frame_no, dt_box, rec_res, total_ms, default_subtitle_area = task_queue.get(
                block=True
            )
            progress_queue.put(current_frame_no)
            if tbar is None:
                tbar = tqdm(total=round(total_frame_count), position=1)
            if current_frame_no == -1:
                ocr_queue.put((-1, None, None, None))
                tbar.update(tbar.total - tbar.n)
                break
            tbar.update(round(current_frame_no - tbar.n))
            if total_ms is not None:
                cap.set(cv2.CAP_PROP_POS_MSEC, total_ms)
            else:
                cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame_no - 1)
            ret, frame = cap.read()
            if ret:
                if default_subtitle_area is not None:
                    frame = frame_preprocess(default_subtitle_area, frame)
                ocr_queue.put((current_frame_no, frame, dt_box, rec_res))
        except Exception as e:
            print(e)
            break
    cap.release()


def subtitle_extract_handler(task_queue, progress_queue, video_path, raw_subtitle_path, sub_area, options):
    """Handler: create producer/consumer threads."""
    if os.path.exists(raw_subtitle_path):
        os.remove(raw_subtitle_path)
    ocr_queue = queue.Queue(20)
    ocr_event_producer_thread = Thread(
        target=ocr_task_producer,
        args=(ocr_queue, task_queue, progress_queue, video_path, raw_subtitle_path),
        daemon=True,
    )
    ocr_event_consumer_thread = Thread(
        target=ocr_task_consumer,
        args=(ocr_queue, raw_subtitle_path, sub_area, video_path, options),
        daemon=True,
    )
    ocr_event_producer_thread.start()
    ocr_event_consumer_thread.start()
    ocr_event_producer_thread.join()
    ocr_event_consumer_thread.join()


def async_start(video_path, raw_subtitle_path, sub_area, options):
    """Start OCR process asynchronously."""
    assert "REC_CHAR_TYPE" in options, "options missing: REC_CHAR_TYPE"
    assert "DROP_SCORE" in options, "options missing: DROP_SCORE"
    assert "SUB_AREA_DEVIATION_RATE" in options, "options missing: SUB_AREA_DEVIATION_RATE"
    assert "DEBUG_OCR_LOSS" in options, "options missing: DEBUG_OCR_LOSS"
    assert "HARDWARD_ACCELERATOR" in options, "options missing: HARDWARD_ACCELERATOR"

    task_queue = Queue()
    progress_queue = Queue()
    p = Process(
        target=subtitle_extract_handler,
        args=(task_queue, progress_queue, video_path, raw_subtitle_path, sub_area, SimpleNamespace(**options)),
    )
    p.start()
    return p, task_queue, progress_queue


def frame_preprocess(subtitle_area, frame):
    """Crop frame based on subtitle area hint."""
    if subtitle_area == SubtitleArea.LOWER_PART:
        cropped = int(frame.shape[0] // 2)
        frame = frame[cropped:]
    elif subtitle_area == SubtitleArea.UPPER_PART:
        cropped = int(frame.shape[0] // 2)
        frame = frame[:cropped]
    return frame
