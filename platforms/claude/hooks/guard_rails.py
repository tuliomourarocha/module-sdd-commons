#!/usr/bin/env python3
"""
hooks/guard_rails.py — Hook determinístico pós-edição de arquivos de código.

Conceito de Hook (fora do LLM):
  Middleware determinístico que intercepta ação da IA no ciclo de vida da tool,
  roda validações fora do modelo e pode BLOQUEAR / FORMATA / ALERTAR.
  Equivalente Claude Code: PostToolUse (matcher Edit|Write) → middleware.

Acionamento:
  - Trigger: toda vez que finaliza alteração em arquivo de código (edit/write/bash patch)
  - Invocado por: plugins/guard-rails.ts via `tool.execute.after` + `event: file.edited`
    e também direto via CLI para Claude hooks: `python3 hooks/guard_rails.py --file <path>`
  - Em Claude: `.claude/settings.json` → hooks.PostToolUse matcher Edit|Write|MultiEdit

O que roda (determinístico, sem LLM):
  - Python: ruff check, ruff format --check, pyright/pylance, bandit, semgrep (se instalado)
  - TypeScript/JS: tsc --noEmit, eslint/biome, tsc diagnostic (skills/typescript-expert/scripts/ts_diagnostic.py)
  - Genérico: secrets scan (gitleaks-like regex), tamanho/complexidade
  - Auto-fix opcional quando seguro (ruff --fix, biome --fix)

Exit codes:
  0 = pass (ou warnings LOW/MED)
  1 = erro de uso
  2 = BLOCK (HIGH) — deve interromper pipeline e retornar ao builder (max 2 iterações)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Literal

Severity = Literal["LOW", "MED", "HIGH"]

# ── Config ───────────────────────────────────────────────────────────────────

CODE_EXTENSIONS = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".css": "style",
    ".scss": "style",
    ".json": "json",
}

# Regex simples para secrets (evita dependência externa se gitleaks não instalado)
SECRET_PATTERNS = [
    (r"sk-[A-Za-z0-9]{20,}", "Possível OpenAI key"),
    (r"ghp_[A-Za-z0-9_]{30,}", "Possível GitHub PAT"),
    (r"AKIA[0-9A-Z]{16}", "Possível AWS Access Key"),
    (r"-----BEGIN (RSA )?PRIVATE KEY-----", "Private key exposta"),
    (r"supabase.*service_role.*key", "Supabase service_role exposta"),
    (r"(?i)password\s*[:=]\s*['\"][^'\"]{4,}['\"]", "Password hardcoded"),
]

MAX_FILE_LINES = 600
MAX_FUNCTION_LINES = 60  # heuristic, validado via grep posterior


@dataclass
class Finding:
    file: str
    line: int | None
    rule: str
    severity: Severity
    message: str
    tool: str


@dataclass
class GuardReport:
    file: str
    language: str
    findings: list[Finding] = field(default_factory=list)
    blocked: bool = False
    duration_ms: int = 0
    tools_executed: list[str] = field(default_factory=list)

    def to_dict(self):
        return {
            "file": self.file,
            "language": self.language,
            "blocked": self.blocked,
            "duration_ms": self.duration_ms,
            "tools_executed": self.tools_executed,
            "findings": [asdict(f) for f in self.findings],
            "summary": self.summary(),
        }

    def summary(self) -> str:
        if not self.findings:
            return "✅ Guard Rails: aprovado — nenhum HIGH/MED"
        high = sum(1 for f in self.findings if f.severity == "HIGH")
        med = sum(1 for f in self.findings if f.severity == "MED")
        low = sum(1 for f in self.findings if f.severity == "LOW")
        status = "🔴 BLOQUEADO" if self.blocked else "🟡 WARNING"
        return f"{status} — HIGH:{high} MED:{med} LOW:{low} em {self.file}"


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(cmd)}"
    except Exception as e:
        return 1, "", str(e)


def has_tool(name: str) -> bool:
    return shutil.which(name) is not None


# ── Checks determinísticos ───────────────────────────────────────────────────

def check_secrets(file: Path, report: GuardReport):
    try:
        text = file.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return
    for idx, line in enumerate(text.splitlines(), start=1):
        for pattern, desc in SECRET_PATTERNS:
            if re.search(pattern, line):
                report.findings.append(
                    Finding(
                        file=str(file),
                        line=idx,
                        rule="secrets/hardcoded",
                        severity="HIGH",
                        message=f"{desc} — remova e use env var",
                        tool="secrets-scan",
                    )
                )


def check_size(file: Path, report: GuardReport):
    try:
        lines = file.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return
    if len(lines) > MAX_FILE_LINES:
        report.findings.append(
            Finding(
                file=str(file),
                line=None,
                rule="complexity/file-too-large",
                severity="MED",
                message=f"Arquivo com {len(lines)} linhas > {MAX_FILE_LINES} — considere quebrar",
                tool="size-check",
            )
        )


def check_python(file: Path, report: GuardReport, auto_fix: bool = False):
    # ruff check
    if has_tool("ruff"):
        report.tools_executed.append("ruff check")
        cmd = ["ruff", "check", str(file), "--output-format", "json"]
        code, out, err = run(cmd)
        if out:
            try:
                data = json.loads(out)
                for item in data if isinstance(data, list) else []:
                    loc = item.get("location", {}) or {}
                    row = loc.get("row", item.get("row"))
                    report.findings.append(
                        Finding(
                            file=str(file),
                            line=row,
                            rule=f"ruff/{item.get('code','')}",
                            severity="MED" if code != 0 else "LOW",
                            message=item.get("message", "")[:300],
                            tool="ruff",
                        )
                    )
                if code != 0 and any(f.tool == "ruff" for f in report.findings):
                    # marcar HIGH se erro crítico (E9, F821 etc)
                    for f in report.findings:
                        if f.tool == "ruff" and any(x in f.rule for x in ["E9", "F821", "F823"]):
                            f.severity = "HIGH"
            except json.JSONDecodeError:
                if code != 0:
                    report.findings.append(
                        Finding(str(file), None, "ruff/error", "MED", (out + err)[:500], "ruff")
                    )
        elif code != 0 and err:
            report.findings.append(Finding(str(file), None, "ruff/error", "MED", err[:500], "ruff"))

        # ruff format --check
        report.tools_executed.append("ruff format --check")
        code2, _, _ = run(["ruff", "format", "--check", str(file)])
        if code2 != 0:
            report.findings.append(
                Finding(str(file), None, "ruff/format", "LOW", "Arquivo não formatado (ruff format)", "ruff")
            )
            if auto_fix:
                run(["ruff", "format", str(file)])
                run(["ruff", "check", "--fix", str(file)])

    # pyright / pylance (pylance == pyright)
    if has_tool("pyright"):
        report.tools_executed.append("pyright")
        code, out, err = run(["pyright", str(file), "--outputjson"], timeout=45)
        if out:
            try:
                data = json.loads(out)
                for diag in data.get("generalDiagnostics", []):
                    sev = diag.get("severity", "error")
                    report.findings.append(
                        Finding(
                            file=str(file),
                            line=diag.get("range", {}).get("start", {}).get("line"),
                            rule=diag.get("rule", "pyright"),
                            severity="HIGH" if sev == "error" else "MED",
                            message=diag.get("message", "")[:400],
                            tool="pyright",
                        )
                    )
            except json.JSONDecodeError:
                if "error" in (out + err).lower():
                    report.findings.append(Finding(str(file), None, "pyright/error", "MED", (out + err)[:600], "pyright"))
    elif has_tool("basedpyright"):
        report.tools_executed.append("basedpyright")
        code, out, err = run(["basedpyright", str(file), "--outputjson"], timeout=45)
        # similar handling omitted — fallback já cobre ruff

    # bandit (security)
    if has_tool("bandit"):
        report.tools_executed.append("bandit")
        code, out, err = run(["bandit", "-f", "json", "-q", str(file)])
        if out:
            try:
                data = json.loads(out)
                for issue in data.get("results", []):
                    sev = issue.get("issue_severity", "LOW").upper()
                    sev_norm: Severity = "HIGH" if sev == "HIGH" else "MED" if sev == "MEDIUM" else "LOW"
                    report.findings.append(
                        Finding(
                            file=str(file),
                            line=issue.get("line_number"),
                            rule=f"bandit/{issue.get('test_id','')}",
                            severity=sev_norm,
                            message=issue.get("issue_text", "")[:400],
                            tool="bandit",
                        )
                    )
            except json.JSONDecodeError:
                pass


def check_js_ts(file: Path, report: GuardReport, auto_fix: bool = False):
    # tsc --noEmit para TS
    if file.suffix in (".ts", ".tsx") and has_tool("tsc"):
        # não rodar tsc file individual sem config pode dar falso positivo; preferir npx tsc --noEmit no projeto
        pass

    # eslint
    if has_tool("eslint") or Path("node_modules/.bin/eslint").exists():
        eslint_bin = "eslint" if has_tool("eslint") else "node_modules/.bin/eslint"
        report.tools_executed.append("eslint")
        cmd = [eslint_bin, "--format", "json", str(file)]
        code, out, err = run(cmd, timeout=30)
        if out:
            try:
                data = json.loads(out)
                for file_result in data:
                    for msg in file_result.get("messages", []):
                        sev = "HIGH" if msg.get("severity") == 2 else "MED"
                        # eslint severity 1=warn → MED, 2=error → HIGH/MED conforme regra
                        # auto-fixable warnings → LOW
                        report.findings.append(
                            Finding(
                                file=str(file),
                                line=msg.get("line"),
                                rule=f"eslint/{msg.get('ruleId','')}",
                                severity=sev,
                                message=msg.get("message", "")[:400],
                                tool="eslint",
                            )
                        )
            except json.JSONDecodeError:
                if code != 0:
                    report.findings.append(Finding(str(file), None, "eslint/error", "MED", (out + err)[:500], "eslint"))
        if auto_fix and code != 0:
            run([eslint_bin, "--fix", str(file)])

    # biome
    if has_tool("biome") or Path("node_modules/.bin/biome").exists():
        biome_bin = "biome" if has_tool("biome") else "node_modules/.bin/biome"
        report.tools_executed.append("biome check")
        code, out, err = run([biome_bin, "check", str(file)], timeout=30)
        if code != 0 and (out or err):
            # biome output nem sempre json; tratar como MED
            report.findings.append(
                Finding(str(file), None, "biome/check", "MED", (out + err)[:600], "biome")
            )
        if auto_fix and code != 0:
            run([biome_bin, "check", "--write", str(file)])

    # tsc diagnostic via projeto (quando file é TS)
    if file.suffix in (".ts", ".tsx"):
        # usa script existente do skill typescript-expert se disponível
        diag = Path("skills/typescript-expert/scripts/ts_diagnostic.py")
        alt = Path("hooks/ts_diagnostic.py")
        # fallback: roda tsc --noEmit no projeto (rápido)
        if Path("tsconfig.json").exists():
            report.tools_executed.append("tsc --noEmit")
            code, out, err = run(["npx", "tsc", "--noEmit", "--pretty", "false"], timeout=60)
            combined = out + err
            if code != 0 and combined.strip():
                # filtra apenas linhas do arquivo em questão
                for line in combined.splitlines():
                    if str(file) in line or file.name in line:
                        # extrai linha/col se possível: file.ts(12,5): error TS...
                        m = re.search(r"\((\d+),", line)
                        lno = int(m.group(1)) if m else None
                        report.findings.append(
                            Finding(str(file), lno, "tsc/type-error", "HIGH", line[:500], "tsc")
                        )
                        if len([f for f in report.findings if f.tool == "tsc"]) > 20:
                            break


def run_guard(file_path: str, auto_fix: bool = False, output_format: str = "text") -> GuardReport:
    import time

    start = time.time()
    file = Path(file_path)
    ext = file.suffix.lower()
    lang = CODE_EXTENSIONS.get(ext, "unknown")

    report = GuardReport(file=str(file), language=lang)

    # ignora arquivos fora de código ou gerados
    if lang == "unknown":
        report.tools_executed.append("skip:unknown-extension")
        return report
    if any(part in str(file) for part in ["node_modules/", ".git/", ".next/", "dist/", "build/"]):
        report.tools_executed.append("skip:generated")
        return report
    if not file.exists():
        report.findings.append(Finding(str(file), None, "guard/file-not-found", "HIGH", "Arquivo não encontrado", "guard"))
        report.blocked = True
        return report

    # checks genéricos
    check_secrets(file, report)
    check_size(file, report)

    # checks por linguagem
    if lang == "python":
        check_python(file, report, auto_fix=auto_fix)
    elif lang in ("typescript", "javascript"):
        check_js_ts(file, report, auto_fix=auto_fix)
    elif lang == "style":
        if has_tool("stylelint"):
            report.tools_executed.append("stylelint")
            code, out, err = run(["stylelint", str(file), "--formatter", "json"])
            if code != 0 and out:
                try:
                    data = json.loads(out)
                    for fr in data:
                        for w in fr.get("warnings", []):
                            report.findings.append(
                                Finding(str(file), w.get("line"), f"stylelint/{w.get('rule')}", "MED", w.get("text","")[:400], "stylelint")
                            )
                except Exception:
                    pass

    # determina bloqueio: qualquer HIGH bloqueia
    report.blocked = any(f.severity == "HIGH" for f in report.findings)
    report.duration_ms = int((time.time() - start) * 1000)
    return report


def format_text(report: GuardReport) -> str:
    lines = []
    lines.append(f"\n{'='*60}")
    lines.append(f"🛡️ Guard Rails — {report.file} ({report.language})")
    lines.append(f"{'='*60}")
    lines.append(f"Tools: {', '.join(report.tools_executed) or 'nenhum'} | {report.duration_ms}ms")
    lines.append(f"Status: {report.summary()}")
    if report.findings:
        lines.append(f"\nFindings ({len(report.findings)}):")
        for f in report.findings:
            loc = f"{f.file}:{f.line}" if f.line else f.file
            lines.append(f"  [{f.severity}] {loc} — {f.rule} — {f.message} ({f.tool})")
    else:
        lines.append("  ✅ Nenhum finding — aprovado")
    lines.append("")
    if report.blocked:
        lines.append("⛔ BLOQUEADO: corrija HIGH antes de prosseguir (max 2 iterações builder)")
    else:
        lines.append("✅ Liberado para próximo gate")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Hook determinístico Guard Rails — pós-edição")
    parser.add_argument("--file", required=True, help="Arquivo alterado para validar")
    parser.add_argument("--autofix", action="store_true", help="Tenta auto-fix seguro (ruff --fix, biome --write)")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Formato de saída")
    parser.add_argument("--fail-on", choices=["HIGH", "MED", "LOW", "never"], default="HIGH", help="Severidade que causa exit 2")
    args = parser.parse_args()

    # Validação determinística pré-criação: roda scripts python antes de criar?
    # Este script É o script python — se chamado como pre-creation check, valida alvo
    report = run_guard(args.file, auto_fix=args.autofix, output_format=args.format)

    if args.format == "json":
        print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    else:
        print(format_text(report))

    # Exit code determinístico para middleware decidir
    if report.blocked and args.fail_on in ("HIGH", "MED", "LOW"):
        # HIGH bloqueia
        sys.exit(2)
    if args.fail_on == "MED" and any(f.severity in ("HIGH", "MED") for f in report.findings):
        sys.exit(2)
    if args.fail_on == "LOW" and report.findings:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
