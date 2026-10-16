"""Truncation and pages (spec 5.5, 5.6)."""

MARKER = "[…]"


def words_in(paragraph: str) -> int:
    """Words of a paragraph; the truncation marker is not a word."""
    return 0 if paragraph == MARKER else len(paragraph.split())


def _take(paragraphs: list[str], count: int) -> list[str]:
    """The first `count` words of the paragraphs, keeping the breaks that fall inside them."""
    taken: list[str] = []
    for paragraph in paragraphs:
        if count <= 0:
            break
        words = paragraph.split()
        taken.append(" ".join(words[:count]))
        count -= len(words)
    return taken


def truncate(paragraphs: list[str], max_words: int) -> tuple[list[str], bool]:
    """Keep the first and last `max_words // 2` words around a `[…]` paragraph when over the limit."""
    if sum(words_in(p) for p in paragraphs) <= max_words:
        return paragraphs, False
    half = max_words // 2
    head = _take(paragraphs, half)
    tail = [
        _reverse(p) for p in _take([_reverse(p) for p in reversed(paragraphs)], half)
    ]
    return head + [MARKER] + tail[::-1], True


def _reverse(paragraph: str) -> str:
    return " ".join(reversed(paragraph.split()))


def paginate(paragraphs: list[str], page_words: int) -> list[str]:
    """Group whole paragraphs into pages of at most `page_words` words; cut a longer paragraph."""
    pages: list[list[str]] = []
    current: list[str] = []
    size = 0
    for paragraph in paragraphs:
        count = words_in(paragraph)
        if count > page_words:
            if current:
                pages.append(current)
            words = paragraph.split()
            pages.extend(
                [" ".join(words[i : i + page_words])]
                for i in range(0, len(words), page_words)
            )
            current, size = [], 0
        elif size + count <= page_words:
            current.append(paragraph)
            size += count
        else:
            pages.append(current)
            current, size = [paragraph], count
    if current:
        pages.append(current)
    return ["\n\n".join(page) for page in pages]
