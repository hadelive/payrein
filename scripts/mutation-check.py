#!/usr/bin/env python3
"""Shows each security test can fail: removes one vault check at a time, rebuilds, runs the tests
that cover it, and expects them to fail (docs/acceptance.md, "Done for the suite").

A mutant counts as caught only when a test matching its filter runs and fails (a compile error or
a sandbox that never started is reported as an error, not a catch), and only after the same tests
pass on the unmutated contract. The contract source is restored from memory whatever happens.
"""

import re

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ROOT / "contracts/policy-vault/src/lib.rs"

# (name, exact text to replace, replacement, unit-test filters, sandbox-test filters)
MUTATIONS = [
    (
        "allowlist removed",
        "if !self.merchants.iter().any(|m| m.account_id == req.merchant_id) {",
        "if false {",
        ["t01"],
        ["t01_t02"],
    ),
    (
        "daily limit removed",
        "Some(total) if total <= p.daily_max.0 => {}",
        "Some(_) => {}",
        ["t04", "t12_"],
        ["t04", "t12_"],
    ),
    (
        "reservations not counted",
        ".filter(|r| r.status == OpStatus::Dispatched && r.day.map(|d| d.0) == Some(day))",
        ".filter(|_| false)",
        ["t05_t06"],
        ["t05_t06"],
    ),
    (
        "approval not bound to fields",
        "if stored.op != op {",
        "if stored.op.op_id != op.op_id {",
        ["t09"],
        ["t09"],
    ),
    (
        # The record leaving `active` is what makes a late callback a no-op. (Dropping the
        # status guard alone is an equivalent mutant: only dispatched ops ever get a callback.)
        "finished op stays active",
        "let mut rec = self.active.remove(i);",
        "let mut rec = self.active[i].clone();",
        ["t17a"],
        [],
    ),
]


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


BROKEN = ("could not compile", "error[E", "error: could not", "Failed to start sandbox")


def outcome(package, filt, extra=()):
    """'pass', 'fail' (a test matching `filt` ran and failed) or 'error: ...' (nothing ran)."""
    r = run(["cargo", "test", "-p", package, *extra, filt])
    out = r.stdout + r.stderr
    if any(b in out for b in BROKEN):
        return "error: build or setup failed"
    failed = re.findall(r"^test (\S*" + re.escape(filt) + r"\S*) \.\.\. FAILED$", out, re.M)
    ran = re.findall(r"^test (\S*" + re.escape(filt) + r"\S*) \.\.\. (?:ok|FAILED)$", out, re.M)
    if not ran:
        return f"error: no test matching {filt} ran"
    if r.returncode == 0:
        return "pass"
    return "fail" if failed else "error: failed without a failing test"


def tests_fail(package, filters, extra=()):
    for f in filters:
        o = outcome(package, f, extra)
        if o != "fail":
            return False, f"{f}: {o}"
    return True, None


def baseline(unit, sandbox):
    for f in unit:
        if outcome("policy-vault", f) != "pass":
            return f"unit {f} does not pass on the unmutated contract"
    for f in sandbox:
        if outcome("security-tests", f, ["--test", "security"]) != "pass":
            return f"sandbox {f} does not pass on the unmutated contract"
    return None


def main():
    only = sys.argv[1:]  # optional: names of mutations to run
    original = LIB.read_text()
    failures = []
    try:
        for name, old, new, unit, sandbox in MUTATIONS:
            if only and name not in only:
                continue
            if original.count(old) != 1:
                failures.append(f"{name}: anchor not found exactly once")
                continue
            LIB.write_text(original)
            run(["make", "build"])
            broken = baseline(unit, sandbox)
            if broken:
                failures.append(f"{name}: {broken}")
                continue
            LIB.write_text(original.replace(old, new))
            caught, survivor = tests_fail("policy-vault", unit)
            if caught and sandbox:
                if run(["make", "build"]).returncode != 0:
                    failures.append(f"{name}: mutant did not build")
                    continue
                caught, survivor = tests_fail("security-tests", sandbox, ["--test", "security"])
            status = "caught" if caught else f"NOT CAUGHT ({survivor})"
            print(f"{name}: {status}", flush=True)
            if not caught:
                failures.append(name)
    finally:
        LIB.write_text(original)
        run(["make", "build"])
    if failures:
        sys.exit("mutants not caught: " + ", ".join(failures))
    print("all mutants caught")


if __name__ == "__main__":
    main()
