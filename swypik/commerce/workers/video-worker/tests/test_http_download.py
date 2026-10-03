"""Public media downloads cannot reach private hosts via redirects or DNS changes."""
import contextlib
import io
import socket

import pytest

from video_worker import io_helpers
from video_worker.errors import PermanentJobError, classify_error


def address(ip):
    return (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"])
def test_non_public_addresses_are_rejected(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: [address(ip)])
    with pytest.raises(PermanentJobError, match="non-public") as error:
        io_helpers._public_target("https://media.example.test/clip")
    assert classify_error(error.value) == ("invalid_source", False)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "https://user:password@example.test/clip", "https://example.test\\@localhost/clip", " https://example.test/clip", "https://example.test/clip\r\nx", "https://[fe80::1%eth0]/clip", "https://example.test:wrong/clip"])
def test_unsafe_urls_are_rejected_before_dns(monkeypatch, url):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: pytest.fail("unsafe URL reached DNS"))
    with pytest.raises(PermanentJobError):
        io_helpers._public_target(url)


def test_mixed_public_private_dns_results_are_rejected(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: [address("93.184.216.34"), address("10.0.0.1")])
    with pytest.raises(PermanentJobError):
        io_helpers._public_target("https://media.example.test/clip")


def test_connection_uses_resolved_sockaddr_and_original_tls_hostname(monkeypatch):
    resolutions, connections, requests, tls_hosts = [], [], [], []

    def resolve(host, port, **_kwargs):
        resolutions.append((host, port))
        return [address("93.184.216.34")]

    class Socket:
        def settimeout(self, timeout):
            assert timeout == 12

        def connect(self, sockaddr):
            connections.append(sockaddr)

        def close(self):
            pass

    class Context:
        def set_alpn_protocols(self, protocols):
            assert protocols == ["http/1.1"]

        def wrap_socket(self, raw, *, server_hostname):
            tls_hosts.append(server_hostname)
            return raw

    class Connection:
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("media.example.test", 443, 12)

        def request(self, method, target, headers):
            requests.append((method, target))

        def getresponse(self):
            return io.BytesIO(b"media")

        def close(self):
            pass

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket, "socket", lambda *_args: Socket())
    monkeypatch.setattr(io_helpers.ssl, "create_default_context", Context)
    monkeypatch.setattr(io_helpers.http.client, "HTTPConnection", Connection)
    with io_helpers._open_public_http("https://media.example.test/video?signature=private", 12) as response:
        assert response.read() == b"media"
    assert resolutions == [("media.example.test", 443)]
    assert connections == [("93.184.216.34", 443)]
    assert tls_hosts == ["media.example.test"]
    assert requests == [("GET", "/video?signature=private")]


class Response(io.BytesIO):
    def __init__(self, body=b"x" * 2048, *, status=200, location=None):
        super().__init__(body)
        self.status = status
        self.location = location

    def getheader(self, name):
        return self.location if name == "Location" else None


def test_redirect_to_private_host_is_validated_before_connect(tmp_path, monkeypatch):
    opens = []
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, *_a, **_k: [address("127.0.0.1" if host == "localhost" else "93.184.216.34")])

    @contextlib.contextmanager
    def opener(url, _timeout):
        io_helpers._public_target(url)
        opens.append(url)
        yield Response(status=302, location="http://localhost/secrets")

    monkeypatch.setattr(io_helpers, "_open_public_http", opener)
    dest = tmp_path / "clip.mp4"
    with pytest.raises(PermanentJobError, match="non-public"):
        io_helpers.download_http("https://media.example.test/video", dest)
    assert opens == ["https://media.example.test/video"]
    assert not dest.exists()


def test_relative_redirect_downloads_public_media(tmp_path, monkeypatch):
    opens = []
    responses = [Response(status=307, location="/final.mp4"), Response()]

    def opener(url, _timeout):
        opens.append(url)
        return contextlib.closing(responses.pop(0))

    monkeypatch.setattr(io_helpers, "_open_public_http", opener)
    dest = tmp_path / "clip.mp4"
    io_helpers.download_http("https://media.example.test/video", dest)
    assert opens == ["https://media.example.test/video", "https://media.example.test/final.mp4"]
    assert dest.read_bytes() == b"x" * 2048


def test_redirect_loop_is_bounded(tmp_path, monkeypatch):
    opens = []

    def opener(url, _timeout):
        opens.append(url)
        return contextlib.closing(Response(status=302, location="/loop"))

    monkeypatch.setattr(io_helpers, "_open_public_http", opener)
    with pytest.raises(PermanentJobError, match="limit"):
        io_helpers.download_http("https://media.example.test/video", tmp_path / "clip.mp4")
    assert len(opens) == 6


@pytest.mark.parametrize("failure", [TimeoutError("network timeout"), OSError("connection reset")])
def test_read_failure_removes_partial_file(tmp_path, monkeypatch, failure):
    class BrokenResponse(Response):
        def read(self, _size):
            if self.tell() == 0:
                return super().read(1024)
            raise failure

    monkeypatch.setattr(io_helpers, "_open_public_http", lambda *_args: contextlib.closing(BrokenResponse()))
    dest = tmp_path / "clip.mp4"
    with pytest.raises(type(failure)):
        io_helpers.download_http("https://media.example.test/video", dest)
    assert not dest.exists()


def test_tiny_response_is_removed_and_errors_do_not_include_signed_url(tmp_path, monkeypatch):
    monkeypatch.setattr(io_helpers, "_open_public_http", lambda *_args: contextlib.closing(Response(b"oops")))
    dest = tmp_path / "clip.mp4"
    with pytest.raises(PermanentJobError) as error:
        io_helpers.download_http("https://media.example.test/video?token=secret", dest)
    assert "secret" not in str(error.value)
    assert not dest.exists()
