from pathlib import Path

reader_path = Path("src/components/TTSReader.jsx")
css_path = Path("src/index.css")

missing = [str(path) for path in [reader_path, css_path] if not path.exists()]
if missing:
    raise SystemExit("Run this from the PulsePoint-Standalone repo root. Missing: " + ", ".join(missing))

reader = reader_path.read_text(encoding="utf-8")
css = css_path.read_text(encoding="utf-8")

if "AI_OUTPUT_MOBILE_WIDTH_GUARD_V1" in reader or "AI_OUTPUT_MOBILE_WIDTH_GUARD_V1" in css:
    print("AI output mobile width guard v1 already appears to be applied. No changes made.")
    raise SystemExit(0)

reader_backup = reader_path.with_suffix(".jsx.bak-ai-output-mobile-width-guard-v1")
css_backup = css_path.with_suffix(".css.bak-ai-output-mobile-width-guard-v1")
reader_backup.write_text(reader, encoding="utf-8")
css_backup.write_text(css, encoding="utf-8")

# Keep the entire AI/TTS rendered output from shrinking inside flex/grid parents.
reader = reader.replace(
'''    <div className="space-y-1">
''',
'''    <div className="ai-output-width-guard space-y-1 min-w-0 w-full max-w-full">
''',
1,
)

reader = reader.replace(
'''      <div ref={copyContentRef} className="space-y-1">
''',
'''      <div ref={copyContentRef} className="ai-output-copy-surface space-y-1 min-w-0 w-full max-w-full">
''',
1,
)

reader = reader.replace(
'''               className={isActive ? "cursor-pointer" : ""}
''',
'''               className={`ai-output-paragraph-shell min-w-0 w-full max-w-full ${isActive ? "cursor-pointer" : ""}`}
''',
1,
)

reader = reader.replace(
'''               "text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 flex items-center gap-2 flex-wrap",
''',
'''               "ai-output-paragraph text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 min-w-0 w-full max-w-full block",
''',
1,
)

reader = reader.replace(
'''                    className={isHighlighted ? "bg-primary text-primary-foreground font-bold px-1 rounded inline-block transition-all" : "inline-block"}
''',
'''                    className={isHighlighted ? "bg-primary text-primary-foreground font-bold px-1 rounded inline transition-all" : "inline"}
''',
1,
)

css_append = r'''

/* AI_OUTPUT_MOBILE_WIDTH_GUARD_V1
   Prevent AI/TTS output from collapsing into a one-character-wide column inside
   nested flex/grid/card layouts, especially on mobile and with larger font modes. */
@layer components {
  .ai-output-width-guard,
  .ai-output-width-guard *,
  .ai-output-copy-surface,
  .ai-output-paragraph-shell,
  .ai-output-paragraph {
    min-width: 0;
    max-width: 100%;
  }

  .ai-output-width-guard,
  .ai-output-copy-surface,
  .ai-output-paragraph-shell,
  .ai-output-paragraph {
    width: 100%;
  }

  .ai-output-paragraph,
  .ai-output-paragraph-shell p,
  .ai-output-paragraph-shell div,
  .ai-output-copy-surface p,
  .ai-output-copy-surface li {
    overflow-wrap: normal;
    word-break: normal;
    white-space: normal;
    text-wrap: pretty;
  }

  .ai-output-paragraph-shell > *,
  .ai-output-copy-surface > * {
    min-width: 0;
    max-width: 100%;
  }

  .ai-output-paragraph span {
    white-space: normal;
    word-break: normal;
  }

  @media (max-width: 640px) {
    .ai-output-width-guard,
    .ai-output-copy-surface,
    .ai-output-paragraph-shell,
    .ai-output-paragraph {
      display: block;
      width: 100%;
    }
  }
}
'''
css = css + css_append

reader_path.write_text(reader, encoding="utf-8")
css_path.write_text(css, encoding="utf-8")

print("Applied AI output mobile width guard v1.")
print("Changed:")
print("- TTSReader output wrapper now has min-w-0/w-full/max-w-full guardrails")
print("- renderParagraph wrapper gets width guardrails")
print("- default paragraph renderer no longer uses flex/flex-wrap for normal text")
print("- CSS prevents AI output from collapsing into one-character columns")
print(f"Backups written to {reader_backup} and {css_backup}")
