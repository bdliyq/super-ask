#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Super Ask HTTP 客户端：向本地 Server 提交问题并阻塞等待用户回复。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from enum import Enum
import urllib.error
import urllib.request

DEFAULT_PORT = 19960
DEFAULT_TIMEOUT = 86400  # 24 小时（秒）
HOST = "127.0.0.1"


class RequestOutcome(Enum):
    SUCCESS = "success"
    RETRYABLE = "retryable"
    FATAL = "fatal"
    FATAL_RESPONSE = "fatal_response"


def _log_path() -> str:
    log_dir = os.path.join(os.path.expanduser("~"), ".super-ask", "logs")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, f"{datetime.now().strftime('%Y-%m-%d')}.log")


def _log_event(event: str, **payload: object) -> None:
    entry = {
        "timestamp": datetime.now().astimezone().isoformat(),
        "source": "cli",
        "event": event,
        **payload,
    }
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    except OSError:
        pass


def _read_auth_token(port: int) -> str | None:
    """从 ~/.super-ask/token 读取鉴权 token"""
    token_path = os.path.join(os.path.expanduser("~"), ".super-ask", "token")
    try:
        with open(token_path, "r", encoding="utf-8") as f:
            token = f.read().strip()
            return token if token else None
    except OSError:
        return None


def _unescape_newlines(s: str) -> str:
    """将字面量 \\n 转为真实换行（AI 在 shell 中写 \\n 时 bash 不会转义）"""
    return s.replace("\\n", "\n")


def _build_payload(args: argparse.Namespace) -> dict:
    body: dict = {
        "summary": _unescape_newlines(args.summary),
        "question": _unescape_newlines(args.question),
    }
    if args.title is not None:
        body["title"] = args.title
    if args.chat_session_id is not None:
        body["chatSessionId"] = args.chat_session_id
    if args.options is not None:
        body["options"] = list(args.options)
    if args.source is not None:
        body["source"] = args.source
    if args.workspace_root is not None:
        body["workspaceRoot"] = args.workspace_root
    return body


def _http_error_message(body: bytes) -> tuple[str, str | None]:
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return "", None
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            msg = obj.get("error")
            code = obj.get("code")
            if isinstance(msg, str):
                return msg, code if isinstance(code, str) else None
    except json.JSONDecodeError:
        pass
    return (text[:2000] if len(text) > 2000 else text), None


def _is_timeout(err: BaseException) -> bool:
    if isinstance(err, TimeoutError):
        return True
    cur: BaseException | None = err
    while cur is not None:
        if isinstance(cur, TimeoutError):
            return True
        if isinstance(cur, OSError) and getattr(cur, "errno", None) == 110:  # ETIMEDOUT
            return True
        cur = cur.__cause__ or cur.__context__
    s = str(err).lower()
    return "timed out" in s or "timeout" in s


def _send_request(
    url: str,
    payload: dict,
    timeout: int = DEFAULT_TIMEOUT,
    auth_token: str | None = None,
) -> tuple[RequestOutcome, str]:
    """发送 POST 请求并返回 (outcome, output)。SUCCESS 时 output 为 JSON 字符串。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
    }
    _log_event(
        "request.attempt",
        url=url,
        method="POST",
        headers=headers,
        payload=payload,
        timeout=timeout,
    )
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            raw_text = raw.decode("utf-8", errors="replace")
            _log_event(
                "response.success",
                url=url,
                status=getattr(resp, "status", 200),
                headers=dict(resp.headers.items()),
                rawResponse=raw_text,
            )
    except urllib.error.HTTPError as e:
        raw = e.read()
        raw_text = raw.decode("utf-8", errors="replace")
        msg, err_code = _http_error_message(raw)
        message = f"错误: Server 返回 HTTP {e.code}: {msg}" if msg else f"错误: Server 返回 HTTP {e.code}: {e.reason}"
        _log_event(
            "response.http_error",
            url=url,
            method="POST",
            headers=headers,
            payload=payload,
            timeout=timeout,
            status=e.code,
            reason=str(e.reason),
            rawResponse=raw_text,
            message=message,
            errorCode=err_code,
        )
        if e.code == 503 and err_code == "SERVER_SHUTTING_DOWN":
            return RequestOutcome.RETRYABLE, message
        if msg:
            return RequestOutcome.FATAL, message
        return RequestOutcome.FATAL, message
    except urllib.error.URLError as e:
        message = "错误: 等待回复超时" if _is_timeout(e) else "错误: Super Ask Server 未运行。请先启动: super-ask start"
        _log_event(
            "response.transport_error",
            url=url,
            method="POST",
            headers=headers,
            payload=payload,
            timeout=timeout,
            errorType=type(e).__name__,
            error=repr(e),
            message=message,
        )
        if _is_timeout(e):
            return RequestOutcome.RETRYABLE, message
        return RequestOutcome.RETRYABLE, message
    except TimeoutError as e:
        _log_event(
            "response.transport_error",
            url=url,
            method="POST",
            headers=headers,
            payload=payload,
            timeout=timeout,
            errorType=type(e).__name__,
            error=repr(e),
            message="错误: 等待回复超时",
        )
        return RequestOutcome.RETRYABLE, "错误: 等待回复超时"
    except OSError as e:
        _log_event(
            "response.transport_error",
            url=url,
            method="POST",
            headers=headers,
            payload=payload,
            timeout=timeout,
            errorType=type(e).__name__,
            errno=getattr(e, "errno", None),
            error=repr(e),
            message="错误: Super Ask Server 未运行或网络异常",
        )
        return RequestOutcome.RETRYABLE, "错误: Super Ask Server 未运行或网络异常"
    except Exception as e:
        _log_event(
            "response.transport_error",
            url=url,
            method="POST",
            headers=headers,
            payload=payload,
            timeout=timeout,
            errorType=type(e).__name__,
            error=repr(e),
            message="错误: 连接异常中断",
        )
        return RequestOutcome.RETRYABLE, "错误: 连接异常中断"

    try:
        obj = json.loads(raw_text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        _log_event(
            "response.invalid",
            url=url,
            rawResponse=raw_text,
            message="错误: Server 返回无效响应",
        )
        return RequestOutcome.FATAL_RESPONSE, "错误: Server 返回无效响应"

    if not isinstance(obj, dict):
        _log_event(
            "response.invalid",
            url=url,
            rawResponse=raw_text,
            message="错误: Server 返回无效响应",
        )
        return RequestOutcome.FATAL_RESPONSE, "错误: Server 返回无效响应"

    # 长连接模式下 Server 重启时，响应头已以 200 发送，错误通过 JSON body 传递。
    # 客户端通过 code 字段识别可重试错误。
    if obj.get("code") == "SERVER_SHUTTING_DOWN":
        message = f"错误: {obj.get('error', '服务器正在关闭')}"
        _log_event("response.shutdown_retry", url=url, rawResponse=raw_text, message=message)
        return RequestOutcome.RETRYABLE, message

    output = json.dumps(obj, ensure_ascii=False)
    _log_event("response.parsed", url=url, parsedResponse=obj)
    return RequestOutcome.SUCCESS, output


def _send_ack(port: int, chat_session_id: str, auth_token: str | None = None) -> None:
    """向 Server 发送确认回执（best-effort，失败不影响主流程）"""
    url = f"http://{HOST}:{port}/api/ack"
    payload = {"chatSessionId": chat_session_id}
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
    }
    _log_event(
        "ack.attempt",
        url=url,
        method="POST",
        headers=headers,
        payload=payload,
        timeout=5,
    )
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            _log_event(
                "ack.success",
                url=url,
                status=getattr(resp, "status", 200),
                headers=dict(resp.headers.items()),
                rawResponse=raw,
                payload=payload,
            )
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        _log_event(
            "ack.error",
            url=url,
            status=e.code,
            reason=str(e.reason),
            rawResponse=raw,
            payload=payload,
        )
    except Exception as e:
        _log_event(
            "ack.error",
            url=url,
            payload=payload,
            error=repr(e),
        )
        pass


def _validate_blocking_response(raw_json: str) -> tuple[int, str]:
    """验证阻塞模式的响应包含 chatSessionId 和 feedback。"""
    try:
        obj = json.loads(raw_json)
    except json.JSONDecodeError:
        return 1, "错误: 无效的响应 JSON"
    if not isinstance(obj, dict):
        return 1, "错误: 响应格式错误"
    cid = obj.get("chatSessionId")
    feedback = obj.get("feedback")
    if not isinstance(cid, str) or not isinstance(feedback, str):
        return 1, "错误: 响应缺少 chatSessionId 或 feedback"
    return 0, raw_json


def main() -> int:
    parser = argparse.ArgumentParser(
        description="向 Super Ask Server 提交请求并等待用户回复。",
    )
    parser.add_argument("--summary", default=None, help="Markdown 格式的摘要")
    parser.add_argument("--question", default=None, help="提问内容")
    parser.add_argument("--title", default=None, help="Tab 标题")
    parser.add_argument(
        "--session-id",
        dest="chat_session_id",
        default=None,
        help="chatSessionId（同一会话后续调用时传入）",
    )
    parser.add_argument(
        "--options",
        nargs="*",
        default=None,
        help="可选选项列表（可多个）",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Server 端口（默认 {DEFAULT_PORT}）",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="来源标识（cursor / vscode / codex / qwen 等）",
    )
    parser.add_argument(
        "--workspace-root",
        dest="workspace_root",
        default=None,
        help="Agent 所在工作区根路径",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=-1,
        help="可恢复错误的重试次数（默认 -1，表示无限重试）",
    )
    args = parser.parse_args()

    # 提交模式
    if not args.summary or not args.question:
        print("错误: --summary 和 --question 是必填参数", file=sys.stderr)
        return 1

    auth_token = _read_auth_token(args.port)
    url = f"http://{HOST}:{args.port}/super-ask"
    payload = _build_payload(args)

    max_retries = args.retries
    retry_count = 0

    while True:
        outcome, output = _send_request(
            url, payload, timeout=DEFAULT_TIMEOUT, auth_token=auth_token
        )
        if outcome == RequestOutcome.SUCCESS:
            vcode, vout = _validate_blocking_response(output)
            if vcode != 0:
                _log_event(
                    "response.invalid_blocking",
                    url=url,
                    output=output,
                    message=vout,
                )
                print(vout, file=sys.stderr)
                return 1
            try:
                resp_obj = json.loads(output)
                cid = resp_obj.get("chatSessionId")
                if cid:
                    _send_ack(args.port, cid, auth_token)
            except Exception:
                pass
            _log_event("result.returned", url=url, output=output)
            print(output)
            return 0
        if outcome != RequestOutcome.RETRYABLE:
            _log_event(
                "request.fatal",
                url=url,
                outcome=outcome.value,
                message=output,
            )
            print(output, file=sys.stderr)
            return 1
        if max_retries >= 0 and retry_count >= max_retries:
            _log_event(
                "request.retry_exhausted",
                url=url,
                outcome=outcome.value,
                retryCount=retry_count,
                maxRetries=max_retries,
                message=output,
            )
            print(output, file=sys.stderr)
            return 1
        retry_count += 1
        wait = 10
        _log_event(
            "retry.wait",
            url=url,
            retryCount=retry_count,
            maxRetries=max_retries,
            waitSeconds=wait,
            message=output,
        )
        import time
        time.sleep(wait)

    return 1


if __name__ == "__main__":
    sys.exit(main())
