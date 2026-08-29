#!/usr/bin/env python3
"""
extract_article.py — extract the main article/body text from a web page.

Usage:
    python3 extract_article.py <url>

Reads the URL, fetches it with requests, parses with BeautifulSoup, and prints a
JSON object: { url, title, text, charCount } (or { error: ... } on failure).
"""
import json
import sys

import requests
from bs4 import BeautifulSoup


def extract(url: str) -> dict:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=20)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to fetch page: {e}"}

    soup = BeautifulSoup(resp.text, "html.parser")

    # Title
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    # Remove non-content elements
    for tag in soup(["script", "style", "noscript", "iframe", "nav", "footer",
                     "header", "aside", "form", "button", "svg", "canvas"]):
        tag.decompose()

    # Prefer <article>, then <main>, then <body>
    container = soup.find("article") or soup.find("main") or soup.body or soup

    # Grab the most text-dense block if the container is huge (e.g. whole body)
    text = container.get_text(separator="\n", strip=True)

    # Collapse blank lines
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    text = "\n".join(lines)

    if not text:
        return {"error": "No readable text could be extracted from the page."}

    return {
        "url": url,
        "title": title,
        "text": text,
        "charCount": len(text),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided."}))
        sys.exit(1)
    print(json.dumps(extract(sys.argv[1])))
