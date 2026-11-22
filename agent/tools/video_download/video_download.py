"""Download a Douyin / Xiaohongshu / Bilibili video into the workspace.

The tool takes the blob the user pasted, not a parsed link: people share text,
and mining the URL out of it is the whole point. The returned path is absolute
and inside the user's output directory, which is what puts the file in the
artifacts list and lets the channel `send` tool ship it.
"""

import json
from typing import Dict

from agent.media.video import service
from agent.tools.base_tool import BaseTool, ToolResult
from common.log import logger


class VideoDownloadTool(BaseTool):
    name: str = "video_download"
    description: str = (
        "Download a video from Douyin (抖音), Xiaohongshu (小红书) or Bilibili (B站) "
        "to the local workspace, without a platform watermark. "
        "Pass the whole pasted share text (e.g. '8.88 复制打开抖音，看看… https://v.douyin.com/xxx/'), "
        "not a cleaned-up URL: the tool extracts and resolves the link itself. "
        "One video per call; it returns the saved file path so you can tell the user where it is "
        "or send it with the send tool."
    )

    params: dict = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "视频链接或整段分享文案（抖音 / 小红书 / B 站）。",
            },
            "quality": {
                "type": "string",
                "enum": ["best", "1080", "720", "480"],
                "description": "清晰度上限，默认 best。抖音只提供原片，此参数无效。",
            },
            "max_mb": {
                "type": "integer",
                "description": "体积上限（MB），默认 1024。",
            },
        },
        "required": ["url"],
    }

    def is_available(self) -> bool:
        return service.available()

    def execute(self, args: dict) -> ToolResult:
        url = str(args.get("url") or "").strip()
        if not url:
            return ToolResult.fail("缺少 url：把链接或整段分享文案贴进来。")

        quality = str(args.get("quality") or "best")
        max_mb = args.get("max_mb") or service.DEFAULT_MAX_MB
        last = {"step": 0.0}

        def on_event(event: Dict) -> None:
            stage = event.get("stage")
            if stage == "probe":
                self.report_progress("正在解析链接…")
                return
            if stage != "download":
                return
            percent = event.get("percent")
            if percent is None:
                return
            # Four progress updates per download: enough to look alive, few
            # enough not to drown the chat card.
            if percent - last["step"] >= 25 or percent >= 100:
                last["step"] = percent
                speed = event.get("speed") or ""
                self.report_progress(f"下载中 {percent:.0f}% {speed}".strip())

        try:
            result = service.download(
                url, quality=quality, max_mb=max_mb, on_event=on_event
            )
        except service.VideoError as e:
            logger.warning(f"[video_download] {e.reason}: {e}")
            return ToolResult.fail(f"{e}（{e.reason}）")
        except Exception as e:  # pragma: no cover - defensive
            logger.error(f"[video_download] unexpected: {e}", exc_info=True)
            return ToolResult.fail(f"下载失败：{type(e).__name__}: {e}")

        payload = {
            "path": result["path"],
            "title": result.get("title") or "",
            "size": result.get("size") or 0,
            "platform": result.get("platform"),
            "url": result.get("url"),
        }
        display = f"已保存：{payload['title'] or payload['path']}"
        return ToolResult.success(json.dumps(payload, ensure_ascii=False), display=display)
