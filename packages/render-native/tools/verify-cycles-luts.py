"""Checks that the Cycles lookup tables in src/cycles/luts.rs equal the inline WGSL switch tables they replaced, word for word.

Usage: uv run --no-project python packages/render-native/tools/verify-cycles-luts.py [reference-commit]

The reference commit is the last one whose bsdf_glass.wgsl, bsdf_microfacet.wgsl and closure.wgsl still carry the
tables inline (default 27ab0de0, the parent of the change that moved them into luts.rs). Those tables were translated
from the Cycles kernel lookup tables, so a match proves luts.rs holds the same numbers. Prints one line per table and
ends with ALL IDENTICAL or MISMATCH; the exit code is 0 only for ALL IDENTICAL.
"""
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_REFERENCE_COMMIT = "27ab0de0"
PACKAGE_DIRECTORY = Path(__file__).resolve().parent.parent
CYCLES_DIRECTORY = PACKAGE_DIRECTORY / "src" / "cycles"
TOTAL_WORDS = 29712

# (file, function name, lanes per entry, word offset in the shared buffer, word count)
TABLES = [
    ("bsdf_glass.wgsl", "bsdf_glass_lut_e_u32", 4, 0, 16384),
    ("bsdf_glass.wgsl", "bsdf_glass_lut_eavg_u32", 4, 16384, 1024),
    ("bsdf_microfacet.wgsl", "bsdf_mf_lut_small_u32", 4, 17408, 1040),
    ("bsdf_microfacet.wgsl", "bsdf_mf_lut_thin_film_rgb", 3, 18448, 1536),
    ("bsdf_microfacet.wgsl", "bsdf_mf_lut_ior_s_u32", 4, 19984, 8192),
    ("closure.wgsl", "closure_lut_sheen_u32", 4, 28176, 1536),
]


def read_reference_source(reference_commit, file_name):
    result = subprocess.run(
        ["git", "-C", str(PACKAGE_DIRECTORY), "show", f"{reference_commit}:./src/cycles/{file_name}"],
        capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode != 0:
        sys.exit(f"Cannot read src/cycles/{file_name} at commit {reference_commit}. Pass a commit that still has the inline tables.")
    return result.stdout


def function_span(source, name):
    start = source.index(f"fn {name}(")
    end = source.index("\n}\n", start) + 3
    return start, end


def parse_inline_table(source, name, lanes, word_count):
    start, end = function_span(source, name)
    words = [0] * word_count
    outer = None
    entry_pattern = re.compile(r"case (\d+)u: \{(?: v = vec\d<u32>\(([^)]*)\); \})?")
    entries_seen = 0
    for line in source[start:end].splitlines():
        match = entry_pattern.match(line.strip())
        if not match:
            continue
        if match.group(2) is None:
            outer = int(match.group(1))
            continue
        index = outer * 64 + int(match.group(1))
        values = [int(token.strip().rstrip("u"), 16) for token in match.group(2).split(",")]
        assert len(values) == lanes, (name, index, values)
        for lane, value in enumerate(values):
            words[index * lanes + lane] = value
        entries_seen += 1
    return words, entries_seen


def read_rust_words():
    text = (CYCLES_DIRECTORY / "luts.rs").read_text(encoding="utf-8")
    body = text[text.index(f"CYCLES_LUT_WORDS: [u32; {TOTAL_WORDS}] = [") :]
    body = body[: body.index("];")]
    return [int(token, 16) for token in re.findall(r"0x[0-9a-fA-F]+", body)]


def verify(reference_commit):
    rust_words = read_rust_words()
    assert len(rust_words) == TOTAL_WORDS, len(rust_words)
    sources = {}
    all_identical = True
    for file_name, name, lanes, offset, word_count in TABLES:
        if file_name not in sources:
            sources[file_name] = read_reference_source(reference_commit, file_name)
        words, entries = parse_inline_table(sources[file_name], name, lanes, word_count)
        identical = words == rust_words[offset : offset + word_count]
        all_identical = all_identical and identical
        print(f"{name}: entries={entries} words={word_count} identical={identical}")
    print("ALL IDENTICAL" if all_identical else "MISMATCH")
    return all_identical


if __name__ == "__main__":
    commit = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REFERENCE_COMMIT
    sys.exit(0 if verify(commit) else 1)
