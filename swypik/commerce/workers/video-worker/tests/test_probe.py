import json
from pathlib import Path

import pytest

from video_worker.errors import PermanentJobError
from video_worker.models import Trim
from video_worker.probe import FfprobeProber, ProbeResult, clip_window, parse_probe_output


def _probe_json(streams, fmt=None):
    return json.dumps({"streams": streams, "format": fmt if fmt is not None else {"duration": "12.345"}})


def test_parses_landscape_with_audio():
    result = parse_probe_output(
        _probe_json(
            [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080},
                {"codec_type": "audio", "codec_name": "aac"},
            ]
        )
    )

    assert result == ProbeResult(
        duration_ms=12345, width=1920, height=1080, rotation=0, has_audio=True, video_codec="h264"
    )


def test_rotation_from_side_data_swaps_to_display_dims():
    # iPhone: stocat 1920x1080 cu matrice de rotație -90 → afișat vertical 1080x1920
    result = parse_probe_output(
        _probe_json(
            [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 1920,
                    "height": 1080,
                    "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}],
                }
            ]
        )
    )

    assert (result.width, result.height) == (1080, 1920)
    assert result.rotation == 270
    assert result.has_audio is False


def test_rotation_from_legacy_rotate_tag():
    result = parse_probe_output(
        _probe_json([{"codec_type": "video", "width": 1280, "height": 720, "tags": {"rotate": "90"}}])
    )
    assert (result.width, result.height, result.rotation) == (720, 1280, 90)


def test_rotation_180_does_not_swap():
    result = parse_probe_output(
        _probe_json([{"codec_type": "video", "width": 1280, "height": 720, "tags": {"rotate": "180"}}])
    )
    assert (result.width, result.height) == (1280, 720)


def test_duration_falls_back_to_video_stream():
    result = parse_probe_output(
        _probe_json([{"codec_type": "video", "width": 720, "height": 1280, "duration": "3.5"}], fmt={})
    )
    assert result.duration_ms == 3500


def test_no_video_stream_is_permanent_error():
    with pytest.raises(PermanentJobError) as exc:
        parse_probe_output(_probe_json([{"codec_type": "audio", "codec_name": "mp3"}]))
    assert exc.value.code == "no_video_stream"


def test_cover_art_only_counts_as_no_video_stream():
    with pytest.raises(PermanentJobError) as exc:
        parse_probe_output(
            _probe_json(
                [
                    {"codec_type": "audio"},
                    {"codec_type": "video", "width": 500, "height": 500, "disposition": {"attached_pic": 1}},
                ]
            )
        )
    assert exc.value.code == "no_video_stream"


@pytest.mark.parametrize(
    "streams,fmt",
    [
        ([{"codec_type": "video", "width": 720, "height": 1280}], {}),
        ([{"codec_type": "video", "width": 720, "height": 1280}], {"duration": "0"}),
        ([{"codec_type": "video", "width": 720, "height": 1280}], {"duration": "N/A"}),
        ([{"codec_type": "video", "width": 0, "height": 1280}], {"duration": "4"}),
        ([{"codec_type": "video"}], {"duration": "4"}),
    ],
)
def test_missing_duration_or_dims_is_invalid_source(streams, fmt):
    with pytest.raises(PermanentJobError) as exc:
        parse_probe_output(_probe_json(streams, fmt))
    assert exc.value.code == "invalid_source"


def test_garbage_output_is_invalid_source():
    with pytest.raises(PermanentJobError) as exc:
        parse_probe_output("not json")
    assert exc.value.code == "invalid_source"


def test_prober_uses_injected_runner():
    seen = []

    def runner(command):
        seen.append(command)
        return _probe_json([{"codec_type": "video", "width": 720, "height": 1280}])

    result = FfprobeProber(run_command=runner).probe(Path("clip.mp4"))

    assert seen[0][:2] == ["ffprobe", "-v"]
    assert "-show_streams" in seen[0] and "-show_format" in seen[0]
    assert seen[0][-1] == "clip.mp4"
    assert result.width == 720


PROBE = ProbeResult(duration_ms=30_000, width=1080, height=1920, rotation=0, has_audio=True, video_codec=None)


@pytest.mark.parametrize(
    "trim,expected",
    [
        (None, (0, 30_000)),
        (Trim(start_ms=5_000), (5_000, 25_000)),
        (Trim(end_ms=10_000), (0, 10_000)),
        (Trim(start_ms=5_000, end_ms=12_000), (5_000, 7_000)),
        (Trim(start_ms=5_000, end_ms=90_000), (5_000, 25_000)),  # end clampat la sursă
        (Trim(start_ms=8_000, end_ms=4_000), (8_000, 0)),  # invalid → durată 0
    ],
)
def test_clip_window(trim, expected):
    window = clip_window(PROBE, trim)
    assert (window.start_ms, window.duration_ms) == expected
