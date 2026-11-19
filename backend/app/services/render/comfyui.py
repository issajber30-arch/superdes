"""ComfyUI renderer (self-hosted GPU). Sends a minimal txt2img workflow; prompt built from the scene."""
import os
import time

import httpx


class ComfyUIRenderer:
    name = "comfyui"

    def __init__(self, url: str, checkpoint: str | None = None, timeout_s: int = 300):
        self.url, self.timeout = url, timeout_s
        self.checkpoint = checkpoint or os.environ.get("COMFYUI_CHECKPOINT", "sd_xl_base_1.0.safetensors")

    def _workflow(self, scene: dict) -> dict:
        items = ", ".join(sorted({f["name"] for f in scene["furniture"]})) or "minimal furniture"
        prompt = (f"interior design concept, {scene['style_name']} style {scene['room_kind']}, {items}, "
                  f"walls {scene['wall_color']}, floor {scene['floor_color']}, natural light, architectural visualization")
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": self.checkpoint}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "people, text, watermark, distorted", "clip": ["1", 1]}},
            "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 640, "batch_size": 1}},
            "5": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
                                                       "latent_image": ["4", 0], "seed": scene["seed"], "steps": 25, "cfg": 6.5,
                                                       "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0}},
            "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
            "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "superdes"}},
        }

    def render(self, scene: dict) -> bytes:
        with httpx.Client(base_url=self.url, timeout=30) as c:
            pid = c.post("/prompt", json={"prompt": self._workflow(scene)}).raise_for_status().json()["prompt_id"]
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                hist = c.get(f"/history/{pid}").raise_for_status().json()
                if pid in hist:
                    for out in hist[pid]["outputs"].values():
                        for im in out.get("images", []):
                            return c.get("/view", params={"filename": im["filename"], "subfolder": im.get("subfolder", ""),
                                                          "type": im.get("type", "output")}).raise_for_status().content
                    raise RuntimeError("ComfyUI returned no image")
                time.sleep(2)
        raise TimeoutError("ComfyUI render timed out")
