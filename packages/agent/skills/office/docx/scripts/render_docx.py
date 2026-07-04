"""Render a DOCX file to per-page PNG images for visual QA.

This is the canonical renderer for the docx skill's Visual Verification Gate.
It chains LibreOffice (docx -> PDF) and Poppler (PDF -> PNG) into a single
command, with clear error reporting when external dependencies are missing.

Usage:
    python scripts/render_docx.py input.docx --out-dir pages/ [--dpi 150] [--emit-pdf]
    python scripts/render_docx.py input.docx --out-dir pages/ --verbose

Exit codes:
    0 — success, PNG files written to --out-dir
    1 — missing dependency (LibreOffice or Poppler not found)
    2 — conversion failure (soffice or pdftoppm returned non-zero)
    3 — invalid input file

Output:
    pages/page-1.png, pages/page-2.png, ...
    (optional) pages/<input-stem>.pdf when --emit-pdf is passed
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Make the sibling `office` package importable regardless of cwd.
# render_docx.py lives in scripts/, office/ lives in scripts/office/.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from office.soffice import run_soffice  # noqa: E402


def find_executable(names: list[str]) -> str | None:
    """Return the first executable found on PATH, else None."""
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def find_soffice() -> str | None:
    """Find LibreOffice executable across platforms."""
    # On PATH first (covers most Linux/macOS installs and Windows if configured)
    found = find_executable(["soffice", "libreoffice", "soffice.exe"])
    if found:
        return found
    # Common Windows install locations
    for prog_dir in [
        Path(_get_program_files()) / "LibreOffice" / "program" / "soffice.exe",
        Path(_get_program_files(x86=True)) / "LibreOffice" / "program" / "soffice.exe",
    ]:
        if prog_dir.exists():
            return str(prog_dir)
    # Common macOS location
    mac_path = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    if mac_path.exists():
        return str(mac_path)
    return None


def _get_program_files(x86: bool = False) -> str:
    env_var = "ProgramFiles(x86)" if x86 else "ProgramFiles"
    return _safe_env(env_var) or r"C:\Program Files"


def _safe_env(key: str) -> str:
    val = __import__("os").environ.get(key)
    return val or ""


def find_pdftoppm() -> str | None:
    """Find Poppler pdftoppm executable."""
    found = find_executable(["pdftoppm", "pdftoppm.exe"])
    if found:
        return found
    # Common Windows Poppler install (e.g. via conda or manual install)
    for base in [
        Path(_get_program_files()) / "poppler" / "Library" / "bin" / "pdftoppm.exe",
        Path(_get_program_files()) / "poppler" / "bin" / "pdftoppm.exe",
    ]:
        if base.exists():
            return str(base)
    return None


def render_docx(
    input_file: str,
    out_dir: str,
    dpi: int = 150,
    emit_pdf: bool = False,
    verbose: bool = False,
) -> tuple[int, str]:
    """Render a DOCX to per-page PNG images.

    Returns (exit_code, message).
    """
    input_path = Path(input_file).resolve()
    if not input_path.is_file():
        return 3, f"Error: input file not found: {input_path}"
    if input_path.suffix.lower() != ".docx":
        return 3, f"Error: input must be a .docx file, got {input_path.suffix}"

    out_path = Path(out_dir).resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    # --- Dependency checks ---
    soffice = find_soffice()
    if not soffice:
        return 1, (
            "Error: LibreOffice (soffice) not found.\n"
            "  Install LibreOffice to enable visual QA:\n"
            "    Windows: https://www.libreoffice.org/download/\n"
            "    macOS:  brew install --cask libreoffice\n"
            "    Linux:  sudo apt install libreoffice (or distro equivalent)\n"
            "  Without LibreOffice, fall back to duya DocxParser for weak\n"
            "  structural verification and report the limitation."
        )

    pdftoppm = find_pdftoppm()
    if not pdftoppm:
        return 1, (
            "Error: Poppler pdftoppm not found.\n"
            "  Install Poppler to enable PNG rendering:\n"
            "    Windows: conda install -c conda-forge poppler  (or download binary)\n"
            "    macOS:  brew install poppler\n"
            "    Linux:  sudo apt install poppler-utils (or distro equivalent)\n"
            "  Without Poppler, the PDF can still be produced but PNG visual QA\n"
            "  cannot run."
        )

    # --- Step 1: docx -> PDF via LibreOffice ---
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        # soffice writes <stem>.pdf into --outdir
        soffice_cmd = [
            "--headless",
            "--convert-to", "pdf",
            "--outdir", str(tmp_dir),
            str(input_path),
        ]
        if verbose:
            print(f"[render_docx] soffice {' '.join(soffice_cmd)}", file=sys.stderr)
        result = run_soffice(soffice_cmd, capture_output=not verbose)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
            return 2, (
                f"Error: soffice failed (exit {result.returncode}).\n"
                f"  {stderr.strip()}\n"
                "  If LibreOffice profile is corrupt, try removing the user profile\n"
                "  directory and re-running."
            )

        pdf_path = tmp_dir / (input_path.stem + ".pdf")
        if not pdf_path.exists():
            return 2, f"Error: soffice did not produce expected PDF: {pdf_path}"

        # Move PDF to out-dir if --emit-pdf, else use it in place
        final_pdf = out_path / (input_path.stem + ".pdf")
        shutil.copy2(pdf_path, final_pdf)
        if verbose:
            print(f"[render_docx] PDF written: {final_pdf}", file=sys.stderr)

        # --- Step 2: PDF -> PNG via pdftoppm ---
        # pdftoppm -jpeg|-png -r <dpi> input.pdf <prefix>
        prefix = out_path / "page"
        png_cmd = [
            pdftoppm,
            "-png",        # PNG output (preferred for QA over JPEG)
            "-r", str(dpi),
            str(final_pdf),
            str(prefix),
        ]
        if verbose:
            print(f"[render_docx] pdftoppm {' '.join(png_cmd)}", file=sys.stderr)
        result = subprocess.run(png_cmd, capture_output=not verbose)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
            return 2, f"Error: pdftoppm failed (exit {result.returncode}).\n  {stderr.strip()}"

        # pdftoppm names files as page-1.png, page-2.png, ... (or page-01.png
        # depending on page count). Collect and report.
        png_files = sorted(out_path.glob("page-*.png"))
        if not png_files:
            return 2, f"Error: pdftoppm did not produce PNG files in {out_path}"

        # Remove the PDF if --emit-pdf was not requested (QA-only)
        if not emit_pdf:
            final_pdf.unlink()
            if verbose:
                print(f"[render_docx] removed intermediate PDF (use --emit-pdf to keep)", file=sys.stderr)

        return 0, (
            f"Rendered {len(png_files)} page(s) to {out_path}\n"
            + "\n".join(f"  {p.name}" for p in png_files)
            + (f"\nPDF kept at {final_pdf}" if emit_pdf else "")
        )


def main():
    parser = argparse.ArgumentParser(
        description="Render a DOCX to per-page PNG images for visual QA."
    )
    parser.add_argument("input_file", help="Path to .docx file")
    parser.add_argument(
        "--out-dir",
        required=True,
        help="Output directory for PNG files (created if missing)",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="Render resolution (default: 150)",
    )
    parser.add_argument(
        "--emit-pdf",
        action="store_true",
        help="Also keep the intermediate PDF in --out-dir",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print soffice/pdftoppm commands and stderr",
    )
    args = parser.parse_args()

    code, message = render_docx(
        args.input_file,
        args.out_dir,
        dpi=args.dpi,
        emit_pdf=args.emit_pdf,
        verbose=args.verbose,
    )
    print(message)
    sys.exit(code)


if __name__ == "__main__":
    main()
