"""Render task Markdown as HTML, with raw HTML treated as text."""

import re
from html import escape
from string import punctuation
from urllib.parse import urlsplit


FENCE = re.compile(r"^ {0,3}(?P<marker>`{3,}|~{3,})(?P<info>.*)$")
HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)")
RULE = re.compile(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
QUOTE = re.compile(r"^ {0,3}>[ \t]?(.*)$")
LIST_ITEM = re.compile(r"^(?P<indent> {0,3})(?:(?P<number>[0-9]{1,9})[.)]|[-+*])[ \t]+(?P<body>.*)$")
TABLE_TOKEN = re.compile(r"\\.|\|")
TABLE_DELIMITER = re.compile(r":?-+:?")
BLOCK_START = (FENCE, HEADING, RULE, QUOTE, LIST_ITEM)
INLINE = re.compile(
    rf"\\(?P<escaped>[{re.escape(punctuation)}])"
    r"|(?<!`)(?P<ticks>`+)(?!`)(?P<code>.*?)(?<!`)(?P=ticks)(?!`)"
    r"|\[(?P<label>(?:\\.|[^\\\[\]])+)\]\((?P<url><[^\s<>]+>|(?:[^\s()<>\\]|\([^\s()<>\\]*\))+)\)"
    r"|(?P<marker>\*+|_+|~{2})"
)


def safe_href(destination):
    destination = destination.removeprefix("<").removesuffix(">")
    if destination.startswith("//") or "\\" in destination:
        return None
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in destination):
        return None
    try:
        url = urlsplit(destination)
    except ValueError:
        return None
    if not url.scheme or (url.scheme in ("http", "https") and url.netloc) or (
        url.scheme == "mailto" and url.path
    ):
        return escape(destination, quote=True)
    return None


def render_inline(source):
    parts = []
    openers = []
    cursor = 0
    for token in INLINE.finditer(source):
        parts.append(escape(source[cursor:token.start()]))
        cursor = token.end()
        if token["escaped"] is not None:
            parts.append(escape(token["escaped"]))
        elif token["code"] is not None:
            code = token["code"]
            if code.startswith(" ") and code.endswith(" ") and code.strip(" "):
                code = code[1:-1]
            parts.append(f"<code>{escape(code)}</code>")
        elif token["label"] is not None:
            href = safe_href(token["url"])
            if href is None:
                parts.append(escape(token[0]))
            else:
                parts.append(f'<a href="{href}">{render_inline(token["label"])}</a>')
        else:
            marker = token["marker"]
            symbol = marker[0]
            remaining = len(marker)
            before = source[token.start() - 1] if token.start() else " "
            after = source[cursor] if cursor < len(source) else " "
            inside_word = symbol == "_" and before.isalnum() and after.isalnum()
            if not inside_word and not before.isspace():
                while remaining:
                    opener = next((i for i in range(len(openers) - 1, -1, -1) if openers[i][0] == symbol), None)
                    if opener is None:
                        break
                    _, position, count = openers[opener]
                    used = min(remaining, count, 2)
                    tag = "del" if symbol == "~" else "strong" if used == 2 else "em"
                    remaining -= used
                    new_count = count - used
                    parts[position] = symbol * new_count + f"<{tag}>" + parts[position][count:]
                    parts.append(f"</{tag}>")
                    del openers[opener:]
                    if new_count:
                        openers.append((symbol, position, new_count))
            if remaining:
                if not inside_word and not after.isspace():
                    openers.append((symbol, len(parts), remaining))
                parts.append(symbol * remaining)
    parts.append(escape(source[cursor:]))
    return "".join(parts)


def render_list(lines, index, first, depth):
    ordered = first["number"] is not None
    tag = "ol" if ordered else "ul"
    start = int(first["number"]) if ordered else 1
    items = [f'<ol start="{start}">' if start != 1 else f"<{tag}>"]
    while index < len(lines):
        item = LIST_ITEM.match(lines[index])
        if not item or item["indent"] != first["indent"] or (item["number"] is not None) != ordered:
            break
        body = [item["body"]]
        indent = item.start("body")
        index += 1
        while index < len(lines):
            line = lines[index]
            if not line.strip():
                body.append("")
            elif len(line) - len(line.lstrip(" ")) >= indent:
                body.append(line[indent:])
            else:
                break
            index += 1
        items.append(f"<li>{render_blocks(body, depth + 1)}</li>")
    items.append(f"</{tag}>")
    return "\n".join(items), index


def table_row(line):
    if line.startswith(("    ", "\t")):
        return None
    line = line.strip()
    cells = []
    start = 0
    for token in TABLE_TOKEN.finditer(line):
        if token[0] == "|":
            cells.append(line[start:token.start()])
            start = token.end()
    if not cells:
        return None
    if line.startswith("|"):
        cells = cells[1:]
    if start < len(line):
        cells.append(line[start:])
    return [cell.strip() for cell in cells] or None


def table_heading(lines, index):
    if index + 1 >= len(lines) or not (header := table_row(lines[index])):
        return None
    delimiters = table_row(lines[index + 1])
    if not delimiters or len(header) != len(delimiters) or not all(map(TABLE_DELIMITER.fullmatch, delimiters)):
        return None
    return header, delimiters


def render_table(lines, index, header, delimiters):
    alignments = []
    for delimiter in delimiters:
        if delimiter.startswith(":"):
            alignments.append("center" if delimiter.endswith(":") else "left")
        else:
            alignments.append("right" if delimiter.endswith(":") else "")

    def render_row(cells, tag):
        items = []
        for cell, alignment in zip(cells, alignments):
            attrs = ' scope="col"' if tag == "th" else ""
            if alignment:
                attrs += f' class="align-{alignment}"'
            # Pipes are escaped at the table level, even inside inline code.
            items.append(f"<{tag}{attrs}>{render_inline(cell.replace(r'\|', '|'))}</{tag}>")
        missing = len(header) - len(items)
        if missing:
            attrs = f' colspan="{missing}"' if missing > 1 else ""
            items.append(f"<td{attrs}></td>")
        return "<tr>" + "".join(items) + "</tr>"

    rows = ["<table><thead>", render_row(header, "th"), "</thead>"]
    index += 2
    body = []
    while index < len(lines) and not any(pattern.match(lines[index]) for pattern in BLOCK_START):
        cells = table_row(lines[index])
        if not cells:
            break
        body.append(render_row(cells, "td"))
        index += 1
    if body:
        rows.extend(["<tbody>", *body, "</tbody>"])
    rows.append("</table>")
    return '<div class="markdown-table">' + "\n".join(rows) + "</div>", index


def render_blocks(lines, depth=0):
    if depth >= 16:
        return "<p>" + "<br>\n".join(escape(line) for line in lines) + "</p>"
    blocks = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
        elif (fence := FENCE.match(line)) and (fence["marker"][0] != "`" or "`" not in fence["info"]):
            marker = fence["marker"]
            code = []
            index += 1
            while index < len(lines):
                end = lines[index].strip()
                if end.startswith(marker) and not end.strip(marker[0]):
                    index += 1
                    break
                code.append(lines[index])
                index += 1
            contents = "".join(line + "\n" for line in code)
            blocks.append(f"<pre><code>{escape(contents)}</code></pre>")
        elif heading := HEADING.match(line):
            level = len(heading[1])
            title = re.sub(r"[ \t]+#+[ \t]*$", "", heading[2] or "").strip()
            blocks.append(f"<h{level}>{render_inline(title)}</h{level}>")
            index += 1
        elif RULE.match(line):
            blocks.append("<hr>")
            index += 1
        elif quote := QUOTE.match(line):
            quoted = []
            while quote:
                quoted.append(quote[1])
                index += 1
                quote = QUOTE.match(lines[index]) if index < len(lines) else None
            blocks.append(f"<blockquote>{render_blocks(quoted, depth + 1)}</blockquote>")
        elif item := LIST_ITEM.match(line):
            rendered, index = render_list(lines, index, item, depth)
            blocks.append(rendered)
        elif table := table_heading(lines, index):
            rendered, index = render_table(lines, index, *table)
            blocks.append(rendered)
        else:
            paragraph = [render_inline(line)]
            index += 1
            while index < len(lines):
                line = lines[index]
                if (not line.strip() or any(pattern.match(line) for pattern in BLOCK_START)
                        or table_heading(lines, index)):
                    break
                paragraph.append(render_inline(line))
                index += 1
            blocks.append("<p>" + "<br>\n".join(paragraph) + "</p>")
    return "\n".join(blocks)


def render_markdown(source):
    return render_blocks(source.splitlines())
