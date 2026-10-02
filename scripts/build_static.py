"""Builds a single-file, server-less version of the dashboard (the twin runs in the browser).

Outputs:
  docs/demo/index.html      - full HTML page (open locally or host on GitHub Pages)
  docs/demo/artifact.html   - same page without the document skeleton (for embedding)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FE = ROOT / "frontend"
OUT = ROOT / "docs" / "demo"
CHART = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"


def main():
    data = {
        "config": json.loads((ROOT / "backend/config/plant.json").read_text(encoding="utf-8")),
        "model": json.loads((FE / "model_lite.json").read_text()),
        "effect": json.loads((ROOT / "backend/models/effect.json").read_text()),
    }
    html = (FE / "index.html").read_text(encoding="utf-8")
    body = html.split("<body>", 1)[1].split("<script src=\"app.js\"></script>", 1)[0]
    icon = html.split('<link rel="icon"', 1)[1].split(">", 1)[0]
    inline = lambda name: (FE / name).read_text(encoding="utf-8").replace("</script", "<\\/script")  # noqa: E731
    content = (
        "<title>ALLUR Digital Twin</title>\n"
        f'<link rel="icon"{icon}>\n'
        f"<style>\n{(FE / 'style.css').read_text(encoding='utf-8')}\n</style>\n"
        f'<script src="{CHART}"></script>\n'
        + body
        + f"<script>window.LOCAL_DATA = {json.dumps(data, ensure_ascii=False)};</script>\n"
        + "".join(f"<script>\n{inline(n)}\n</script>\n" for n in ("i18n.js", "engine.js", "app.js"))
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "artifact.html").write_text(content, encoding="utf-8")
    page = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            + content.replace(body, "") + "</head>\n<body>\n" + body + "</body>\n</html>\n")
    # keep scripts after the body markup so they find their elements
    head, scripts = page.split("<script>window.LOCAL_DATA", 1)
    scripts = "<script>window.LOCAL_DATA" + scripts
    scripts, tail = scripts.split("</head>", 1)
    page = head + "</head>" + tail.replace("</body>", scripts + "</body>")
    (OUT / "index.html").write_text(page, encoding="utf-8")
    print("wrote", OUT / "index.html", OUT / "artifact.html")


if __name__ == "__main__":
    main()
