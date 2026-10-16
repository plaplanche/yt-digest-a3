from yt_digest_node.paginate import MARKER, paginate, truncate, words_in


def words(count: int, start: int = 1) -> str:
    return " ".join(f"w{n}" for n in range(start, start + count))


def test_under_the_limit_is_untouched() -> None:
    paragraphs = [words(4), words(6, 5)]
    assert truncate(paragraphs, 10) == (paragraphs, False)


def test_truncation_keeps_first_and_last_words() -> None:
    result, truncated = truncate([words(25)], 10)
    assert truncated
    assert result == [words(5), MARKER, words(5, 21)]
    assert sum(words_in(p) for p in result) == 10


def test_truncation_keeps_inner_paragraph_breaks() -> None:
    paragraphs = [words(2), words(3, 3), words(10, 6), words(3, 16), words(4, 19)]
    result, truncated = truncate(paragraphs, 10)
    assert truncated
    assert result == [words(2), words(3, 3), MARKER, words(1, 18), words(4, 19)]


def test_pages_group_whole_paragraphs() -> None:
    assert paginate([words(2), words(3, 3), words(4, 6)], 5) == [
        words(2) + "\n\n" + words(3, 3),
        words(4, 6),
    ]


def test_long_paragraph_is_cut_and_order_is_kept() -> None:
    paragraphs = [words(3), words(12, 4), words(2, 16)]
    pages = paginate(paragraphs, 5)
    assert all(0 < len(page.split()) <= 5 for page in pages)
    assert " ".join(pages).split() == " ".join(paragraphs).split()
    assert pages == [words(3), words(5, 4), words(5, 9), words(2, 14), words(2, 16)]


def test_marker_is_not_counted_and_never_makes_an_empty_page() -> None:
    assert paginate([words(5), MARKER, words(5, 6)], 5) == [
        words(5) + "\n\n" + MARKER,
        words(5, 6),
    ]
    assert paginate([], 5) == []
