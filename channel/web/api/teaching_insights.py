"""Agent-scoped insight endpoints; route registration belongs to the coordinator."""

import functools
import json
import os

import web

from agent.teaching import TeachingStore
from agent.teaching.insights import facts, import_progress, recent
from channel.web.core._common import _get_workspace_root, _request_agent_id, _require_auth
from common.log import logger


def _endpoint(method):
    @functools.wraps(method)
    def wrapper(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        web.header('Cache-Control', 'no-store')
        try:
            payload = {"status": "success", **method(self)}
        except (ValueError, TypeError, KeyError) as exc:
            payload = {"status": "error", "code": "bad_request", "message": str(exc)}
        except Exception as exc:
            logger.error(f"[WebChannel] Teaching insights {method.__name__} error: {exc}")
            payload = {"status": "error", "code": "bad_request", "message": "读取教学数据失败，请重试"}
        return json.dumps(payload, ensure_ascii=False)
    return wrapper


class TeachingFactsHandler:
    @_endpoint
    def GET(self):
        params = web.input(class_id='', unit='', agent_id='')
        workspace = _get_workspace_root(agent_id=_request_agent_id(params))
        store = TeachingStore(os.path.join(workspace, "teaching"))
        return facts(store, (params.class_id or '').strip(), params.unit or '')


class TeachingProgressImportHandler:
    @_endpoint
    def POST(self):
        try:
            body = json.loads(web.data() or b'{}')
        except (ValueError, UnicodeError):
            raise ValueError("请求正文必须为有效 JSON 对象") from None
        if not isinstance(body, dict):
            raise ValueError("请求正文必须为 JSON 对象")
        workspace = _get_workspace_root(agent_id=_request_agent_id(body))
        store = TeachingStore(os.path.join(workspace, "teaching"))
        return import_progress(store, body.get("class_ids"), body.get("weeks"),
                               body.get("overwrite", False))


class TeachingRecentHandler:
    @_endpoint
    def GET(self):
        params = web.input(kind='', limit='5', agent_id='')
        workspace = _get_workspace_root(agent_id=_request_agent_id(params))
        try:
            limit = int(params.limit)
        except (ValueError, TypeError):
            raise ValueError("limit 必须为正整数") from None
        return recent(workspace, params.kind or '', limit)


TEACHING_INSIGHTS_URLS = (
    ('/api/teaching/facts', 'TeachingFactsHandler'),
    ('/api/teaching/progress/import', 'TeachingProgressImportHandler'),
    ('/api/teaching/recent', 'TeachingRecentHandler'),
)

__all__ = [
    "TeachingFactsHandler", "TeachingProgressImportHandler", "TeachingRecentHandler",
    "TEACHING_INSIGHTS_URLS",
]
