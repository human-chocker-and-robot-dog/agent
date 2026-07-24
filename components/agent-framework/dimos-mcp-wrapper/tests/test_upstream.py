from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from dimos_mcp_wrapper.upstream import HttpMcpToolClient, UpstreamMcpError


class RedirectingHandler(BaseHTTPRequestHandler):
    request_count = 0

    def do_POST(self) -> None:
        type(self).request_count += 1
        self.send_response(307)
        self.send_header("Location", "/different-endpoint")
        self.end_headers()

    def do_GET(self) -> None:
        type(self).request_count += 1
        self.send_response(500)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


class HttpMcpToolClientTests(unittest.TestCase):
    def test_tool_call_posts_standard_json_rpc_and_returns_upstream_text(self) -> None:
        requests: list[tuple[str, dict[str, object], float]] = []

        def post_json(url: str, body: dict[str, object], timeout_s: float) -> dict[str, object]:
            requests.append((url, body, timeout_s))
            return {
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": '{"status":"started"}',
                        }
                    ]
                },
            }

        client = HttpMcpToolClient(
            "http://127.0.0.1:9990/mcp",
            timeout_s=7.5,
            post_json=post_json,
        )

        result = client.call_tool(
            "move_forward",
            {"speed_mps": 0.1, "duration_s": 0.5},
        )

        self.assertEqual(result, '{"status":"started"}')
        self.assertEqual(
            requests,
            [
                (
                    "http://127.0.0.1:9990/mcp",
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "move_forward",
                            "arguments": {"speed_mps": 0.1, "duration_s": 0.5},
                        },
                    },
                    7.5,
                )
            ],
        )

    def test_tool_call_rejects_redirects_without_a_second_request(self) -> None:
        RedirectingHandler.request_count = 0
        server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectingHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(server.server_address[1])
            client = HttpMcpToolClient(
                f"http://127.0.0.1:{port}/mcp",
                timeout_s=1.0,
            )

            with self.assertRaises(UpstreamMcpError):
                client.call_tool("stop_all", {})

            self.assertEqual(RedirectingHandler.request_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1.0)

    def test_tool_call_rejects_structured_dog_tool_error(self) -> None:
        result_text = (
            '{"status":"error","failed_components":["navigation"],'
            '"results":{"navigation":{"status":"error","error":"navigation refused to stop"}}}'
        )
        client = HttpMcpToolClient(
            "http://127.0.0.1:9990/mcp",
            timeout_s=1.0,
            post_json=lambda _url, _body, _timeout: {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": result_text,
                        }
                    ]
                },
            },
        )

        with self.assertRaises(UpstreamMcpError) as captured:
            client.call_tool("move_forward", {"speed_mps": 0.1, "duration_s": 1.0})
        self.assertEqual(str(captured.exception), result_text)

    def test_tool_call_rejects_dimos_wrapped_exception(self) -> None:
        client = HttpMcpToolClient(
            "http://127.0.0.1:9990/mcp",
            timeout_s=1.0,
            post_json=lambda _url, _body, _timeout: {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": "Error running tool 'stop_all': transport failed",
                        }
                    ]
                },
            },
        )

        with self.assertRaisesRegex(UpstreamMcpError, "transport failed"):
            client.call_tool("stop_all", {})
