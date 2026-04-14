#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Super Ask HTTP 客户端：向本地 Server 提交问题并阻塞等待用户回复。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = 19960
DEFAULT_TIMEOUT = 86400  # 24 小时（秒）
HOST = "127.0.0.1"


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


def _http_error_message(code: int, body: bytes) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return ""
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "error" in obj and isinstance(obj["error"], str):
            return obj["error"]
    except json.JSONDecodeError:
        pass
    return text[:2000] if len(text) > 2000 else text


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
) -> tuple[int, str]:
    """发送 POST 请求并返回 (exit_code, output)。exit_code=0 时 output 为 JSON 字符串。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        msg = _http_error_message(e.code, e.read())
        if msg:
            return 1, f"错误: Server 返回 HTTP {e.code}: {msg}"
        return 1, f"错误: Server 返回 HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        if _is_timeout(e):
            return 1, "错误: 等待回复超时"
        return 2, "错误: Super Ask Server 未运行。请先启动: super-ask start"
    except TimeoutError:
        return 1, "错误: 等待回复超时"
    except OSError:
        return 2, "错误: Super Ask Server 未运行或网络异常"

    try:
        obj = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 1, "错误: Server 返回无效响应"

    if not isinstance(obj, dict):
        return 1, "错误: Server 返回无效响应"

    return 0, json.dumps(obj, ensure_ascii=False)


def _poll_request(url: str, auth_token: str | None = None) -> tuple[int, str]:
    """发送 GET 轮询请求。"""
    req = urllib.request.Request(url, method="GET")
    if auth_token:
        req.add_header("Authorization", f"Bearer {auth_token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        if e.code == 404:
            try:
                obj = json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                obj = None
            if isinstance(obj, dict) and obj.get("status") == "not_found":
                return 0, json.dumps(obj, ensure_ascii=False)
        msg = _http_error_message(e.code, raw)
        return 1, f"错误: Server 返回 HTTP {e.code}: {msg}" if msg else f"错误: HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError, OSError):
        return 2, "错误: 无法连接 Server"

    try:
        obj = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 1, "错误: Server 返回无效响应"

    return 0, json.dumps(obj, ensure_ascii=False)


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
        help="来源标识（cursor / vscode / codex 等）",
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
        default=3,
        help="网络错误时的重试次数（默认 3）",
    )
    parser.add_argument(
        "--no-wait",
        dest="no_wait",
        action="store_true",
        default=False,
        help="提交请求后立即返回，不等待用户回复（配合 --poll 使用）",
    )
    parser.add_argument(
        "--poll",
        action="store_true",
        default=False,
        help="轮询检查是否有回复（需配合 --session-id 使用）",
    )
    parser.add_argument(
        "--poll-interval",
        dest="poll_interval",
        type=int,
        default=5,
        help="轮询间隔秒数（默认 5）",
    )
    parser.add_argument(
        "--poll-timeout",
        dest="poll_timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"轮询总超时秒数（默认 {DEFAULT_TIMEOUT}，0 表示不超时）",
    )
    args = parser.parse_args()

    # poll 模式：轮询检查回复
    if args.poll:
        if not args.chat_session_id:
            print("错误: --poll 模式需要 --session-id 参数", file=sys.stderr)
            return 1
        auth_token = _read_auth_token(args.port)
        import time
        poll_url = f"http://{HOST}:{args.port}/api/poll?chatSessionId={args.chat_session_id}"
        deadline = None if args.poll_timeout <= 0 else time.time() + args.poll_timeout
        while deadline is None or time.time() < deadline:
            code, output = _poll_request(poll_url, auth_token)
            if code == 2:
                print("轮询连接失败，重试中...", file=sys.stderr)
                time.sleep(args.poll_interval)
                continue
            if code != 0:
                print(output, file=sys.stderr)
                return 1
            obj = json.loads(output)
            status = obj.get("status")
            if status == "replied":
                print(output)
                return 0
            if status == "pending":
                time.sleep(args.poll_interval)
                continue
            if status == "not_found":
                print(output)
                return 3
            print(f"错误: 意外的 poll 状态: {status}", file=sys.stderr)
            return 1
        print(
            json.dumps(
                {
                    "chatSessionId": args.chat_session_id,
                    "status": "timeout",
                },
                ensure_ascii=False,
            )
        )
        return 4

    # 提交模式
    if not args.summary or not args.question:
        print("错误: --summary 和 --question 是必填参数（除非使用 --poll）", file=sys.stderr)
        return 1

    auth_token = _read_auth_token(args.port)
    url = f"http://{HOST}:{args.port}/super-ask"
    payload = _build_payload(args)

    if args.no_wait:
        payload["noWait"] = True

    max_retries = max(0, args.retries)

    for attempt in range(max_retries + 1):
        timeout = 30 if args.no_wait else DEFAULT_TIMEOUT
        code, output = _send_request(url, payload, timeout=timeout, auth_token=auth_token)
        if code == 0:
            if not args.no_wait:
                vcode, vout = _validate_blocking_response(output)
                if vcode != 0:
                    print(vout, file=sys.stderr)
                    return 1
            print(output)
            return 0
        if code != 2 or attempt >= max_retries:
            print(output, file=sys.stderr)
            return 1
        wait = 10
        print(f"连接失败，{wait}秒后重试 ({attempt + 1}/{max_retries})...", file=sys.stderr)
        import time
        time.sleep(wait)

    return 1


if __name__ == "__main__":
    sys.exit(main())
