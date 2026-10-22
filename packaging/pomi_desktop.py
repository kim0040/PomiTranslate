"""PyInstaller entry for the PomiTranslate desktop/sidecar binary."""

from mwt.desktop_entry import main, prepare_stdio

if __name__ == "__main__":
    # UTF-8 on every standard stream before anything else can print, whatever the Windows
    # ANSI code page is. main() then moves the JSONL protocol onto its own copy of stdout.
    prepare_stdio()
    main()
