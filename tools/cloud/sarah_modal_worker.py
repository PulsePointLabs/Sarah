"""Sarah encrypted cloud worker for audio and visual session evidence."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

import modal


APP_NAME = "sarah-cloud-analysis"
WORKER_VERSION = "multimodal-pilot-v1"
INGEST_VOLUME_NAME = "sarah-analysis-encrypted-ingest"

app = modal.App(APP_NAME)
base_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("cryptography==50.0.0")
)
image = base_image.add_local_python_source("encrypted_transport")
audio_image = (
    base_image
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper==1.2.0",
        "librosa==0.11.0",
        "soundfile==0.13.1",
        "torch==2.8.0",
        "transformers==4.56.2",
    )
    .add_local_python_source("encrypted_transport")
)
visual_image = (
    base_image
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install(
        "accelerate==1.10.1",
        "numpy==2.2.6",
        "opencv-python-headless==4.12.0.88",
        "pillow==11.3.0",
        "qwen-vl-utils==0.0.14",
        "torch==2.8.0",
        "torchvision==0.23.0",
        "transformers==4.56.2",
        "ultralytics==8.3.199",
    )
    .add_local_python_source("encrypted_transport")
)
ingest_volume = modal.Volume.from_name(INGEST_VOLUME_NAME, create_if_missing=True)


@app.function(image=image, cpu=0.125, memory=256, timeout=60)
def health() -> dict:
    return {
        "ok": True,
        "service": APP_NAME,
        "worker_version": WORKER_VERSION,
        "gpu_enabled": True,
        "media_upload_enabled": True,
        "analysis_lanes": ["audio", "visual"],
    }


@app.function(
    image=image,
    cpu=1,
    memory=1024,
    timeout=600,
    volumes={"/encrypted-ingest": ingest_volume},
)
def verify_encrypted_job(job_id: str, asset_manifest: dict, key_b64: str) -> dict:
    """Verify encrypted chunks in ephemeral plaintext memory and always delete them."""
    from encrypted_transport import decrypt_chunks

    safe_job_id = str(job_id or "").strip()
    asset_id = str(asset_manifest.get("asset_id") or "").strip()
    if not safe_job_id or not asset_id or any(part in safe_job_id + asset_id for part in ("..", "/", "\\")):
        raise ValueError("Unsafe cloud analysis job or asset identifier.")

    job_root = f"/encrypted-ingest/jobs/{safe_job_id}"
    try:
        key = base64.b64decode(key_b64, validate=True)
        plaintext, digest = decrypt_chunks(
            asset_manifest.get("chunks") or [],
            job_id=safe_job_id,
            asset_id=asset_id,
            key=key,
            read_chunk=lambda remote_path: open(f"/encrypted-ingest/{remote_path.lstrip('/')}", "rb").read(),
        )
        expected_digest = str(asset_manifest.get("plaintext_sha256") or "")
        if not expected_digest or digest != expected_digest:
            raise ValueError("Whole-asset digest mismatch after cloud decryption.")
        return {
            "ok": True,
            "job_id": safe_job_id,
            "asset_id": asset_id,
            "plaintext_bytes": len(plaintext),
            "plaintext_sha256": digest,
            "chunk_count": len(asset_manifest.get("chunks") or []),
            "plaintext_retained": False,
            "encrypted_chunks_cleanup_scheduled": True,
        }
    finally:
        shutil.rmtree(job_root, ignore_errors=True)
        ingest_volume.commit()


@app.function(image=image, cpu=0.125, memory=256, timeout=120, volumes={"/encrypted-ingest": ingest_volume})
def cleanup_encrypted_job(job_id: str) -> dict:
    safe_job_id = str(job_id or "").strip()
    if not safe_job_id or any(part in safe_job_id for part in ("..", "/", "\\")):
        raise ValueError("Unsafe cloud analysis job identifier.")
    shutil.rmtree(f"/encrypted-ingest/jobs/{safe_job_id}", ignore_errors=True)
    ingest_volume.commit()
    return {"ok": True, "job_id": safe_job_id, "encrypted_chunks_retained": False}


def _clean_float(value, digits: int = 3):
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _confidence_band(value: float) -> str:
    if value >= 0.75:
        return "strong"
    if value >= 0.5:
        return "moderate"
    return "low"


def _merge_acoustic_windows(windows: list[dict], max_gap_seconds: float = 5.0) -> list[dict]:
    merged = []
    for label in sorted({str(item.get("label") or "") for item in windows if item.get("label")}):
        label_windows = sorted(
            (item for item in windows if item.get("label") == label),
            key=lambda item: float(item.get("start_s") or 0),
        )
        current = None
        for item in label_windows:
            if current is None or float(item["start_s"]) > float(current["end_s"]) + max_gap_seconds:
                if current is not None:
                    merged.append(current)
                current = {
                    **item,
                    "peak_confidence": item["confidence"],
                    "mean_confidence": item["confidence"],
                    "supporting_windows": 1,
                }
                continue
            count = int(current["supporting_windows"])
            confidence = float(item["confidence"])
            current["end_s"] = max(float(current["end_s"]), float(item["end_s"]))
            current["peak_confidence"] = max(float(current["peak_confidence"]), confidence)
            current["mean_confidence"] = _clean_float(
                ((float(current["mean_confidence"]) * count) + confidence) / (count + 1),
                4,
            )
            current["supporting_windows"] = count + 1
            current["confidence"] = current["peak_confidence"]
        if current is not None:
            merged.append(current)
    for item in merged:
        item["confidence_band"] = _confidence_band(float(item["peak_confidence"]))
    return sorted(merged, key=lambda item: (float(item.get("start_s") or 0), str(item.get("label") or "")))


def _extract_json_object(value: str):
    text = str(value or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {"raw_description": text, "parse_state": "unstructured"}


def _select_visual_timestamps(frame_metrics: list[dict], duration_seconds: float, limit: int = 32) -> list[float]:
    candidates = {0.0, max(0.0, duration_seconds - 1.0)}
    anchor = 30.0
    while anchor < duration_seconds:
        candidates.add(anchor)
        anchor += 60.0
    ranked_motion = sorted(frame_metrics, key=lambda item: float(item.get("motion") or 0), reverse=True)
    ranked_scene = sorted(frame_metrics, key=lambda item: float(item.get("scene_score") or 0), reverse=True)
    for item in ranked_motion[:16] + ranked_scene[:16]:
        candidates.add(float(item.get("time_s") or 0))
    selected = []
    for timestamp in sorted(candidates):
        if not selected or timestamp - selected[-1] >= 3.0:
            selected.append(timestamp)
    if len(selected) <= limit:
        return selected
    keep = {selected[0], selected[-1]}
    ranked = sorted(
        selected[1:-1],
        key=lambda timestamp: max(
            (float(item.get("motion") or 0) + float(item.get("scene_score") or 0))
            for item in frame_metrics
            if abs(float(item.get("time_s") or 0) - timestamp) <= 0.3
        ) if any(abs(float(item.get("time_s") or 0) - timestamp) <= 0.3 for item in frame_metrics) else 0,
        reverse=True,
    )
    keep.update(ranked[:max(0, limit - len(keep))])
    return sorted(keep)


@app.function(
    image=audio_image,
    gpu="L4",
    cpu=4,
    memory=32768,
    timeout=3600,
    volumes={"/encrypted-ingest": ingest_volume},
)
def analyze_encrypted_audio(job_id: str, asset_manifest: dict, key_b64: str) -> dict:
    """Decrypt one audio asset ephemerally, transcribe it, and find sound candidates."""
    from faster_whisper import WhisperModel
    import librosa
    import torch
    from transformers import AutoFeatureExtractor, AutoModelForAudioClassification
    from encrypted_transport import decrypt_chunks_to_file

    safe_job_id = str(job_id or "").strip()
    asset_id = str(asset_manifest.get("asset_id") or "").strip()
    if not safe_job_id or not asset_id or any(part in safe_job_id + asset_id for part in ("..", "/", "\\")):
        raise ValueError("Unsafe cloud analysis job or asset identifier.")

    job_root = f"/encrypted-ingest/jobs/{safe_job_id}"
    work_root = Path(f"/tmp/{safe_job_id}")
    work_root.mkdir(parents=True, exist_ok=True)
    audio_path = work_root / "source.aac"
    decoded_audio_path = work_root / "source-16khz-mono.wav"
    try:
        key = base64.b64decode(key_b64, validate=True)
        with audio_path.open("wb") as destination:
            plaintext_bytes, digest = decrypt_chunks_to_file(
                asset_manifest.get("chunks") or [],
                job_id=safe_job_id,
                asset_id=asset_id,
                key=key,
                read_chunk=lambda remote_path: open(f"/encrypted-ingest/{remote_path.lstrip('/')}", "rb").read(),
                destination=destination,
            )
        if digest != str(asset_manifest.get("plaintext_sha256") or ""):
            raise ValueError("Whole-audio digest mismatch after cloud decryption.")

        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(audio_path)],
            capture_output=True,
            text=True,
            check=True,
        )
        duration_seconds = float(json.loads(probe.stdout).get("format", {}).get("duration") or 0)

        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(audio_path), "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", str(decoded_audio_path),
            ],
            check=True,
        )

        whisper = WhisperModel("large-v3", device="cuda", compute_type="float16")
        segments, transcription_info = whisper.transcribe(
            str(decoded_audio_path),
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
            condition_on_previous_text=True,
        )
        transcript_segments = []
        transcript_words = []
        for segment in segments:
            words = []
            for word in segment.words or []:
                probability = _clean_float(word.probability, 4)
                item = {
                    "start_s": _clean_float(word.start),
                    "end_s": _clean_float(word.end),
                    "text": str(word.word or "").strip(),
                    "probability": probability,
                    "reliable": probability is not None and probability >= 0.25,
                }
                words.append(item)
                transcript_words.append(item)
            no_speech_probability = _clean_float(segment.no_speech_prob, 4)
            transcript_segments.append({
                "start_s": _clean_float(segment.start),
                "end_s": _clean_float(segment.end),
                "text": str(segment.text or "").strip(),
                "avg_logprob": _clean_float(segment.avg_logprob, 4),
                "no_speech_prob": no_speech_probability,
                "reliable": (no_speech_probability is None or no_speech_probability <= 0.75) and any(word["reliable"] for word in words),
                "words": words,
            })

        waveform, sample_rate = librosa.load(str(decoded_audio_path), sr=16000, mono=True)
        decoded_duration_seconds = len(waveform) / sample_rate if sample_rate else duration_seconds
        model_name = "MIT/ast-finetuned-audioset-10-10-0.4593"
        extractor = AutoFeatureExtractor.from_pretrained(model_name)
        sound_model = AutoModelForAudioClassification.from_pretrained(model_name).to("cuda").eval()
        relevant = ("breath", "gasp", "pant", "sigh", "sniff", "cough", "speech", "whisper", "moan", "groan", "grunt")
        window_seconds = 10
        step_seconds = 5
        window_samples = window_seconds * sample_rate
        step_samples = step_seconds * sample_rate
        windows = []
        starts = []
        for start in range(0, max(1, len(waveform)), step_samples):
            clip = waveform[start:start + window_samples]
            if len(clip) < sample_rate:
                break
            windows.append(clip)
            starts.append(start / sample_rate)

        acoustic_events = []
        for batch_start in range(0, len(windows), 8):
            batch = windows[batch_start:batch_start + 8]
            inputs = extractor(batch, sampling_rate=sample_rate, return_tensors="pt", padding=True)
            inputs = {key_name: value.to("cuda") for key_name, value in inputs.items()}
            with torch.inference_mode():
                probabilities = torch.sigmoid(sound_model(**inputs).logits).cpu()
            for row_index, row in enumerate(probabilities):
                top_values, top_indexes = torch.topk(row, k=min(20, row.shape[-1]))
                window_start = starts[batch_start + row_index]
                for confidence, label_index in zip(top_values.tolist(), top_indexes.tolist()):
                    label = str(sound_model.config.id2label[int(label_index)])
                    if confidence < 0.12 or not any(token in label.lower() for token in relevant):
                        continue
                    acoustic_events.append({
                        "start_s": _clean_float(window_start),
                        "end_s": _clean_float(min(decoded_duration_seconds, window_start + window_seconds)),
                        "label": label,
                        "confidence": _clean_float(confidence, 4),
                        "confidence_band": _confidence_band(confidence),
                        "state": "candidate",
                        "model": model_name,
                    })

        merged_acoustic_events = _merge_acoustic_windows(acoustic_events)

        return {
            "ok": True,
            "schema_version": "sarah.audio-evidence.v1",
            "job_id": safe_job_id,
            "asset_id": asset_id,
            "audio": {
                "duration_seconds": _clean_float(decoded_duration_seconds),
                "container_estimated_duration_seconds": _clean_float(duration_seconds),
                "plaintext_bytes": plaintext_bytes,
                "plaintext_sha256": digest,
            },
            "transcription": {
                "model": "faster-whisper-large-v3",
                "language": transcription_info.language,
                "language_probability": _clean_float(transcription_info.language_probability, 4),
                "segments": transcript_segments,
                "words": transcript_words,
                "reliable_segment_count": sum(1 for item in transcript_segments if item["reliable"]),
                "reliable_word_count": sum(1 for item in transcript_words if item["reliable"]),
            },
            "acoustic_events": merged_acoustic_events,
            "acoustic_event_windows": acoustic_events,
            "limitations": [
                "Acoustic event labels are AudioSet model candidates, not user-confirmed observations.",
                "Breathing, gasp, sigh, and vocalization candidates require review before becoming timeline facts.",
            ],
            "privacy": {
                "plaintext_retained": False,
                "encrypted_chunks_cleanup_scheduled": True,
            },
        }
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
        shutil.rmtree(job_root, ignore_errors=True)
        ingest_volume.commit()


@app.function(
    image=visual_image,
    gpu="L4",
    cpu=4,
    memory=32768,
    timeout=3600,
    volumes={"/encrypted-ingest": ingest_volume},
)
def analyze_encrypted_visual(job_id: str, asset_manifest: dict, key_b64: str) -> dict:
    """Analyze an encrypted low-frame-rate visual proxy and return timestamped evidence."""
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    from qwen_vl_utils import process_vision_info
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
    from ultralytics import YOLO
    from encrypted_transport import decrypt_chunks_to_file

    safe_job_id = str(job_id or "").strip()
    asset_id = str(asset_manifest.get("asset_id") or "").strip()
    if not safe_job_id or not asset_id or any(part in safe_job_id + asset_id for part in ("..", "/", "\\")):
        raise ValueError("Unsafe cloud analysis job or asset identifier.")

    job_root = f"/encrypted-ingest/jobs/{safe_job_id}"
    work_root = Path(f"/tmp/{safe_job_id}")
    work_root.mkdir(parents=True, exist_ok=True)
    video_path = work_root / "visual-proxy.mp4"
    try:
        key = base64.b64decode(key_b64, validate=True)
        with video_path.open("wb") as destination:
            plaintext_bytes, digest = decrypt_chunks_to_file(
                asset_manifest.get("chunks") or [],
                job_id=safe_job_id,
                asset_id=asset_id,
                key=key,
                read_chunk=lambda remote_path: open(f"/encrypted-ingest/{remote_path.lstrip('/')}", "rb").read(),
                destination=destination,
            )
        if digest != str(asset_manifest.get("plaintext_sha256") or ""):
            raise ValueError("Whole-video digest mismatch after cloud decryption.")

        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
                "-of", "json", str(video_path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        probe_data = json.loads(probe.stdout)
        stream = (probe_data.get("streams") or [{}])[0]
        duration_seconds = float(probe_data.get("format", {}).get("duration") or 0)

        pose_model = YOLO("yolo11n-pose.pt")
        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            raise RuntimeError("OpenCV could not open the decrypted visual proxy.")
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 2.0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or stream.get("width") or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or stream.get("height") or 0)
        frame_metrics = []
        pose_samples = []
        previous_gray = None
        frame_index = 0
        pose_stride = max(1, round(fps * 2.0))
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            timestamp = frame_index / fps
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            motion = 0.0 if previous_gray is None else float(np.mean(cv2.absdiff(gray, previous_gray)) / 255.0)
            scene_score = 0.0 if previous_gray is None else float(
                cv2.compareHist(
                    cv2.calcHist([previous_gray], [0], None, [64], [0, 256]),
                    cv2.calcHist([gray], [0], None, [64], [0, 256]),
                    cv2.HISTCMP_BHATTACHARYYA,
                )
            )
            frame_metrics.append({
                "time_s": _clean_float(timestamp),
                "brightness": _clean_float(np.mean(gray) / 255.0, 4),
                "blur_score": _clean_float(cv2.Laplacian(gray, cv2.CV_64F).var(), 2),
                "motion": _clean_float(motion, 4),
                "scene_score": _clean_float(scene_score, 4),
            })
            if frame_index % pose_stride == 0:
                result = pose_model.predict(frame, imgsz=640, conf=0.25, verbose=False)[0]
                people = []
                boxes = result.boxes.xyxy.cpu().tolist() if result.boxes is not None else []
                keypoints_xy = result.keypoints.xy.cpu().tolist() if result.keypoints is not None else []
                keypoints_conf = result.keypoints.conf.cpu().tolist() if result.keypoints is not None and result.keypoints.conf is not None else []
                for person_index, points in enumerate(keypoints_xy):
                    confidences = keypoints_conf[person_index] if person_index < len(keypoints_conf) else []
                    normalized_points = []
                    for point_index, point in enumerate(points):
                        confidence = confidences[point_index] if point_index < len(confidences) else 0
                        normalized_points.append({
                            "x": _clean_float(point[0] / width if width else 0, 4),
                            "y": _clean_float(point[1] / height if height else 0, 4),
                            "confidence": _clean_float(confidence, 4),
                        })
                    box = boxes[person_index] if person_index < len(boxes) else [0, 0, 0, 0]
                    people.append({
                        "bbox": [
                            _clean_float(box[0] / width if width else 0, 4),
                            _clean_float(box[1] / height if height else 0, 4),
                            _clean_float(box[2] / width if width else 0, 4),
                            _clean_float(box[3] / height if height else 0, 4),
                        ],
                        "visible_keypoints": sum(1 for confidence in confidences if confidence >= 0.25),
                        "keypoints": normalized_points,
                    })
                pose_samples.append({
                    "time_s": _clean_float(timestamp),
                    "tracking_state": "visible" if people else "lost",
                    "people": people,
                })
            previous_gray = gray
            frame_index += 1
        capture.release()

        selected_timestamps = _select_visual_timestamps(frame_metrics, duration_seconds)
        semantic_frames = []
        semantic_capture = cv2.VideoCapture(str(video_path))
        for timestamp in selected_timestamps:
            images = []
            actual_times = []
            for frame_time in (max(0.0, timestamp - 1.0), timestamp, min(duration_seconds, timestamp + 1.0)):
                semantic_capture.set(cv2.CAP_PROP_POS_MSEC, frame_time * 1000)
                ok, frame = semantic_capture.read()
                if not ok:
                    continue
                images.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
                actual_times.append(_clean_float(frame_time))
            if images:
                semantic_frames.append({"time_s": timestamp, "frame_times_s": actual_times, "images": images})
        semantic_capture.release()

        model_name = "Qwen/Qwen2.5-VL-7B-Instruct"
        processor = AutoProcessor.from_pretrained(model_name)
        vision_model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=torch.bfloat16,
            device_map="auto",
        ).eval()
        prompt = (
            "Analyze these three nearby frames from a private physiological session as clinical visual evidence. "
            "Use anatomically accurate, non-erotic language. Report only what is visibly supported and describe change across frames. "
            "Do not infer identity, intent, sensation, diagnosis, arousal, or climax. Return one compact JSON object with keys "
            "subject_visibility, body_position, visible_body_regions, actions, devices, interactions, visible_physiological_cues, "
            "camera_quality, change_across_frames, uncertainty. Use unknown or empty arrays when evidence is insufficient."
        )
        semantic_windows = []
        for item in semantic_frames:
            content = [{"type": "image", "image": image} for image in item["images"]]
            content.append({"type": "text", "text": prompt})
            messages = [{"role": "user", "content": content}]
            rendered_prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            image_inputs, video_inputs = process_vision_info(messages)
            inputs = processor(
                text=[rendered_prompt],
                images=image_inputs,
                videos=video_inputs,
                padding=True,
                return_tensors="pt",
            ).to(vision_model.device)
            with torch.inference_mode():
                generated = vision_model.generate(**inputs, max_new_tokens=320, do_sample=False)
            trimmed = generated[:, inputs.input_ids.shape[1]:]
            response = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
            semantic_windows.append({
                "source_start_s": _clean_float(min(item["frame_times_s"])),
                "source_end_s": _clean_float(max(item["frame_times_s"])),
                "representative_time_s": _clean_float(item["time_s"]),
                "modality": "visual",
                "source_asset_id": asset_id,
                "model_name": model_name,
                "model_version": "7B-Instruct",
                "claim_state": "inferred",
                "review_state": "candidate",
                "description": _extract_json_object(response),
            })

        return {
            "ok": True,
            "schema_version": "sarah.visual-evidence.v1",
            "job_id": safe_job_id,
            "asset_id": asset_id,
            "video": {
                "duration_seconds": _clean_float(duration_seconds),
                "width": width,
                "height": height,
                "fps": _clean_float(fps),
                "frame_count": frame_index,
                "plaintext_bytes": plaintext_bytes,
                "plaintext_sha256": digest,
                "source_container": asset_manifest.get("source_container"),
                "source_size_bytes": asset_manifest.get("source_size_bytes"),
            },
            "frame_metrics": frame_metrics,
            "pose_samples": pose_samples,
            "semantic_windows": semantic_windows,
            "limitations": [
                "The visual proxy is sampled at 2 fps and scaled to a maximum width of 1280 pixels.",
                "COCO pose keypoints may be lost during close-up, cropped, or occluded views; lost is preserved rather than guessed.",
                "Vision-language descriptions are candidates and require review before becoming timeline facts.",
            ],
            "privacy": {
                "plaintext_retained": False,
                "encrypted_chunks_cleanup_scheduled": True,
            },
        }
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
        shutil.rmtree(job_root, ignore_errors=True)
        ingest_volume.commit()


@app.local_entrypoint()
def main(mode: str = "health", test_bytes: int = 2_000_000, input_path: str = "", result_dir: str = "data/cloud-analysis/results", job_id: str = "") -> None:
    if mode == "health":
        print(health.remote())
        return
    if mode == "audio-pilot":
        _run_audio_pilot(input_path=input_path, result_dir=result_dir)
        return
    if mode == "visual-pilot":
        _run_visual_pilot(input_path=input_path, result_dir=result_dir)
        return
    if mode == "cleanup-job":
        print(f"SARAH_CLOUD_CLEANUP={json.dumps(cleanup_encrypted_job.remote(job_id))}")
        return
    if mode != "encrypted-test":
        raise ValueError("mode must be health, encrypted-test, audio-pilot, visual-pilot, or cleanup-job")

    from encrypted_transport import encrypt_stream

    job_id = f"transport-test-{uuid.uuid4().hex}"
    asset_id = "synthetic-random-bytes"
    key = os.urandom(32)
    source = os.urandom(max(1024, int(test_bytes)))
    with ingest_volume.batch_upload(force=True) as upload:
        manifest = encrypt_stream(
            io.BytesIO(source),
            job_id=job_id,
            asset_id=asset_id,
            key=key,
            chunk_bytes=1024 * 1024,
            upload_chunk=lambda remote_path, payload: upload.put_file(payload, f"/{remote_path}"),
        )
    expected_digest = hashlib.sha256(source).hexdigest()
    result = verify_encrypted_job.remote(job_id, manifest, base64.b64encode(key).decode("ascii"))
    if result.get("plaintext_sha256") != expected_digest:
        raise RuntimeError("Encrypted Modal round-trip returned the wrong digest.")
    print(result)


def _run_audio_pilot(*, input_path: str, result_dir: str) -> None:
    from encrypted_transport import encrypt_stream

    source_path = Path(input_path).expanduser().resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"Pilot media was not found: {source_path}")
    job_id = f"audio-pilot-{uuid.uuid4().hex}"
    print(f"SARAH_CLOUD_JOB={job_id}", flush=True)
    asset_id = "primary-audio"
    key = os.urandom(32)
    ffmpeg = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-i", str(source_path), "-map", "0:a:0",
            "-vn", "-c:a", "copy", "-f", "adts", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        if ffmpeg.stdout is None:
            raise RuntimeError("ffmpeg did not expose its audio stream.")

        def upload_one(remote_path: str, payload: io.BytesIO) -> None:
            with ingest_volume.batch_upload(force=True) as upload:
                upload.put_file(payload, f"/{remote_path}")

        manifest = encrypt_stream(
            ffmpeg.stdout,
            job_id=job_id,
            asset_id=asset_id,
            key=key,
            chunk_bytes=64 * 1024 * 1024,
            upload_chunk=upload_one,
        )
        stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
        return_code = ffmpeg.wait()
        if return_code != 0:
            raise RuntimeError(f"ffmpeg audio extraction failed: {stderr[-1000:]}")
        manifest["source_container"] = source_path.suffix.lower()
        manifest["audio_transport_format"] = "aac_adts_stream_copy"
        result = analyze_encrypted_audio.remote(job_id, manifest, base64.b64encode(key).decode("ascii"))
        output_root = Path(result_dir).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        output_path = output_root / f"{job_id}.json"
        output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        summary = {
            "ok": result.get("ok"),
            "job_id": job_id,
            "duration_seconds": result.get("audio", {}).get("duration_seconds"),
            "transcript_segments": len(result.get("transcription", {}).get("segments") or []),
            "transcript_words": len(result.get("transcription", {}).get("words") or []),
            "acoustic_event_candidates": len(result.get("acoustic_events") or []),
            "result_path": str(output_path),
        }
        print(f"SARAH_CLOUD_RESULT={json.dumps(summary)}")
        return summary
    finally:
        if ffmpeg.poll() is None:
            ffmpeg.kill()
            ffmpeg.wait()
        try:
            ingest_volume.remove_file(f"jobs/{job_id}", recursive=True)
        except Exception:
            pass


def _run_visual_pilot(*, input_path: str, result_dir: str) -> None:
    from encrypted_transport import encrypt_stream

    source_path = Path(input_path).expanduser().resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"Pilot media was not found: {source_path}")
    job_id = f"visual-pilot-{uuid.uuid4().hex}"
    print(f"SARAH_CLOUD_JOB={job_id}", flush=True)
    asset_id = "primary-visual"
    key = os.urandom(32)
    ffmpeg = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-i", str(source_path), "-map", "0:v:0",
            "-an", "-vf", "fps=2,scale='min(1280,iw)':-2:flags=lanczos",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        if ffmpeg.stdout is None:
            raise RuntimeError("ffmpeg did not expose its visual proxy stream.")

        def upload_one(remote_path: str, payload: io.BytesIO) -> None:
            with ingest_volume.batch_upload(force=True) as upload:
                upload.put_file(payload, f"/{remote_path}")

        manifest = encrypt_stream(
            ffmpeg.stdout,
            job_id=job_id,
            asset_id=asset_id,
            key=key,
            chunk_bytes=64 * 1024 * 1024,
            upload_chunk=upload_one,
        )
        stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
        return_code = ffmpeg.wait()
        if return_code != 0:
            raise RuntimeError(f"ffmpeg visual proxy extraction failed: {stderr[-1000:]}")
        manifest["source_container"] = source_path.suffix.lower()
        manifest["source_size_bytes"] = source_path.stat().st_size
        manifest["visual_transport_format"] = "h264_720p_2fps_fragmented_mp4"
        result = analyze_encrypted_visual.remote(job_id, manifest, base64.b64encode(key).decode("ascii"))
        output_root = Path(result_dir).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        output_path = output_root / f"{job_id}.json"
        output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        summary = {
            "ok": result.get("ok"),
            "job_id": job_id,
            "duration_seconds": result.get("video", {}).get("duration_seconds"),
            "proxy_bytes": result.get("video", {}).get("plaintext_bytes"),
            "frame_metrics": len(result.get("frame_metrics") or []),
            "pose_samples": len(result.get("pose_samples") or []),
            "semantic_windows": len(result.get("semantic_windows") or []),
            "result_path": str(output_path),
        }
        print(f"SARAH_CLOUD_RESULT={json.dumps(summary)}")
        return summary
    finally:
        if ffmpeg.poll() is None:
            ffmpeg.kill()
            ffmpeg.wait()
        try:
            ingest_volume.remove_file(f"jobs/{job_id}", recursive=True)
        except Exception:
            pass
