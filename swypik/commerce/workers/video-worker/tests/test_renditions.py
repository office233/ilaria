from video_worker.config import Variant, default_ladder
from video_worker.renditions import compute_renditions, orientation

LADDER = default_ladder()


def _dims(variants):
    return [(v.name, v.width, v.height) for v in variants]


def test_vertical_1080x1920_is_true_9_16_ladder():
    variants = compute_renditions(1080, 1920, LADDER)

    assert _dims(variants) == [
        ("360p", 360, 640),
        ("540p", 540, 960),
        ("720p", 720, 1280),
        ("1080p", 1080, 1920),
    ]
    assert [v.bitrate for v in variants] == ["800k", "1400k", "2800k", "5000k"]


def test_vertical_720x1280_does_not_upscale():
    assert _dims(compute_renditions(720, 1280, LADDER)) == [
        ("360p", 360, 640),
        ("540p", 540, 960),
        ("720p", 720, 1280),
    ]


def test_landscape_1920x1080():
    assert _dims(compute_renditions(1920, 1080, LADDER)) == [
        ("360p", 640, 360),
        ("540p", 960, 540),
        ("720p", 1280, 720),
        ("1080p", 1920, 1080),
    ]


def test_vertical_3_4_keeps_aspect():
    variants = compute_renditions(1080, 1440, LADDER)

    assert _dims(variants) == [
        ("360p", 360, 480),
        ("540p", 540, 720),
        ("720p", 720, 960),
        ("1080p", 1080, 1440),
    ]
    for v in variants:
        assert v.width * 4 == v.height * 3


def test_tiny_source_with_odd_dims_gets_single_even_rendition():
    variants = compute_renditions(321, 571, LADDER)

    assert variants == [Variant(name="320p", width=320, height=570, bitrate="800k")]


def test_tiny_320x570():
    assert compute_renditions(320, 570, LADDER) == [
        Variant(name="320p", width=320, height=570, bitrate="800k")
    ]


def test_square_source():
    assert _dims(compute_renditions(800, 800, LADDER)) == [
        ("360p", 360, 360),
        ("540p", 540, 540),
        ("720p", 720, 720),
    ]


def test_all_dims_are_even():
    for w, h in [(1080, 1920), (1179, 2556), (886, 1920), (1366, 768), (719, 1281)]:
        for v in compute_renditions(w, h, LADDER):
            assert v.width % 2 == 0 and v.height % 2 == 0


def test_orientation():
    assert orientation(1080, 1920) == "vertical"
    assert orientation(1920, 1080) == "landscape"
    assert orientation(500, 500) == "square"
