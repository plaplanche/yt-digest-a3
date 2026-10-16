from pathlib import Path

from yt_digest_node.clean import Cue, clean_cues, parse_vtt

FIXTURES = Path(__file__).parent / "fixtures" / "vtt"


def load(name: str) -> list[Cue]:
    return parse_vtt((FIXTURES / name).read_text(encoding="utf-8"))


def cue(start: float, end: float, *lines: str) -> Cue:
    return Cue(start, end, lines)


def test_parse_ignores_header_blocks_and_settings() -> None:
    cues = load("manual.vtt")
    assert [(c.start, c.end) for c in cues] == [
        (1.0, 3.0),
        (3.5, 5.0),
        (7.0, 9.0),
        (10.9, 12.0),
        (14.0, 16.0),
    ]
    assert cues[0].lines == ("Bonjour à tous,",)


def test_parse_hours_and_crlf() -> None:
    cues = parse_vtt("WEBVTT\r\n\r\n01:02:03.250 --> 01:02:04.000\r\nhi\r\n")
    assert cues == [Cue(3723.25, 3724.0, ("hi",))]


def test_manual_track_paragraphs() -> None:
    assert clean_cues(load("manual.vtt"), []) == [
        "Bonjour à tous, bienvenue dans cette vidéo.",
        "Premier sujet du jour. Suite sans pause.",
        "Nouveau paragraphe.",
    ]


def test_auto_track_rolling_duplicates_and_inline_tags() -> None:
    assert clean_cues(load("auto.vtt"), []) == [
        "hello everyone and welcome to the channel today we talk"
    ]


def test_annotations_entities_and_tags() -> None:
    assert clean_cues(load("annotated.vtt"), []) == [
        'Tom & Jerry are here 5 < 6 > 4 "quoted"',
        "Final words.",
    ]


def test_gap_of_two_seconds_starts_a_paragraph() -> None:
    assert clean_cues([cue(0, 1, "a"), cue(3, 4, "b")], []) == ["a", "b"]
    assert clean_cues([cue(1.5, 3.2, "a"), cue(5.2, 6, "b")], []) == ["a", "b"]


def test_gap_of_1_9_seconds_does_not() -> None:
    assert clean_cues([cue(0, 1, "a"), cue(2.9, 4, "b")], []) == ["a b"]
    assert clean_cues([cue(0, 1.5, "a"), cue(3.4, 4, "b")], []) == ["a b"]


def test_gap_is_measured_from_the_previous_kept_cue() -> None:
    cues = [cue(0, 1, "a"), cue(1.5, 2, "[Musique]"), cue(3.5, 4, "b")]
    assert clean_cues(cues, []) == ["a", "b"]


def test_duplicate_of_previous_kept_line_only() -> None:
    cues = [cue(0, 1, "a", "b"), cue(1, 2, "b", "a"), cue(2, 3, "a")]
    assert clean_cues(cues, []) == ["a b a"]


def test_empty_and_whitespace_lines_dropped() -> None:
    assert clean_cues([cue(0, 1, "  ", "<c> </c>", "x  y")], []) == ["x y"]


def test_no_cues() -> None:
    assert clean_cues([], []) == []
    assert parse_vtt("WEBVTT\n") == []


def test_segments_drop_cues_by_midpoint() -> None:
    cues = [cue(0, 2, "a"), cue(2, 4, "b"), cue(4, 6, "c")]
    # midpoints 1, 3, 5: start inclusive, end exclusive
    assert clean_cues(cues, [(3.0, 5.0)]) == ["a", "c"]
    assert clean_cues(cues, [(1.0, 3.0)]) == ["b c"]
    assert clean_cues(cues, [(0.0, 1.0), (5.0, 9.0)]) == ["a b"]
